"use server";
import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { stripe } from "@/lib/stripe";
import { assertAdmin } from "@/lib/server-guards";
import { logAudit } from "@/lib/audit";

export async function refundPayment(paymentId: string, reason?: string) {
  await assertAdmin();
  const admin = createAdminClient();
  const { data: p, error: fetchErr } = await admin
    .from("payments")
    .select("id, stripe_payment_intent_id, status, amount_cents")
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

  revalidatePath("/admin/payments");
  return { ok: true, refundId: refund.id };
}
