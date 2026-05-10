import { NextResponse } from "next/server";
import type Stripe from "stripe";
import { stripe } from "@/lib/stripe";
import { createAdminClient } from "@/lib/supabase/admin";

// Stripe needs the raw body to verify the signature
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: Request) {
  const sig = req.headers.get("stripe-signature");
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!sig || !secret) {
    return NextResponse.json({ error: "Missing signature/secret" }, { status: 400 });
  }
  const rawBody = await req.text();

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, sig, secret);
  } catch (err: any) {
    return NextResponse.json({ error: `Bad signature: ${err.message}` }, { status: 400 });
  }

  const admin = createAdminClient();

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object as Stripe.Checkout.Session;
        const applicationId = session.metadata?.application_id;
        const userId = session.metadata?.user_id;
        const cohortId = session.metadata?.cohort_id || null;
        if (!applicationId || !userId) break;

        // Mark application paid + record enrollment
        await admin
          .from("applications")
          .update({
            status: "paid",
            paid_at: new Date().toISOString(),
            stripe_payment_intent_id:
              typeof session.payment_intent === "string"
                ? session.payment_intent
                : session.payment_intent?.id ?? null,
          })
          .eq("id", applicationId);

        // Update payment row
        await admin
          .from("payments")
          .update({
            status: "succeeded",
            stripe_payment_intent_id:
              typeof session.payment_intent === "string"
                ? session.payment_intent
                : session.payment_intent?.id ?? null,
          })
          .eq("stripe_session_id", session.id);

        // Create enrollment if cohort known
        if (cohortId) {
          await admin
            .from("enrollments")
            .upsert(
              {
                user_id: userId,
                cohort_id: cohortId,
                application_id: applicationId,
              },
              { onConflict: "user_id,cohort_id" },
            );
          // Bump app to enrolled
          await admin
            .from("applications")
            .update({ status: "enrolled" })
            .eq("id", applicationId);
        }
        break;
      }

      case "payment_intent.payment_failed": {
        const pi = event.data.object as Stripe.PaymentIntent;
        await admin
          .from("payments")
          .update({ status: "failed" })
          .eq("stripe_payment_intent_id", pi.id);
        break;
      }

      case "charge.refunded": {
        const charge = event.data.object as Stripe.Charge;
        const piId = typeof charge.payment_intent === "string" ? charge.payment_intent : charge.payment_intent?.id;
        if (piId) {
          await admin
            .from("payments")
            .update({ status: "refunded" })
            .eq("stripe_payment_intent_id", piId);
        }
        break;
      }

      default:
        // Acknowledge unhandled events
        break;
    }
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }

  return NextResponse.json({ received: true });
}
