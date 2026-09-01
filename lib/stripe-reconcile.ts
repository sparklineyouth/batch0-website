// ---------------------------------------------------------------------------
// Stripe reconciliation — pull the truth back from Stripe.
//
// Webhooks are the primary path and reconciliation on return from Checkout
// covers the race. This module covers everything those two can miss: a
// webhook endpoint that wasn't configured yet, an event Stripe gave up
// retrying, a deploy that was down when the POST arrived, a refund issued
// in the Stripe dashboard, and every transaction that predates this code.
//
// Stripe is the ledger of record. Nothing here invents state — it replays
// real sessions and refunds through the same idempotent fulfillment the
// webhook uses, so running it twice changes nothing the second time.
// ---------------------------------------------------------------------------

import type Stripe from "stripe";
import { stripe } from "@/lib/stripe";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  fulfillCheckoutSession,
  handleChargeRefunded,
  type FulfillmentResult,
} from "@/lib/stripe-fulfillment";

export type ReconcileSummary = {
  /** Checkout Sessions read from Stripe. */
  sessionsScanned: number;
  /** Sessions that resolved to a paid state (already-paid included). */
  paid: number;
  /** Rows closed out because their checkout expired or failed. */
  closed: number;
  /** Refunds mirrored back into our tables. */
  refunds: number;
  /** Rows that were pending in our DB and got a definite answer. */
  pendingResolved: number;
  errors: string[];
};

const emptySummary = (): ReconcileSummary => ({
  sessionsScanned: 0,
  paid: 0,
  closed: 0,
  refunds: 0,
  pendingResolved: 0,
  errors: [],
});

export type ReconcileOptions = {
  /**
   * Only look at Stripe objects created at or after this Unix timestamp.
   * Omit to walk the entire account history (the backfill case).
   */
  sinceUnix?: number;
  /**
   * Suppress receipt emails / notifications. Default true — reconciliation
   * is usually catching up on old money, and nobody wants a "welcome
   * aboard" email for a payment they made last spring. The database is
   * brought fully up to date either way.
   */
  silent?: boolean;
  /** Safety valve on how many sessions to walk in one run. */
  maxSessions?: number;
};

/**
 * Bring the platform in line with Stripe.
 *
 * Three passes, cheapest first:
 *   1. Our own pending rows — ask Stripe what happened to each.
 *   2. Stripe's Checkout Sessions — catch payments we have no row for.
 *   3. Stripe's refunds — mirror money that went back out.
 */
export async function reconcileStripe(
  opts: ReconcileOptions = {},
): Promise<ReconcileSummary> {
  const silent = opts.silent ?? true;
  const summary = emptySummary();

  await resolvePendingRows(summary, silent);
  await walkSessions(summary, { ...opts, silent });
  await walkRefunds(summary, { ...opts, silent });

  return summary;
}

/**
 * Pass 1 — every row of ours still sitting at "pending" with a Stripe
 * session attached. These are the rows a student actually sees, so they
 * get resolved first and are worth resolving even outside the time window.
 */
async function resolvePendingRows(
  summary: ReconcileSummary,
  silent: boolean,
) {
  const admin = createAdminClient();
  const [{ data: payments }, { data: charges }] = await Promise.all([
    admin
      .from("payments")
      .select("stripe_session_id")
      .eq("status", "pending")
      .not("stripe_session_id", "is", null),
    admin
      .from("user_charges")
      .select("stripe_session_id")
      .eq("status", "pending")
      .not("stripe_session_id", "is", null),
  ]);

  const ids = Array.from(
    new Set(
      [...(payments ?? []), ...(charges ?? [])]
        .map((r: any) => r.stripe_session_id as string)
        .filter(Boolean),
    ),
  );

  for (const id of ids) {
    try {
      const session = await stripe.checkout.sessions.retrieve(id);
      const result = await fulfillCheckoutSession(session, { silent });
      summary.pendingResolved += 1;
      tally(summary, result);
    } catch (err: any) {
      // A session Stripe no longer knows about (wrong mode, deleted test
      // data) isn't fatal — record it and keep going.
      summary.errors.push(`session ${id}: ${err?.message ?? "failed"}`);
    }
  }
}

/**
 * Pass 2 — walk Stripe's own list of Checkout Sessions. This is what
 * catches transactions the platform never recorded at all, including
 * everything that happened before the webhook existed.
 */
async function walkSessions(
  summary: ReconcileSummary,
  opts: ReconcileOptions,
) {
  const max = opts.maxSessions ?? 1000;
  const params: Stripe.Checkout.SessionListParams = { limit: 100 };
  if (opts.sinceUnix) params.created = { gte: opts.sinceUnix };

  try {
    for await (const session of stripe.checkout.sessions.list(params)) {
      if (summary.sessionsScanned >= max) break;
      summary.sessionsScanned += 1;
      // Only sessions this platform created carry our metadata; anything
      // else in the Stripe account is none of our business.
      const ours =
        session.metadata?.kind === "user_charge" ||
        !!session.metadata?.application_id;
      if (!ours) continue;
      try {
        const result = await fulfillCheckoutSession(session, {
          silent: opts.silent,
        });
        tally(summary, result);
      } catch (err: any) {
        summary.errors.push(
          `session ${session.id}: ${err?.message ?? "failed"}`,
        );
      }
    }
  } catch (err: any) {
    summary.errors.push(`session list: ${err?.message ?? "failed"}`);
  }
}

/**
 * Pass 3 — refunds. Rare enough to walk in full, and the only way a refund
 * issued from the Stripe dashboard before this code shipped ever shows up
 * on a student's billing page.
 */
async function walkRefunds(
  summary: ReconcileSummary,
  opts: ReconcileOptions,
) {
  const params: Stripe.RefundListParams = { limit: 100 };
  if (opts.sinceUnix) params.created = { gte: opts.sinceUnix };

  const seenCharges = new Set<string>();
  try {
    for await (const refund of stripe.refunds.list(params)) {
      const chargeId =
        typeof refund.charge === "string" ? refund.charge : refund.charge?.id;
      if (!chargeId || seenCharges.has(chargeId)) continue;
      seenCharges.add(chargeId);
      try {
        // Re-read the charge so `refunded` / `amount_refunded` reflect the
        // final total rather than this one refund in isolation.
        const charge = await stripe.charges.retrieve(chargeId);
        await handleChargeRefunded(charge, { silent: opts.silent });
        summary.refunds += 1;
      } catch (err: any) {
        summary.errors.push(`refund ${refund.id}: ${err?.message ?? "failed"}`);
      }
    }
  } catch (err: any) {
    summary.errors.push(`refund list: ${err?.message ?? "failed"}`);
  }
}

function tally(summary: ReconcileSummary, result: FulfillmentResult) {
  if (result.state === "paid") summary.paid += 1;
  else if (result.state === "expired" || result.state === "failed") {
    summary.closed += 1;
  }
  // A payment that couldn't be written to the ledger is money the admin
  // Payments page won't show. Surface it instead of counting a clean run.
  if (result.ledgerError) summary.errors.push(result.ledgerError);
}
