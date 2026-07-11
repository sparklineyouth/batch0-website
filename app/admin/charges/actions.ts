"use server";
import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { assertAdmin } from "@/lib/server-guards";
import { logAudit } from "@/lib/audit";
import { sendEmail } from "@/lib/email/send";
import { notify } from "@/lib/notifications";
import { stripe } from "@/lib/stripe";
import { env } from "@/lib/env";
import type { ChargeKind } from "@/lib/types";
import {
  postChannelMessage,
  refundEmbed,
  getDiscordSettings,
} from "@/lib/discord";

export type ChargeInput = {
  userId: string;
  kind: ChargeKind;
  amountCents: number;
  description: string;
};

export async function issueCharge(input: ChargeInput) {
  const { userId: actorId } = await assertAdmin();
  if (!input.description.trim()) throw new Error("Description required");
  if (!input.amountCents || input.amountCents < 50) {
    throw new Error("Amount must be at least 50 cents");
  }
  if (input.kind !== "fee" && input.kind !== "fine") {
    throw new Error("Invalid charge kind");
  }

  const admin = createAdminClient();
  const { data: charge, error } = await admin
    .from("user_charges")
    .insert({
      user_id: input.userId,
      kind: input.kind,
      amount_cents: input.amountCents,
      description: input.description.trim(),
      created_by: actorId,
    })
    .select("id")
    .single();
  if (error) throw new Error(error.message);

  await logAudit({
    action: `charge.${input.kind}_issued`,
    targetType: "user_charge",
    targetId: charge!.id,
    payload: {
      user_id: input.userId,
      amount_cents: input.amountCents,
      description: input.description,
    },
  });

  // Notify the user (in-app + email).
  const { data: profile } = await admin
    .from("profiles")
    .select("email, full_name")
    .eq("id", input.userId)
    .maybeSingle();
  await notify({
    userId: input.userId,
    type: input.kind === "fine" ? "fine_issued" : "fee_issued",
    title:
      input.kind === "fine"
        ? `Fine: ${input.description}`
        : `Fee: ${input.description}`,
    body: `Amount: $${(input.amountCents / 100).toFixed(2)}`,
    link: "/dashboard/billing",
  });
  if (profile?.email) {
    const dollars = (input.amountCents / 100).toFixed(2);
    const subject =
      input.kind === "fine"
        ? `Fine on your Sparkline Youth account — $${dollars}`
        : `Fee on your Sparkline Youth account — $${dollars}`;
    const body = `<!doctype html><html><body style="background:#0a0a0a;color:#e7e7e7;font-family:Inter,Arial,sans-serif;margin:0;padding:32px">
      <div style="max-width:560px;margin:0 auto;background:#111;border:1px solid rgba(255,255,255,.08);border-radius:16px;padding:32px">
        <div style="font-weight:700">Spark<span style="color:#facc15">Line</span> Youth</div>
        <h1 style="font-size:20px;color:#fff">${escape(input.description)}</h1>
        <p>An admin has issued a${input.kind === "fine" ? " <strong>fine</strong> of " : " <strong>fee</strong> of "}<strong>$${dollars}</strong> on your account.</p>
        ${
          input.kind === "fine"
            ? "<p>Your dashboard access is paused until this is paid or waived.</p>"
            : "<p>You can keep using Sparkline Youth, but you'll see a prompt to pay until it's settled.</p>"
        }
        <p><a href="${env.siteUrl}/dashboard/billing" style="display:inline-block;background:#facc15;color:#000;padding:10px 18px;border-radius:8px;font-weight:600;text-decoration:none">Open billing</a></p>
      </div>
    </body></html>`;
    await sendEmail({ to: profile.email, subject, html: body });
  }

  revalidatePath("/admin/charges");
  revalidatePath(`/admin/charges?user=${input.userId}`);
  revalidatePath("/dashboard");
  revalidatePath("/dashboard/billing");
  return charge!.id as string;
}

export async function waiveCharge(chargeId: string, reason: string) {
  const { userId } = await assertAdmin();
  const admin = createAdminClient();
  const { data: existing, error: fetchErr } = await admin
    .from("user_charges")
    .select("user_id, status, kind, description, amount_cents")
    .eq("id", chargeId)
    .single();
  if (fetchErr) throw new Error(fetchErr.message);
  if (existing.status !== "pending") {
    throw new Error(`Charge is already ${existing.status}.`);
  }

  const { error } = await admin
    .from("user_charges")
    .update({
      status: "waived",
      waived_at: new Date().toISOString(),
      waived_by: userId,
      waiver_reason: reason?.trim() || null,
    })
    .eq("id", chargeId);
  if (error) throw new Error(error.message);

  await logAudit({
    action: "charge.waived",
    targetType: "user_charge",
    targetId: chargeId,
    payload: { reason: reason || null, kind: existing.kind },
  });
  await notify({
    userId: existing.user_id,
    type: "charge_waived",
    title: `${existing.kind === "fine" ? "Fine" : "Fee"} waived: ${existing.description}`,
    body: "An admin has waived this charge.",
    link: "/dashboard/billing",
  });
  revalidatePath("/admin/charges");
  revalidatePath("/dashboard");
  revalidatePath("/dashboard/billing");
}

