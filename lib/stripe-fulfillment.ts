// ---------------------------------------------------------------------------
// Stripe fulfillment — the single place a paid Checkout Session turns into
// state in our database.
//
// Two callers share this module and MUST stay in lockstep:
//   1. app/api/stripe/webhook       — Stripe's authoritative delivery.
//   2. app/dashboard/**             — reconciliation when the student lands
//                                     back on the site from Checkout.
//
// (2) exists because a webhook is asynchronous: the browser is usually back
// on our pages before Stripe's POST arrives, and a student who just paid
// must never be shown "pay now" again. Both paths run the same function, so
// whichever wins the race produces identical state and the loser is a no-op.
//
// Everything here is idempotent. Rows are updated with guards on their
// current status, and one-shot side effects (emails, notifications, the
// Discord trumpet) only fire on the actual transition into paid — a Stripe
// retry, a page refresh, or both racing will not double-send.
// ---------------------------------------------------------------------------

import type Stripe from "stripe";
import { stripe } from "@/lib/stripe";
import { createAdminClient } from "@/lib/supabase/admin";
import { sendEmail } from "@/lib/email/send";
import { Templates } from "@/lib/email/templates";
import { sendTemplated, emitEmailEvent } from "@/lib/email/dispatch";
import { notify } from "@/lib/notifications";
import { logAudit } from "@/lib/audit";
import {
  getDiscordSettings,
  postChannelMessage,
  postDiscordWebhook,
  syncMemberRoles,
} from "@/lib/discord";
import { cohortHasStarted, fmtDateOnly, todayISO } from "@/lib/pre-cohort";

/**
 * What a Checkout Session means for the student, right now.
 *  - paid       money captured; everything it buys is unlocked.
 *  - processing authorized but not yet captured (bank debits, some wallets),
 *               or Stripe simply hasn't told us yet. Nothing is unlocked.
 *  - failed     the payment was declined or the async debit bounced.
 *  - expired    the session timed out unpaid (Stripe expires after ~24h).
 *  - unknown    we couldn't resolve the session at all.
 */
export type PaymentState =
  | "paid"
  | "processing"
  | "failed"
  | "expired"
  | "unknown";

export type FulfillmentKind = "enrollment" | "user_charge" | "unknown";

export type FulfillmentResult = {
  kind: FulfillmentKind;
  state: PaymentState;
  /** Stripe-hosted receipt page, once the payment succeeded. */
  receiptUrl: string | null;
  /** What Stripe actually charged, in cents. */
  amountCents: number | null;
  /** Human-readable line item ("Fine: late check-in", a cohort name). */
  description: string | null;
  /**
   * Why the ledger row couldn't be written, when it couldn't. Normally
   * null. A payment whose student or application has since been deleted
   * can't satisfy the foreign keys on `payments` — that's legitimate, but
   * it must be reported rather than swallowed, or the admin Payments page
   * silently omits real money.
   */
  ledgerError?: string | null;
};

const UNKNOWN: FulfillmentResult = {
  kind: "unknown",
  state: "unknown",
  receiptUrl: null,
  amountCents: null,
  description: null,
};

function paymentIntentIdOf(
  session: Stripe.Checkout.Session,
): string | null {
  const pi = session.payment_intent;
  if (!pi) return null;
  return typeof pi === "string" ? pi : pi.id;
}

/**
 * Read a session's payment state. `no_payment_required` covers a 100%
 * discount (a $0 total still enrolls the student).
 */
function sessionState(session: Stripe.Checkout.Session): PaymentState {
  if (session.payment_status === "paid") return "paid";
  if (session.payment_status === "no_payment_required") return "paid";
  if (session.status === "expired") return "expired";
  // `complete` + unpaid means a delayed payment method is still clearing.
  return "processing";
}

/**
 * Resolve a Stripe-hosted receipt URL for a payment intent. The URL lives
 * on the underlying Charge, so expand `latest_charge`. Never throws — a
 * missing receipt must not fail fulfillment, and the UI renders "—".
 */
export async function fetchReceiptUrl(
  paymentIntentId: string | null,
): Promise<string | null> {
  if (!paymentIntentId) return null;
  try {
    const pi = await stripe.paymentIntents.retrieve(paymentIntentId, {
      expand: ["latest_charge"],
    });
    const latest = pi.latest_charge;
    if (!latest || typeof latest === "string") return null;
    return latest.receipt_url ?? null;
  } catch (err) {
    console.error("[stripe] receipt url fetch failed", err);
    return null;
  }
}

