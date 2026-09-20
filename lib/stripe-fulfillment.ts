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
import {
  findProfileByEmail,
  getDemoDayDetails,
  TICKET_CONFIRMED_TEMPLATE,
} from "@/lib/demo-day-tickets";
import { formatTicketAmount } from "@/lib/demo-day-ticket-input";
import type { DemoDayTicket } from "@/lib/types";

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

export type FulfillmentKind =
  | "enrollment"
  | "user_charge"
  | "demo_day_ticket"
  | "unknown";

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
  enrollmentBlocked?: boolean;
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
  /** Internal refund recovery owns the final cleanup and must not recurse. */
  skipRefundSync?: boolean;
  /** Verified Stripe success-event timestamp; never checkout creation time. */
  paidAt?: string | null;
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

async function currentCapture(session: Stripe.Checkout.Session, opts: FulfillOptions) {
  const paymentIntentId = paymentIntentIdOf(session);
  const intent = paymentIntentId ? await stripe.paymentIntents.retrieve(paymentIntentId, { expand: ["latest_charge"] }) : null;
  const charge = intent?.latest_charge
    ? typeof intent.latest_charge === "string" ? await stripe.charges.retrieve(intent.latest_charge) : intent.latest_charge
    : null;
  return {
    charge,
    amountCents: charge?.amount_captured ?? session.amount_total ?? 0,
    currency: charge?.currency ?? session.currency ?? "usd",
    receiptUrl: charge?.receipt_url ?? null,
    paidAt: opts.paidAt ?? (charge?.paid && charge.captured && charge.payment_method_details?.type === "card"
      ? new Date(charge.created * 1000).toISOString() : null),
  };
}

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
  if (session.metadata?.kind === "demo_day_ticket") {
    return fulfillDemoDayTicket(session, state, opts);
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

/**
 * The ticket-page twin of syncCheckoutSession. A Demo Day ticket is paid
 * without an account, so there is no signed-in user to check the session
 * against; the ticket itself — reached only through its secret token — is
 * the identity. The session must name that exact ticket before anything is
 * written, so a session id pasted onto someone else's ticket URL reports
 * nothing.
 */
export async function syncDemoDayTicketSession(
  sessionId: string,
  ticketId: string,
): Promise<FulfillmentResult> {
  if (!/^cs_[A-Za-z0-9_]+$/.test(sessionId)) return UNKNOWN;
  try {
    const session = await stripe.checkout.sessions.retrieve(sessionId);
    if (
      session.metadata?.kind !== "demo_day_ticket" ||
      session.metadata?.ticket_id !== ticketId
    ) {
      return UNKNOWN;
    }
    return await fulfillCheckoutSession(session);
  } catch (err) {
    console.error("[stripe] ticket session sync failed", sessionId, err);
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

  // Inspect the current charge before granting access: Stripe may deliver
  // a refund webhook before Checkout's completion event.
  const capture = await currentCapture(session, opts);
  const capturedCharge = capture.charge;
  const actualAmountCents = capture.amountCents;
  const receiptUrl = capture.receiptUrl;
  // Our card Checkout uses automatic capture. A successful card Charge's
  // creation time is usable on immediate return before webhook delivery.
  // Delayed payment methods require the actual success event timestamp.
  const paidAt = capture.paidAt;
  base.amountCents = actualAmountCents;
  const { data: settlement, error } = await admin.rpc("settle_enrollment_payment", {
    p_session_id: session.id,
    p_user_id: userId,
    p_application_id: applicationId,
    p_cohort_id: cohortId,
    p_amount_cents: actualAmountCents,
    p_currency: capture.currency,
    p_payment_intent_id: paymentIntentId,
    p_receipt_url: receiptUrl,
    p_paid_at: paidAt,
    p_reservation_id: session.metadata?.checkout_reservation_id || null,
    p_refunded_cents: capturedCharge?.amount_refunded ?? 0,
  });
  // A failed ledger/access transaction must be retried by Stripe. Never mark
  // the webhook completed after swallowing a Supabase write error.
  if (error) throw new Error(`Enrollment settlement failed: ${error.message}`);
  if (!opts.skipRefundSync && capturedCharge && capturedCharge.amount_refunded > 0) await handleChargeRefunded(capturedCharge, { silent: true });
  if (settlement?.blocked) {
    const { count } = await admin.from("audit_log").select("id", { count: "exact", head: true })
      .eq("action", "payment.enrollment_blocked").eq("target_id", applicationId);
    if (!count && !capturedCharge?.refunded) await logAudit({ action: "payment.enrollment_blocked", targetType: "application", targetId: applicationId,
      payload: { stripe_session_id: session.id, amount_cents: actualAmountCents, reason: "Paid checkout did not grant enrollment; review eligibility, capacity, and refund history." } });
    console.error("[stripe] captured enrollment requires staff review", session.id);
    return { ...base, receiptUrl, enrollmentBlocked: true };
  }
  if (settlement?.newly_enrolled) {
    if (!opts.silent) await announceEnrollment({ userId, cohortId,
      cohortName: cohortName ?? "batch0", amountCents: actualAmountCents });
    await logAudit({ action: "payment.succeeded", targetType: "application", targetId: applicationId,
      payload: { amount_cents: actualAmountCents, stripe_session_id: session.id, stripe_payment_intent_id: paymentIntentId } });
  }
  return { ...base, receiptUrl };
}

async function lookupCohortName(cohortId: string): Promise<string | null> {
  const { data } = await createAdminClient().from("cohorts").select("name").eq("id",cohortId).maybeSingle();
  return data?.name ?? null;
}

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

  const { data: charge, error: readError } = await admin
    .from("user_charges")
    .select("id, user_id, kind, description, amount_cents, status")
    .eq("id", chargeId)
    .maybeSingle();
  if (readError) throw new Error(readError.message);
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
  const capture = await currentCapture(session, opts);
  const receiptUrl = capture.receiptUrl;
  base.amountCents = capture.amountCents;
  const wasPending = charge.status === "pending";

  // Compare the status read above: only one concurrent completion may make
  // the pending-to-paid transition. Canceled/refunded rows never resurrect.
  const { data: settled, error: settlementError } = await admin
    .from("user_charges")
    .update({
      status: capture.charge?.refunded ? "refunded" : "paid",
      ...(capture.paidAt ? { paid_at: capture.paidAt } : {}),
      captured_amount_cents: capture.amountCents,
      captured_currency: capture.currency,
      stripe_payment_intent_id: paymentIntentId,
      stripe_receipt_url: receiptUrl,
    })
    .eq("id", chargeId)
    .eq("status", charge.status)
    .in("status", ["pending", "paid"]).select("id");
  if (settlementError) throw new Error(settlementError.message);
  if (!opts.skipRefundSync && capture.charge && capture.charge.amount_refunded > 0) await handleChargeRefunded(capture.charge, { silent: true });

  if (wasPending && settled?.length && !capture.charge?.refunded) {
    if (!opts.silent) {
      await notify({
        userId: charge.user_id,
        type: "charge_paid",
        title: `${charge.kind === "fine" ? "Fine paid: " : "Fee paid: "}${charge.description}`,
        body: `Amount: ${(capture.amountCents / 100).toFixed(2)} ${capture.currency.toUpperCase()}`,
        link: "/dashboard/billing",
        dedupeKey: `charge_paid:${charge.id}`,
      });
    }
    await logAudit({
      action: "charge.paid",
      targetType: "user_charge",
      targetId: charge.id,
      payload: {
        amount_cents: capture.amountCents,
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
// Demo Day tickets (demo_day_tickets)
// ---------------------------------------------------------------------------

async function fulfillDemoDayTicket(
  session: Stripe.Checkout.Session,
  state: PaymentState,
  opts: FulfillOptions = {},
): Promise<FulfillmentResult> {
  const admin = createAdminClient();
  const ticketId = session.metadata?.ticket_id;
  const amountCents = session.amount_total ?? null;
  if (!ticketId) return { ...UNKNOWN, state, amountCents };

  const { data, error: readError } = await admin
    .from("demo_day_tickets")
    .select("*")
    .eq("id", ticketId)
    .maybeSingle();
  if (readError) throw new Error(readError.message);
  const ticket = data as DemoDayTicket | null;
  if (!ticket) return { ...UNKNOWN, state, amountCents };

  const base: FulfillmentResult = {
    kind: "demo_day_ticket",
    state,
    receiptUrl: ticket.stripe_receipt_url,
    amountCents: amountCents ?? ticket.amount_cents,
    description: "Demo Day ticket",
  };

  // A failed or expired checkout leaves the ticket exactly as it was: still
  // sent, still payable from the same link. Nothing to write.
  if (state !== "paid") return base;

  const paymentIntentId = paymentIntentIdOf(session);
  const capture = await currentCapture(session, opts);
  const receiptUrl = capture.receiptUrl;
  base.amountCents = capture.amountCents;
  const wasSent = ticket.status === "sent";

  // The email may have joined batch0 since the invite went out — or the admin
  // may have typed it before the person ever signed up. Match again now, so a
  // holder who IS signed in sees the event on their dashboard (events RLS,
  // migration 0070). Best-effort: a ticket never depends on an account.
  const userId =
    ticket.user_id ?? (await findProfileByEmail(ticket.email))?.id ?? null;

  // Only one worker may transition a sent ticket; existing refunds win.
  const { data: settled, error: settlementError } = await admin
    .from("demo_day_tickets")
    .update({
      status: capture.charge?.refunded ? "refunded" : "paid",
      ...(capture.paidAt ? { paid_at: capture.paidAt } : {}),
      captured_amount_cents: capture.amountCents,
      captured_currency: capture.currency,
      stripe_payment_intent_id: paymentIntentId,
      stripe_receipt_url: receiptUrl,
      user_id: userId,
    })
    .eq("id", ticketId)
    .eq("status", ticket.status)
    .in("status", ["sent", "paid"]).select("id");
  if (settlementError) throw new Error(settlementError.message);
  if (!opts.skipRefundSync && capture.charge && capture.charge.amount_refunded > 0) await handleChargeRefunded(capture.charge, { silent: true });

  if (wasSent && settled?.length && !capture.charge?.refunded) {
    if (!opts.silent) {
      await announceTicketPaid({ ...ticket, user_id: userId }, receiptUrl);
    }
    await logAudit({
      action: "demo_day_ticket.paid",
      targetType: "demo_day_ticket",
      targetId: ticket.id,
      payload: {
        email: ticket.email,
        amount_cents: capture.amountCents,
        stripe_session_id: session.id,
        stripe_payment_intent_id: paymentIntentId,
      },
    });
  } else if (ticket.status === "paid") {
    if (receiptUrl) {
      // Already settled — still worth backfilling the receipt link.
      await admin
        .from("demo_day_tickets")
        .update({ stripe_receipt_url: receiptUrl })
        .eq("id", ticketId)
        .is("stripe_receipt_url", null);
    }
  } else {
    // Money arrived for a ticket that was cancelled or refunded in the
    // meantime — a Checkout tab left open past the admin's click. The guard
    // above correctly left the row alone, but the charge is real, so make
    // it impossible to miss: the admin refunds it from Stripe.
    console.error(
      "[stripe] payment for a closed Demo Day ticket",
      JSON.stringify({ ticketId, status: ticket.status, paymentIntentId }),
    );
    await logAudit({
      action: "demo_day_ticket.paid_after_close",
      targetType: "demo_day_ticket",
      targetId: ticket.id,
      payload: {
        status: ticket.status,
        amount_cents: amountCents,
        stripe_session_id: session.id,
        stripe_payment_intent_id: paymentIntentId,
      },
    });
  }

  return { ...base, receiptUrl: receiptUrl ?? base.receiptUrl };
}

/**
 * Confirmation email (+ an in-app note when the email is on an account),
 * fired once when the ticket first becomes paid. Best-effort, like
 * announceEnrollment: a flaky mailer must not make Stripe retry a payment
 * we've already banked.
 */
async function announceTicketPaid(
  ticket: DemoDayTicket,
  receiptUrl: string | null,
) {
  try {
    const details = await getDemoDayDetails(ticket.cohort_id);
    const amount = formatTicketAmount(ticket.amount_cents);
    const detailLines = [
      details.location ? `Where: ${details.location}` : "",
      details.externalUrl ? `Join link: ${details.externalUrl}` : "",
    ]
      .filter(Boolean)
      .join(" · ");
    await sendTemplated(TICKET_CONFIRMED_TEMPLATE, {
      to: ticket.email,
      toName: ticket.name,
      userId: ticket.user_id,
      vars: {
        amount,
        demo_day_when: details.when ?? "",
        cohort_name: details.cohortName ?? "",
        demo_day_details: detailLines,
      },
      // One confirmation per ticket, however the fulfilment arrived —
      // webhook, retry, or the pay page settling on return from Checkout.
      dedupeKey: `demo-day-ticket-confirmed:${ticket.id}`,
      fallback: () =>
        Templates.demoDayTicketConfirmed({
          name: ticket.name,
          amountCents: ticket.amount_cents,
          when: details.when,
          cohortName: details.cohortName,
          location: details.location,
          externalUrl: details.externalUrl,
          hasAccount: !!ticket.user_id,
          receiptUrl,
        }),
    });
    if (ticket.user_id) {
      await notify({
        userId: ticket.user_id,
        type: "demo_day_ticket_paid",
        title: "You're confirmed for Demo Day",
        body: `Ticket paid: ${amount}. The event is under Events.`,
        link: "/dashboard/events",
        dedupeKey: `demo_day_ticket_paid:${ticket.id}`,
      });
    }
  } catch (err) {
    console.error("[stripe] ticket announce failed", err);
  }
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
  const piId = typeof charge.payment_intent === "string" ? charge.payment_intent : charge.payment_intent?.id;
  if (!piId) return;
  const full = charge.refunded === true;
  const refundId = charge.refunds?.data?.[0]?.id ?? null;
  const refundArgs = {
    p_payment_intent_id: piId, p_amount_cents: charge.amount_captured,
    p_refunded_cents: charge.amount_refunded, p_currency: charge.currency,
  };
  let { data: result, error } = await admin.rpc("apply_enrollment_refund", refundArgs);
  if (error) throw new Error(`Enrollment refund reconciliation failed: ${error.message}`);
  if (!result?.matched) {
    // The refund can beat Checkout completion: the pending row may not yet
    // have its payment-intent ID. Resolve its real session and settle current
    // Stripe state before cleanup, so an older in-flight completion cannot
    // subsequently grant access from a stale pre-refund snapshot.
    const sessions = await stripe.checkout.sessions.list({ payment_intent: piId, limit: 100 });
    for (const session of sessions.data) {
      if (session.metadata?.application_id || ["user_charge", "demo_day_ticket"].includes(session.metadata?.kind ?? "")) {
        await fulfillCheckoutSession(session, { silent: true, skipRefundSync: true });
      }
    }
    ({ data: result, error } = await admin.rpc("apply_enrollment_refund", refundArgs));
    if (error) throw new Error(`Enrollment refund recovery failed: ${error.message}`);
  }
  let changed = Boolean(result?.changed);
  if (result?.changed && result.user_id && !opts.silent) {
    await notify({ userId: result.user_id, type: "payment_refunded",
      title: full ? "Payment refunded" : "Partial refund issued",
      body: `${(charge.amount_refunded / 100).toFixed(2)} ${charge.currency.toUpperCase()} returned to your payment method.`,
      link: "/dashboard/billing", dedupeKey: `refund:${piId}:${charge.amount_refunded}` });
  }
  // Fee and ticket refunds retain their quote; captured/refunded money is
  // stored independently. Re-read the current charge before calling us.
  for (const table of ["user_charges", "demo_day_tickets"] as const) {
    const { data: row, error: readError } = await admin.from(table)
      .select("id,user_id,status,amount_refunded_cents")
      .eq("stripe_payment_intent_id", piId).maybeSingle();
    if (readError) throw new Error(readError.message);
    if (!row) continue;
    const refunded = Math.max(row.amount_refunded_cents ?? 0, charge.amount_refunded);
    const rowChanged = refunded !== row.amount_refunded_cents;
    const { error: writeError } = await admin.from(table).update({
      captured_amount_cents: charge.amount_captured, captured_currency: charge.currency,
      amount_refunded_cents: refunded,
      ...(full ? { status: "refunded", refunded_at: new Date().toISOString(), stripe_refund_id: refundId } : {}),
    }).eq("id", row.id).lte("amount_refunded_cents", refunded);
    if (writeError) throw new Error(writeError.message);
    changed ||= rowChanged;
    if (rowChanged && row.user_id && !opts.silent) await notify({
      userId: row.user_id, type: table === "user_charges" ? "charge_refunded" : "demo_day_ticket_refunded",
      title: full ? "Payment refunded" : "Partial refund issued",
      body: `${(refunded / 100).toFixed(2)} ${charge.currency.toUpperCase()} returned to your payment method.`,
      link: "/dashboard/billing", dedupeKey: `refund:${piId}:${refunded}`,
    });
  }
  if (changed) await logAudit({ action: full ? "payment.refunded" : "payment.partially_refunded",
    targetType: "payment_intent", targetId: piId,
    payload: { amount_refunded: charge.amount_refunded, amount: charge.amount, stripe_refund_id: refundId } });
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

  // A Demo Day ticket has no pending ledger row to close, and its holder may
  // have no account to notify: Checkout already showed them the decline, and
  // the link in their inbox is still live to try again.
  if (pi.metadata?.kind === "demo_day_ticket") return;

  const sessions = await stripe.checkout.sessions.list({ payment_intent: pi.id, limit: 100 });
  for (const session of sessions.data) {
    const { error } = await admin.from("payments")
      .update({ status: "failed", stripe_payment_intent_id: pi.id })
      .eq("stripe_session_id", session.id).eq("status", "pending");
    if (error) throw new Error(error.message);
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
