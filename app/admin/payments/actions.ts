"use server";
import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { stripe } from "@/lib/stripe";
import { assertPermission } from "@/lib/server-guards";
import { logAudit } from "@/lib/audit";
import { reconcileStripe } from "@/lib/stripe-reconcile";
import {
  postChannelMessage,
  refundEmbed,
  getDiscordSettings,
} from "@/lib/discord";

/**
 * Pull every transaction Stripe knows about back into the platform.
 *
 * Stripe is the ledger of record; this replays its sessions and refunds
 * through the same idempotent fulfillment the webhook uses. Run it after
 * changing webhook configuration, after an outage, or once to backfill
 * transactions that predate the webhook. Safe to run repeatedly.
 *
 * Announcements stay off: this is usually catching up on old money, and a
 * student shouldn't get a "welcome aboard" email for last spring's
 * payment. Rows, statuses, enrollments, and receipts are all still fixed.
 */
export async function reconcileStripeNow(input?: { days?: number }) {
  await assertPermission("payments.manage");
  const days = input?.days;
  const summary = await reconcileStripe({
    sinceUnix: days
      ? Math.floor(Date.now() / 1000) - days * 86_400
      : undefined,
    silent: true,
  });

  await logAudit({
    action: "payments.reconciled",
    targetType: "stripe",
    targetId: null,
    payload: { window_days: days ?? null, ...summary },
  });

  revalidatePath("/admin/payments");
  return summary;
}

export async function refundPayment(paymentId: string, reason?: string) {
  await assertPermission("payments.manage");
  const admin = createAdminClient();
  const { data: p, error: fetchErr } = await admin
    .from("payments")
    .select("id, user_id, stripe_payment_intent_id, status, amount_cents")
    .eq("id", paymentId)
    .single();
  if (fetchErr) throw new Error(fetchErr.message);
  if (!p?.stripe_payment_intent_id) {
    throw new Error("No Stripe payment intent recorded for this payment.");
  }
  if (p.status !== "succeeded") {
    throw new Error(`Cannot refund a payment with status "${p.status}".`);
  }

  const refund = await stripe.refunds.create({
    payment_intent: p.stripe_payment_intent_id,
    reason: "requested_by_customer",
    metadata: reason ? { admin_reason: reason } : undefined,
  });

  // Mark optimistically; the charge.refunded webhook will also update.
  await admin
    .from("payments")
    .update({ status: "refunded" })
    .eq("id", paymentId);

  await logAudit({
    action: "payment.refunded",
    targetType: "payment",
    targetId: paymentId,
    payload: {
      amount_cents: p.amount_cents,
      stripe_refund_id: refund.id,
      reason: reason ?? null,
    },
  });

  try {
    const settings = await getDiscordSettings();
    if (settings.adminFeedChannelId) {
      const { data: profile } = await admin
        .from("profiles")
        .select("full_name, email")
        .eq("id", p.user_id)
        .maybeSingle();
      await postChannelMessage(settings.adminFeedChannelId, {
        embeds: [
          refundEmbed({
            name: profile?.full_name ?? profile?.email ?? null,
            amountCents: p.amount_cents,
            description: "Enrollment payment refund",
            reason: reason?.trim() || null,
            kind: "payment",
          }),
        ],
      });
    }
  } catch (err) {
    console.error("[payments] discord refund post failed", err);
  }

  revalidatePath("/admin/payments");
  return { ok: true, refundId: refund.id };
}
