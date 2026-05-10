import { NextResponse } from "next/server";
import type Stripe from "stripe";
import { stripe } from "@/lib/stripe";
import { createAdminClient } from "@/lib/supabase/admin";
import { sendEmail } from "@/lib/email/send";
import { Templates } from "@/lib/email/templates";
import { notify } from "@/lib/notifications";
import { logAudit } from "@/lib/audit";
import { postDiscordWebhook } from "@/lib/discord";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

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

  const admin = createAdminClient();

  // Idempotency: dedupe by event.id. If we've already processed it,
  // ack and skip. If insert fails for any other reason, fall through
  // and process anyway (Stripe will retry; better to double-process
  // a refund-status flip than to silently drop a real event).
  try {
    const { error: dedupeErr } = await admin
      .from("processed_stripe_events")
      .insert({ event_id: event.id, event_type: event.type });
    if (dedupeErr) {
      // 23505 unique_violation = already processed
      if ((dedupeErr as any).code === "23505") {
        return NextResponse.json({ received: true, deduped: true });
      }
      console.error("[stripe webhook] dedupe insert error", dedupeErr);
    }
  } catch (err) {
    console.error("[stripe webhook] dedupe error", err);
  }

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object as Stripe.Checkout.Session;
        const applicationId = session.metadata?.application_id;
        const userId = session.metadata?.user_id;
        const cohortId = session.metadata?.cohort_id || null;
        if (!applicationId || !userId) break;

        const paymentIntentId =
          typeof session.payment_intent === "string"
            ? session.payment_intent
            : session.payment_intent?.id ?? null;

        await admin
          .from("applications")
          .update({
            status: "paid",
            paid_at: new Date().toISOString(),
            stripe_payment_intent_id: paymentIntentId,
          })
          .eq("id", applicationId);

        await admin
          .from("payments")
          .update({
            status: "succeeded",
            stripe_payment_intent_id: paymentIntentId,
          })
          .eq("stripe_session_id", session.id);

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

        // Receipt email + notification.
        try {
          const { data: profile } = await admin
            .from("profiles")
            .select("email, full_name")
            .eq("id", userId)
            .maybeSingle();
          let cohortName = "SparkLine";
          if (cohortId) {
            const { data: c } = await admin
              .from("cohorts")
              .select("name")
              .eq("id", cohortId)
              .maybeSingle();
            cohortName = c?.name ?? cohortName;
          }
          const t = Templates.paymentReceipt({
            name: profile?.full_name ?? null,
            amountCents: session.amount_total ?? 0,
            cohortName,
          });
          if (profile?.email) {
            await sendEmail({
              to: profile.email,
              subject: t.subject,
              html: t.html,
            });
          }
          await notify({
            userId,
            type: "enrolled",
            title: "You're enrolled",
            body: `Welcome to ${cohortName}. Course access is unlocked.`,
            link: "/dashboard/course",
          });
          // Trumpet new enrollments to the team Discord (best effort).
          await postDiscordWebhook({
            content: `🎉 **New enrollment** — ${profile?.full_name ?? "A new student"} just enrolled in **${cohortName}**!`,
          });
        } catch (err) {
          console.error("[stripe webhook] receipt notify failed", err);
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
        const piId =
          typeof charge.payment_intent === "string"
            ? charge.payment_intent
            : charge.payment_intent?.id;
        if (piId) {
          await admin
            .from("payments")
            .update({ status: "refunded" })
            .eq("stripe_payment_intent_id", piId);
        }
        await logAudit({
          action: "payment.refunded",
          targetType: "payment_intent",
          targetId: piId ?? null,
          payload: { amount: charge.amount_refunded },
        });
        break;
      }

      default:
        break;
    }
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }

  return NextResponse.json({ received: true });
}