export type FulfillOptions = {
  /**
   * Override the state read off the session. The webhook needs this:
   * `checkout.session.async_payment_failed` carries a session that on its
   * own still looks merely "processing".
   */
  forceState?: PaymentState;
  /**
   * Skip the one-shot announcements (receipt email, in-app notification,
   * Discord trumpet). Set when backfilling historical transactions — a
   * student shouldn't get a "welcome aboard" email for a payment they
   * made months ago. The database is still brought fully up to date.
   */
  silent?: boolean;
};

/**
 * Apply a Checkout Session to our database. Safe to call repeatedly and
 * from the webhook, a page render, or the reconciler.
 */
export async function fulfillCheckoutSession(
  session: Stripe.Checkout.Session,
  opts: FulfillOptions = {},
): Promise<FulfillmentResult> {
  const state = opts.forceState ?? sessionState(session);
  if (session.metadata?.kind === "user_charge") {
    return fulfillUserCharge(session, state, opts);
  }
  if (session.metadata?.application_id) {
    return fulfillEnrollment(session, state, opts);
  }
  return { ...UNKNOWN, state, amountCents: session.amount_total ?? null };
}

/**
 * Fetch a session straight from Stripe and fulfill it. Used on return from
 * Checkout, where the session id arrives in a URL the user controls — so
 * the session's own metadata has to name them before we touch anything.
 */
export async function syncCheckoutSession(
  sessionId: string,
  expectedUserId: string,
): Promise<FulfillmentResult> {
  if (!/^cs_[A-Za-z0-9_]+$/.test(sessionId)) return UNKNOWN;
  try {
    const session = await stripe.checkout.sessions.retrieve(sessionId);
    if (session.metadata?.user_id !== expectedUserId) {
      // Someone else's session id (or one of ours with no owner stamped).
      // Report nothing rather than leaking another student's payment.
      return UNKNOWN;
    }
    return await fulfillCheckoutSession(session);
  } catch (err) {
    console.error("[stripe] session sync failed", sessionId, err);
    return UNKNOWN;
  }
}

// ---------------------------------------------------------------------------
// Enrollment (tuition)
// ---------------------------------------------------------------------------

async function fulfillEnrollment(
  session: Stripe.Checkout.Session,
  state: PaymentState,
  opts: FulfillOptions = {},
): Promise<FulfillmentResult> {
  const admin = createAdminClient();
  const applicationId = session.metadata!.application_id!;
  const userId = session.metadata?.user_id ?? null;
  const cohortId = session.metadata?.cohort_id || null;
  const amountCents = session.amount_total ?? null;
  const paymentIntentId = paymentIntentIdOf(session);
  if (!userId) return { ...UNKNOWN, state, amountCents };

  const cohortName = cohortId ? await lookupCohortName(cohortId) : null;
  const base: FulfillmentResult = {
    kind: "enrollment",
    state,
    receiptUrl: null,
    amountCents,
    description: cohortName ? `Tuition — ${cohortName}` : "Tuition",
  };

  if (state !== "paid") {
    // A dead checkout must not leave a "pending" row sitting in the
    // student's billing history forever. Only ever close out a row that
    // is still pending — a later, successful attempt keeps its status.
    if (state === "expired" || state === "failed") {
      await admin
        .from("payments")
        .update({ status: "failed" })
        .eq("stripe_session_id", session.id)
        .eq("status", "pending");
    }
    return base;
  }

  // Read before writing: the transition into paid is what gates the
  // one-shot side effects below.
  const { data: app } = await admin
    .from("applications")
    .select("status, paid_at")
    .eq("id", applicationId)
    .maybeSingle();
  const alreadyFulfilled =
    app?.status === "paid" || app?.status === "enrolled";

  // A refunded payment must never be resurrected by a replay. The refund
  // handler rolled the application back to "accepted" and dropped the
  // enrollment deliberately; re-running this session (webhook redelivery,
  // reconciliation) would otherwise hand the seat back for free.
  const { data: ledger } = await admin
    .from("payments")
    .select("id, status")
    .eq("stripe_session_id", session.id)
    .maybeSingle();
  if (ledger?.status === "refunded") return base;

  const receiptUrl = await fetchReceiptUrl(paymentIntentId);

  if (app?.status !== "enrolled") {
    await admin
      .from("applications")
      .update({
        status: "paid",
        paid_at: app?.paid_at ?? new Date().toISOString(),
        stripe_payment_intent_id: paymentIntentId,
      })
      .eq("id", applicationId);
  }

  const ledgerError = await recordEnrollmentPayment(admin, {
    existingId: ledger?.id ?? null,
    sessionId: session.id,
    userId,
    applicationId,
    cohortId,
    amountCents: amountCents ?? 0,
    currency: session.currency ?? "usd",
    paymentIntentId,
    receiptUrl,
  });

  if (cohortId) {
    await admin.from("enrollments").upsert(
      {
        user_id: userId,
        cohort_id: cohortId,
        application_id: applicationId,
      },
      { onConflict: "user_id,cohort_id" },
    );
    await admin
      .from("applications")
      .update({ status: "enrolled" })
      .eq("id", applicationId);
  }

  if (!alreadyFulfilled) {
    if (!opts.silent) {
      await announceEnrollment({
        userId,
        cohortId,
        cohortName: cohortName ?? "batch0",
        amountCents: amountCents ?? 0,
      });
    }
    await logAudit({
      action: "payment.succeeded",
      targetType: "application",
      targetId: applicationId,
      payload: {
        amount_cents: amountCents,
        stripe_session_id: session.id,
        stripe_payment_intent_id: paymentIntentId,
      },
    });
  }

  return { ...base, receiptUrl, ledgerError };
}

