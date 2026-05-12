import { NextResponse } from "next/server";
import type Stripe from "stripe";
import { stripe } from "@/lib/stripe";
import { createAdminClient } from "@/lib/supabase/admin";
import { sendEmail } from "@/lib/email/send";
import { Templates } from "@/lib/email/templates";
import { notify } from "@/lib/notifications";
import { logAudit } from "@/lib/audit";
import { postDiscordWebhook, syncMemberRoles, postChannelMessage, announcementEmbed, getDiscordSettings } from "@/lib/discord";

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

  // Idempotency with retry-safety: we "claim" the event by inserting a
  // row with completed_at=null, then "complete" it after all side
  // effects succeed. If we crash in the middle, the row sticks at the
  // claimed state and Stripe's next delivery picks it back up.
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
      case "checkout.session.completed": {
        const session = event.data.object as Stripe.Checkout.Session;
        const kind = session.metadata?.kind;
        const userId = session.metadata?.user_id;

        // Branch 1: user_charge (fee or fine) checkout.
        if (kind === "user_charge") {
          const chargeId = session.metadata?.charge_id;
          const piId =
            typeof session.payment_intent === "string"
              ? session.payment_intent
              : session.payment_intent?.id ?? null;
          if (chargeId) {
            const { data: charge } = await admin
              .from("user_charges")
              .select("user_id, kind, description, amount_cents")
              .eq("id", chargeId)
              .single();
            await admin
              .from("user_charges")
              .update({
                status: "paid",
                paid_at: new Date().toISOString(),
                stripe_payment_intent_id: piId,
              })
              .eq("id", chargeId);
            if (charge) {
              await notify({
                userId: charge.user_id,
                type: "charge_paid",
                title:
                  (charge.kind === "fine" ? "Fine paid: " : "Fee paid: ") +
                  charge.description,
                body: `Amount: $${(charge.amount_cents / 100).toFixed(2)}`,
                link: "/dashboard/billing",
              });
            }
          }
          break;
        }

        // Branch 2: application enrollment checkout (original flow).
        const applicationId = session.metadata?.application_id;
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
          // Use the safe column list so this still works if migration
          // 0008 (discord_*) hasn't been applied yet.
          const { data: profile } = await admin
            .from("profiles")
            .select("email, full_name, role")
            .eq("id", userId)
            .maybeSingle();
          // Discord linkage is optional — if 0008 isn't applied this
          // query throws "column does not exist" and we just skip.
          let discordUserId: string | null = null;
          try {
            const { data: d, error: dErr } = await admin
              .from("profiles")
              .select("discord_user_id")
              .eq("id", userId)
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
          // Find the payment row so we can also reverse the application
          // + enrollment side-effects when the refund comes from Stripe
          // directly (rather than via our admin refund flow).
          const { data: payment } = await admin
            .from("payments")
            .select("id, user_id, application_id")
            .eq("stripe_payment_intent_id", piId)
            .maybeSingle();
          await admin
            .from("payments")
            .update({ status: "refunded" })
            .eq("stripe_payment_intent_id", piId);
          if (payment?.application_id) {
            await admin
              .from("applications")
              .update({ status: "accepted", paid_at: null })
              .eq("id", payment.application_id);
            await admin
              .from("enrollments")
              .delete()
              .eq("application_id", payment.application_id);
            if (payment.user_id) {
              await notify({
                userId: payment.user_id,
                type: "payment_refunded",
                title: "Payment refunded",
                body: "Your enrollment payment was refunded. Reach out if this was unexpected.",
                link: "/dashboard/billing",
              });
            }
          }
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
    // Leave processed_stripe_events.completed_at as null so Stripe's
    // next retry picks the event back up. Returning 500 also tells
    // Stripe to retry.
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