export async function refundCharge(chargeId: string, reason?: string) {
  const { userId } = await assertAdmin();
  const admin = createAdminClient();
  const { data: existing, error: fetchErr } = await admin
    .from("user_charges")
    .select(
      "user_id, status, kind, description, amount_cents, stripe_payment_intent_id",
    )
    .eq("id", chargeId)
    .single();
  if (fetchErr) throw new Error(fetchErr.message);
  if (existing.status !== "paid") {
    throw new Error(`Only paid charges can be refunded (status: ${existing.status}).`);
  }
  if (!existing.stripe_payment_intent_id) {
    throw new Error("No Stripe payment intent recorded for this charge.");
  }

  const refund = await stripe.refunds.create({
    payment_intent: existing.stripe_payment_intent_id,
    reason: "requested_by_customer",
    metadata: reason ? { admin_reason: reason } : undefined,
  });

  // Mark optimistically; the charge.refunded webhook will also update.
  const { error: updateErr } = await admin
    .from("user_charges")
    .update({
      status: "refunded",
      refunded_at: new Date().toISOString(),
      refunded_by: userId,
      refund_reason: reason?.trim() || null,
      stripe_refund_id: refund.id,
    })
    .eq("id", chargeId);
  if (updateErr) throw new Error(updateErr.message);

  await logAudit({
    action: `charge.${existing.kind}_refunded`,
    targetType: "user_charge",
    targetId: chargeId,
    payload: {
      amount_cents: existing.amount_cents,
      stripe_refund_id: refund.id,
      reason: reason ?? null,
    },
  });
  await notify({
    userId: existing.user_id,
    type: "charge_refunded",
    title: `${existing.kind === "fine" ? "Fine" : "Fee"} refunded: ${existing.description}`,
    body: `$${(existing.amount_cents / 100).toFixed(2)} returned to your card.`,
    link: "/dashboard/billing",
  });

  try {
    const settings = await getDiscordSettings();
    if (settings.adminFeedChannelId) {
      const { data: p } = await admin
        .from("profiles")
        .select("full_name, email")
        .eq("id", existing.user_id)
        .maybeSingle();
      await postChannelMessage(settings.adminFeedChannelId, {
        embeds: [
          refundEmbed({
            name: p?.full_name ?? p?.email ?? null,
            amountCents: existing.amount_cents,
            description: existing.description,
            reason: reason?.trim() || null,
            kind: existing.kind,
          }),
        ],
      });
    }
  } catch (err) {
    console.error("[charges] discord refund post failed", err);
  }

  revalidatePath("/admin/charges");
  revalidatePath(`/admin/charges?user=${existing.user_id}`);
  revalidatePath("/dashboard");
  revalidatePath("/dashboard/billing");
  return { ok: true as const, refundId: refund.id };
}

export async function cancelCharge(chargeId: string) {
  await assertAdmin();
  const admin = createAdminClient();
  const { data: existing } = await admin
    .from("user_charges")
    .select("status, user_id")
    .eq("id", chargeId)
    .single();
  if (!existing) throw new Error("Not found");
  if (existing.status !== "pending") {
    throw new Error("Only pending charges can be cancelled");
  }
  const { error } = await admin
    .from("user_charges")
    .update({ status: "cancelled" })
    .eq("id", chargeId);
  if (error) throw new Error(error.message);
  await logAudit({
    action: "charge.cancelled",
    targetType: "user_charge",
    targetId: chargeId,
  });
  revalidatePath("/admin/charges");
}

export type BulkChargeAction = "waive" | "cancel";

export async function bulkChargeAction(input: {
  chargeIds: string[];
  action: BulkChargeAction;
  reason?: string;
}): Promise<{ succeeded: number; failed: number; skipped: number }> {
  await assertAdmin();
  if (input.chargeIds.length === 0) {
    return { succeeded: 0, failed: 0, skipped: 0 };
  }
  if (input.chargeIds.length > 200) {
    throw new Error("Cap bulk charge actions at 200 rows per run.");
  }
  let succeeded = 0;
  let failed = 0;
  let skipped = 0;
  for (const id of input.chargeIds) {
    try {
      if (input.action === "waive") {
        await waiveCharge(id, input.reason ?? "");
      } else {
        await cancelCharge(id);
      }
      succeeded++;
    } catch (err: any) {
      if (
        typeof err?.message === "string" &&
        /already|only pending|not found/i.test(err.message)
      ) {
        skipped++;
      } else {
        failed++;
      }
    }
  }
  revalidatePath("/admin/charges");
  return { succeeded, failed, skipped };
}

function escape(s: string) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