/**
 * Move the ledger row for this checkout to succeeded. The row is normally
 * created when the session is created; insert one if it's missing so the
 * student's billing history is complete even when that write was lost.
 *
 * Returns null on success, or a reason string. The caller surfaces it —
 * an insert that fails here means real money is missing from the admin
 * Payments page, which is not something to discover by accident.
 */
async function recordEnrollmentPayment(
  admin: ReturnType<typeof createAdminClient>,
  row: {
    /** The ledger row for this session, if one already exists. */
    existingId: string | null;
    sessionId: string;
    userId: string;
    applicationId: string;
    cohortId: string | null;
    amountCents: number;
    currency: string;
    paymentIntentId: string | null;
    receiptUrl: string | null;
  },
): Promise<string | null> {
  if (row.existingId) {
    const { error } = await admin
      .from("payments")
      .update({
        status: "succeeded",
        stripe_payment_intent_id: row.paymentIntentId,
        stripe_receipt_url: row.receiptUrl,
      })
      .eq("id", row.existingId);
    if (error) {
      console.error("[stripe] ledger update failed", row.sessionId, error);
      return `ledger update failed: ${error.message}`;
    }
    return null;
  }

  const { error } = await admin.from("payments").insert({
    user_id: row.userId,
    application_id: row.applicationId,
    cohort_id: row.cohortId,
    stripe_session_id: row.sessionId,
    stripe_payment_intent_id: row.paymentIntentId,
    stripe_receipt_url: row.receiptUrl,
    amount_cents: row.amountCents,
    currency: row.currency,
    status: "succeeded",
  });
  if (!error) return null;

  // 23503 = foreign key violation. The student's profile or their
  // application was deleted after they paid, so there is nowhere valid to
  // hang the row. Retry without the application reference (it's nullable)
  // before giving up — losing the link is better than losing the money.
  if ((error as any).code === "23503" && row.applicationId) {
    const { error: retryErr } = await admin.from("payments").insert({
      user_id: row.userId,
      application_id: null,
      cohort_id: row.cohortId,
      stripe_session_id: row.sessionId,
      stripe_payment_intent_id: row.paymentIntentId,
      stripe_receipt_url: row.receiptUrl,
      amount_cents: row.amountCents,
      currency: row.currency,
      status: "succeeded",
    });
    if (!retryErr) return null;
  }

  console.error("[stripe] ledger insert failed", row.sessionId, error);
  return `no ledger row for ${row.sessionId}: ${error.message}`;
}

async function lookupCohortName(cohortId: string): Promise<string | null> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("cohorts")
    .select("name")
    .eq("id", cohortId)
    .maybeSingle();
  return data?.name ?? null;
}

