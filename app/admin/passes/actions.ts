"use server";
import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { logAudit } from "@/lib/audit";

export type ActionResult = { ok: true; message: string } | { ok: false; error: string };

/**
 * Revoke a single pass. The card keeps existing physically; the code stops
 * working.
 *
 * Revoke, never delete — the row is the only record that serial was ever
 * issued, and deleting it would free the serial for reuse while a card bearing
 * that number is still in someone's pocket.
 */
export async function revokePassAction(serial: number): Promise<ActionResult> {
  await requireAdmin();
  const admin = createAdminClient();

  const { data, error } = await admin
    .from("founder_passes")
    .update({ revoked_at: new Date().toISOString() })
    .eq("serial", serial)
    .is("revoked_at", null)
    .select("serial, redeemed_by")
    .maybeSingle();

  if (error) return { ok: false, error: error.message };
  if (!data) return { ok: false, error: `Pass #${serial} not found, or already revoked.` };

  const row = data as { serial: number; redeemed_by: string | null };
  await logAudit({
    action: "founder_pass.revoked",
    targetType: "founder_pass",
    targetId: String(serial),
    payload: { serial, was_redeemed_by: row.redeemed_by },
  });

  revalidatePath("/admin/passes");
  revalidatePath("/dashboard");
  return {
    ok: true,
    message: row.redeemed_by
      ? `Pass #${serial} revoked. Its holder loses the perks immediately.`
      : `Pass #${serial} revoked.`,
  };
}

/**
 * Revoke an entire batch — the answer to "that batch's code list leaked".
 *
 * This is why batch names exist as a column at all: one print run can be killed
 * without touching cards from any other run.
 */
export async function revokeBatchAction(batch: string): Promise<ActionResult> {
  await requireAdmin();
  const admin = createAdminClient();

  const { data, error } = await admin
    .from("founder_passes")
    .update({ revoked_at: new Date().toISOString() })
    .eq("batch", batch)
    .is("revoked_at", null)
    .select("serial, redeemed_by");

  if (error) return { ok: false, error: error.message };
  const rows = (data ?? []) as Array<{ serial: number; redeemed_by: string | null }>;
  if (rows.length === 0) return { ok: false, error: `No live passes in batch "${batch}".` };

  const heldCount = rows.filter((r) => r.redeemed_by).length;

  await logAudit({
    action: "founder_pass.batch_revoked",
    targetType: "founder_pass_batch",
    targetId: batch,
    payload: { batch, revoked: rows.length, was_held: heldCount },
  });

  revalidatePath("/admin/passes");
  revalidatePath("/dashboard");
  return {
    ok: true,
    message:
      `Revoked ${rows.length} pass(es) in "${batch}".` +
      (heldCount > 0
        ? ` ${heldCount} were already redeemed — those people just lost their perks, so tell them.`
        : ""),
  };
}
