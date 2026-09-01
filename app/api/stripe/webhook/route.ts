import { NextResponse } from "next/server";
import type Stripe from "stripe";
import { stripe } from "@/lib/stripe";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  fulfillCheckoutSession,
  handleChargeRefunded,
  handlePaymentFailed,
} from "@/lib/stripe-fulfillment";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Events we act on. Anything else is acknowledged and ignored — Stripe
 * accounts fan out a lot of noise, and a 200 keeps it out of the retry
 * queue. Keep this list in sync with the endpoint's enabled events in the
 * Stripe dashboard.
 */
const HANDLED = new Set([
  "checkout.session.completed",
  "checkout.session.async_payment_succeeded",
  "checkout.session.async_payment_failed",
  "checkout.session.expired",
  "payment_intent.payment_failed",
  "charge.refunded",
]);

export async function POST(req: Request) {
  const sig = req.headers.get("stripe-signature");
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!sig || !secret) {
    return NextResponse.json(
      { error: "Missing signature/secret" },
      { status: 400 },
    );
  }
  const rawBody = await req.text();

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, sig, secret);
  } catch (err: any) {
    return NextResponse.json(
      { error: `Bad signature: ${err.message}` },
      { status: 400 },
    );
  }

  if (!HANDLED.has(event.type)) {
    return NextResponse.json({ received: true, ignored: true });
  }

  const admin = createAdminClient();

  // Idempotency with retry-safety: we "claim" the event by inserting a
  // row with completed_at=null, then "complete" it after all side
  // effects succeed. If we crash in the middle, the row sticks at the
  // claimed state and Stripe's next delivery picks it back up. The
  // handlers below are individually idempotent too, so a replay is safe.
  try {
    const { error: dedupeErr } = await admin
      .from("processed_stripe_events")
      .insert({
        event_id: event.id,
        event_type: event.type,
        completed_at: null,
      });
    if (dedupeErr) {
      if ((dedupeErr as any).code === "23505") {
        // Already exists — was it actually completed?
        const { data: existing } = await admin
          .from("processed_stripe_events")
          .select("completed_at")
          .eq("event_id", event.id)
          .maybeSingle();
        if (existing?.completed_at) {
          return NextResponse.json({ received: true, deduped: true });
        }
        // Claimed but not completed (previous attempt crashed). Fall
        // through and re-run side effects; ops are idempotent below.
      } else {
        console.error("[stripe webhook] dedupe insert error", dedupeErr);
      }
    }
  } catch (err) {
    console.error("[stripe webhook] dedupe error", err);
  }

  try {
    switch (event.type) {
      // The happy path, and its delayed-payment-method twin. Both mean
      // "the money is ours"; fulfillCheckoutSession decides what that
      // unlocks (tuition vs a fee/fine) and is safe to re-run.
      case "checkout.session.completed":
      case "checkout.session.async_payment_succeeded": {
        const session = event.data.object as Stripe.Checkout.Session;
        await fulfillCheckoutSession(session);
        break;
      }

      // A bank debit that looked fine at checkout later bounced.
      case "checkout.session.async_payment_failed": {
        const session = event.data.object as Stripe.Checkout.Session;
        await fulfillCheckoutSession(session, { forceState: "failed" });
        break;
      }

      // The student opened Checkout and never finished. Close the ledger
      // row out so it doesn't sit "pending" in their billing history for
      // the rest of time.
      case "checkout.session.expired": {
        const session = event.data.object as Stripe.Checkout.Session;
        await fulfillCheckoutSession(session, { forceState: "expired" });
        break;
      }

      case "payment_intent.payment_failed": {
        await handlePaymentFailed(event.data.object as Stripe.PaymentIntent);
        break;
      }

      case "charge.refunded": {
        await handleChargeRefunded(event.data.object as Stripe.Charge);
        break;
      }
    }
  } catch (err: any) {
    // Leave processed_stripe_events.completed_at as null so Stripe's
    // next retry picks the event back up. Returning 500 also tells
    // Stripe to retry.
    console.error("[stripe webhook] handler failed", event.type, err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }

  // All side effects succeeded — mark the event fully processed.
  try {
    await admin
      .from("processed_stripe_events")
      .update({ completed_at: new Date().toISOString() })
      .eq("event_id", event.id);
  } catch (err) {
    console.error("[stripe webhook] complete update failed", err);
    // Don't 500 — side effects already happened; worst case Stripe
    // delivers the event again and we replay (idempotently) before
    // re-marking complete.
  }

  return NextResponse.json({ received: true });
}