/**
 * Receipt email + in-app notification + Discord role sync, fired once when
 * a student first becomes enrolled. Every step is best-effort: a flaky
 * mailer must not make Stripe retry a payment we've already banked.
 */
async function announceEnrollment(args: {
  userId: string;
  cohortId: string | null;
  cohortName: string;
  amountCents: number;
}) {
  try {
    const admin = createAdminClient();
    const { data: profile } = await admin
      .from("profiles")
      .select("email, full_name, role")
      .eq("id", args.userId)
      .maybeSingle();

    // Discord linkage is optional — if migration 0008 isn't applied this
    // query throws "column does not exist" and we just skip.
    let discordUserId: string | null = null;
    try {
      const { data: d, error: dErr } = await admin
        .from("profiles")
        .select("discord_user_id")
        .eq("id", args.userId)
        .maybeSingle();
      if (!dErr && d) discordUserId = (d as any).discord_user_id ?? null;
    } catch {
      // ignore — column doesn't exist
    }
    if (discordUserId) {
      await syncMemberRoles(
        discordUserId,
        (profile?.role as any) ?? "student",
      ).catch(() => {});
    }

    // Where the money actually takes them depends on the calendar: before
    // kickoff the course is still locked, so point at the kickoff page
    // rather than a route the middleware would bounce.
    const cohort = args.cohortId
      ? await lookupCohortStart(args.cohortId)
      : null;
    const started = cohort ? cohortHasStarted(cohort, todayISO()) : true;

    const startsOn = started ? null : (cohort?.starts_on ?? null);
    if (profile?.email) {
      await sendTemplated("payment.receipt", {
        to: profile.email,
        toName: profile?.full_name ?? null,
        userId: args.userId,
        vars: {
          amount: `$${(args.amountCents / 100).toFixed(2)}`,
          cohort_name: args.cohortName,
          starts_on: startsOn ? (fmtDateOnly(startsOn) ?? "") : "",
        },
        // One receipt per enrollment, however the fulfilment arrived —
        // webhook, retry, or reconciliation on return from checkout.
        dedupeKey: `receipt:${args.userId}:${args.cohortId ?? "no-cohort"}`,
        fallback: () =>
          Templates.paymentReceipt({
            name: profile?.full_name ?? null,
            amountCents: args.amountCents,
            cohortName: args.cohortName,
            startsOn,
          }),
      });
      // Awaited rather than fired-and-forgotten: a serverless invocation can
      // be frozen the moment its response is returned, and a floating promise
      // here would drop the enqueue silently. emitEmailEvent swallows its own
      // failures, so awaiting it can't fail the operation it reports on.
      await emitEmailEvent("payment.succeeded", {
        email: profile.email,
        name: profile?.full_name ?? null,
        userId: args.userId,
        vars: {
          amount: `$${(args.amountCents / 100).toFixed(2)}`,
          cohort_name: args.cohortName,
          starts_on: startsOn ? (fmtDateOnly(startsOn) ?? "") : "",
        },
        dedupeSeed: `payment.succeeded:${args.userId}:${args.cohortId ?? "no-cohort"}`,
      });
    }
    await notify({
      userId: args.userId,
      type: "enrolled",
      title: "You're enrolled",
      body: started
        ? `Welcome to ${args.cohortName}. Course access is unlocked.`
        : `Welcome to ${args.cohortName}. Kickoff details, Discord, your team page, and the pre-cohort resources are open now.`,
      link: started ? "/dashboard/course" : "/dashboard/kickoff",
      // One enrollment notification per student per cohort, whatever the
      // delivery path — webhook, retry, or reconciliation on return.
      dedupeKey: `enrolled:${args.cohortId ?? "no-cohort"}`,
    });
    // Trumpet the enrollment. Prefer the bot posting into the configured
    // announcements channel and only fall back to the legacy webhook —
    // DISCORD_ANNOUNCEMENTS_WEBHOOK is unset in production, so the
    // webhook-only version of this made every enrollment silently
    // vanish. Mirrors the fallback order in
    // app/admin/announcements/actions.ts.
    const content = `🎉 **New enrollment** — ${profile?.full_name ?? "A new student"} just enrolled in **${args.cohortName}**!`;
    const settings = await getDiscordSettings();
    const posted = settings.announcementsChannelId
      ? await postChannelMessage(settings.announcementsChannelId, { content })
      : await postDiscordWebhook({ content });
    if (!posted) {
      console.error(
        "[stripe] enrollment trumpet not delivered to Discord",
        JSON.stringify({
          userId: args.userId,
          cohortId: args.cohortId,
          announcementsChannelId: settings.announcementsChannelId || null,
        }),
      );
    }
  } catch (err) {
    console.error("[stripe] enrollment announce failed", err);
  }
}

async function lookupCohortStart(
  cohortId: string,
): Promise<{ starts_on: string | null; status: string | null } | null> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("cohorts")
    .select("starts_on, status")
    .eq("id", cohortId)
    .maybeSingle();
  return data ?? null;
}

// ---------------------------------------------------------------------------
// Fees and fines (user_charges)
// ---------------------------------------------------------------------------

async function fulfillUserCharge(
  session: Stripe.Checkout.Session,
  state: PaymentState,
  opts: FulfillOptions = {},
): Promise<FulfillmentResult> {
  const admin = createAdminClient();
  const chargeId = session.metadata?.charge_id;
  const amountCents = session.amount_total ?? null;
  if (!chargeId) return { ...UNKNOWN, state, amountCents };

  const { data: charge } = await admin
    .from("user_charges")
    .select("id, user_id, kind, description, amount_cents, status")
    .eq("id", chargeId)
    .maybeSingle();
  if (!charge) return { ...UNKNOWN, state, amountCents };

  const label = `${charge.kind === "fine" ? "Fine" : "Fee"}: ${charge.description}`;
  const base: FulfillmentResult = {
    kind: "user_charge",
    state,
    receiptUrl: null,
    amountCents: amountCents ?? charge.amount_cents,
    description: label,
  };

  // A failed or expired checkout leaves the charge exactly as it was:
  // still pending, still payable. Nothing to write.
  if (state !== "paid") return base;

  const paymentIntentId = paymentIntentIdOf(session);
  const receiptUrl = await fetchReceiptUrl(paymentIntentId);
  const wasPending = charge.status === "pending";

  // Guard on `pending` so a redelivered event can never resurrect a charge
  // an admin has since waived, cancelled, or refunded.
  await admin
    .from("user_charges")
    .update({
      status: "paid",
      paid_at: new Date().toISOString(),
      stripe_payment_intent_id: paymentIntentId,
      stripe_receipt_url: receiptUrl,
    })
    .eq("id", chargeId)
    .eq("status", "pending");

  if (wasPending) {
    if (!opts.silent) {
      await notify({
        userId: charge.user_id,
        type: "charge_paid",
        title: `${charge.kind === "fine" ? "Fine paid: " : "Fee paid: "}${charge.description}`,
        body: `Amount: $${(charge.amount_cents / 100).toFixed(2)}`,
        link: "/dashboard/billing",
        dedupeKey: `charge_paid:${charge.id}`,
      });
    }
    await logAudit({
      action: "charge.paid",
      targetType: "user_charge",
      targetId: charge.id,
      payload: {
        amount_cents: charge.amount_cents,
        stripe_session_id: session.id,
        stripe_payment_intent_id: paymentIntentId,
      },
    });
  } else if (receiptUrl) {
    // Already settled — still worth backfilling the receipt link.
    await admin
      .from("user_charges")
      .update({ stripe_receipt_url: receiptUrl })
      .eq("id", chargeId)
      .is("stripe_receipt_url", null);
  }

  return { ...base, receiptUrl };
}

// ---------------------------------------------------------------------------
// Failure paths
// ---------------------------------------------------------------------------

/**
 * Mirror a Stripe refund back into our tables. The same payment intent can
 * back either an enrollment (payments) or a fee/fine (user_charges), so
 * both are checked — a refund issued straight from the Stripe dashboard
 * lands here either way.
 *
 * Only a FULL refund revokes what the money bought. Stripe flips
 * `charge.refunded` to true only once the whole amount is back, so a
 * partial refund is recorded and announced without tearing down the
 * student's enrollment. Idempotent: statuses are guarded and the
 * notifications carry a dedupe key.
 */
export async function handleChargeRefunded(
  charge: Stripe.Charge,
  opts: { silent?: boolean } = {},
) {
  const admin = createAdminClient();
  const piId =
    typeof charge.payment_intent === "string"
      ? charge.payment_intent
      : charge.payment_intent?.id ?? null;
  const full = charge.refunded === true;
  const refundId = charge.refunds?.data?.[0]?.id ?? null;
  // Did this call actually move anything? The reconciler replays known
  // refunds on every run; without this the audit log would grow a
  // duplicate row a day for each one.
  let changed = false;

  if (piId) {
    const { data: payment } = await admin
      .from("payments")
      .select("id, user_id, application_id, status")
      .eq("stripe_payment_intent_id", piId)
      .maybeSingle();

    if (payment) {
      const alreadyRefunded = payment.status === "refunded";
      if (full && !alreadyRefunded) {
        changed = true;
        await admin
          .from("payments")
          .update({ status: "refunded" })
          .eq("id", payment.id);
        if (payment.application_id) {
          // Roll the student back to "accepted": the seat is theirs to
          // buy again, but it isn't paid for.
          await admin
            .from("applications")
            .update({ status: "accepted", paid_at: null })
            .eq("id", payment.application_id);
          await admin
            .from("enrollments")
            .delete()
            .eq("application_id", payment.application_id);
        }
      }
      if (payment.user_id && !alreadyRefunded && !opts.silent) {
        await notify({
          userId: payment.user_id,
          type: "payment_refunded",
          title: full ? "Payment refunded" : "Partial refund issued",
          body: full
            ? "Your enrollment payment was refunded. Reach out if this was unexpected."
            : `$${(charge.amount_refunded / 100).toFixed(2)} was returned to your card.`,
          link: "/dashboard/billing",
          dedupeKey: `refund:${refundId ?? piId}`,
        });
      }
    }

    // Also reflect on any matching user_charges row.
    const { data: userCharge } = await admin
      .from("user_charges")
      .select("id, user_id, kind, description, amount_cents, status")
      .eq("stripe_payment_intent_id", piId)
      .maybeSingle();
    if (userCharge && userCharge.status !== "refunded") {
      if (full) {
        changed = true;
        await admin
          .from("user_charges")
          .update({
            status: "refunded",
            refunded_at: new Date().toISOString(),
            stripe_refund_id: refundId,
          })
          .eq("id", userCharge.id);
      }
      if (!opts.silent) {
        await notify({
          userId: userCharge.user_id,
          type: "charge_refunded",
          title: `${userCharge.kind === "fine" ? "Fine" : "Fee"} ${
            full ? "refunded" : "partially refunded"
          }: ${userCharge.description}`,
          body: `$${(charge.amount_refunded / 100).toFixed(2)} returned to your card.`,
          link: "/dashboard/billing",
          dedupeKey: `refund:${refundId ?? piId}`,
        });
      }
    }
  }

  if (changed || !opts.silent) {
    await logAudit({
      action: full ? "payment.refunded" : "payment.partially_refunded",
      targetType: "payment_intent",
      targetId: piId,
      payload: {
        amount_refunded: charge.amount_refunded,
        amount: charge.amount,
        stripe_refund_id: refundId,
      },
    });
  }
}

/**
 * A payment intent was declined. Close out the ledger row and tell the
 * student — a silent failure is how someone ends up thinking they paid.
 */
export async function handlePaymentFailed(pi: Stripe.PaymentIntent) {
  const admin = createAdminClient();
  const applicationId = pi.metadata?.application_id ?? null;
  const userId = pi.metadata?.user_id ?? null;
  const isCharge = pi.metadata?.kind === "user_charge";

  // The ledger row is created at session-create time and only learns its
  // payment intent id on success, so a declined attempt has to be matched
  // through the application it belongs to.
  if (applicationId) {
    await admin
      .from("payments")
      .update({ status: "failed", stripe_payment_intent_id: pi.id })
      .eq("application_id", applicationId)
      .eq("status", "pending");
  } else {
    await admin
      .from("payments")
      .update({ status: "failed" })
      .eq("stripe_payment_intent_id", pi.id)
      .eq("status", "pending");
  }

  if (!userId) return;
  const reason =
    pi.last_payment_error?.message ??
    "Your bank declined the payment. No money was taken.";
  await notify({
    userId,
    type: "payment_failed",
    title: isCharge ? "Payment failed" : "Enrollment payment failed",
    body: `${reason} You can try again any time.`,
    link: isCharge ? "/dashboard/billing" : "/dashboard/application",
    dedupeKey: `payment_failed:${pi.id}`,
  });
}
