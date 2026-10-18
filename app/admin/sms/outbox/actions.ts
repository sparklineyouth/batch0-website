"use server";

import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { assertPermission } from "@/lib/server-guards";
import { logAudit } from "@/lib/audit";
import { maskE164 } from "@/lib/phone";
import { MAX_ATTEMPTS, drainSmsQueue } from "@/lib/sms/queue";

/**
 * Outbox controls for texting.
 *
 * Same shape as app/admin/email/outbox/actions.ts, and for the same reason: the
 * queue is the last point at which an admin can still change their mind. Two
 * things differ, and both come from SMS costing money and carrying statutory
 * damages:
 *
 *   * A retry is REFUSED past the drain's attempt cap instead of resetting the
 *     counter. Email resets to zero because a bounced address costs nothing to
 *     try again; a text that failed three times failed for a structural reason
 *     (landline, carrier block, dead number) and each attempt is billed.
 *
 *   * Nothing here can create a send. Cancel, retry, and drain only — the
 *     composer is the one place a message is authored, so this file can never be
 *     the path by which something reaches a number that didn't consent.
 *
 * Numbers never appear in full in an audit payload. `maskE164` is enough to
 * identify which row an action hit, and the audit log is read by more people
 * than the outbox is.
 */

export async function cancelQueuedSms(
  id: string,
): Promise<{ ok: boolean; error?: string }> {
  await assertPermission("sms.send");
  const admin = createAdminClient();

  // `.eq("status","pending")` is the lock, not decoration: the drain runs on its
  // own clock and may have claimed this row between the page render and the
  // click. Better a refusal than marking a text somebody already received as
  // cancelled.
  const { data, error } = await admin
    .from("sms_outbox")
    .update({
      status: "canceled",
      last_error: "Cancelled by an admin",
      updated_at: new Date().toISOString(),
    })
    .eq("id", id)
    .eq("status", "pending")
    .select("id, to_phone");
  if (error) return { ok: false, error: error.message };
  if (!data || data.length === 0) {
    return { ok: false, error: "Too late — that one already left the queue." };
  }

  await logAudit({
    action: "sms.outbox_canceled",
    targetType: "sms_outbox",
    targetId: id,
    payload: { to: maskE164(data[0].to_phone) },
  });
  revalidatePath("/admin/sms/outbox");
  return { ok: true };
}

/**
 * Put a failed row back in the queue.
 *
 * Deliberately does NOT reset `attempts`. The drain stops retrying at
 * MAX_ATTEMPTS, and it also jumps the counter straight to the cap for a failure
 * the provider called terminal — so a row at the cap is either genuinely
 * undeliverable or has already been tried three times, and the honest answer is
 * a refusal that says which. Re-queueing it would bill for a fourth attempt at
 * the same wall.
 */
export async function retryFailedSms(
  id: string,
): Promise<{ ok: boolean; error?: string }> {
  await assertPermission("sms.send");
  const admin = createAdminClient();

  const { data: row, error: readError } = await admin
    .from("sms_outbox")
    .select("id, status, attempts, to_phone, last_error")
    .eq("id", id)
    .maybeSingle();
  if (readError) return { ok: false, error: readError.message };
  if (!row) return { ok: false, error: "That message is no longer in the outbox." };
  if (row.status !== "failed") {
    return {
      ok: false,
      error: `Only failed messages can be retried — this one is "${row.status}".`,
    };
  }
  if ((row.attempts ?? 0) >= MAX_ATTEMPTS) {
    return {
      ok: false,
      error:
        `This message has already been attempted ${row.attempts} times and the carrier ` +
        `kept refusing it${row.last_error ? ` — "${row.last_error}"` : ""}. ` +
        `Fix the number or the content and send a new message rather than retrying this one.`,
    };
  }

  const { data: updated, error } = await admin
    .from("sms_outbox")
    .update({
      status: "pending",
      last_error: null,
      send_after: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", id)
    .eq("status", "failed")
    .select("id");
  if (error) return { ok: false, error: error.message };
  if (!updated || updated.length === 0) {
    // The drain's own retry pass picked it up in the same second. Harmless —
    // the row is already pending — but say so rather than reporting success for
    // an update that matched nothing.
    return { ok: false, error: "The drain already re-queued that one." };
  }

  await logAudit({
    action: "sms.outbox_retried",
    targetType: "sms_outbox",
    targetId: id,
    payload: { to: maskE164(row.to_phone), attempts: row.attempts },
  });
  revalidatePath("/admin/sms/outbox");
  return { ok: true };
}

/**
 * Drain the queue now, without waiting for cron.
 *
 * Worth having for the same reason email has it: after configuring a number, the
 * difference between confidence and a support ticket is not having to wait a
 * cron interval to find out whether anything works. Returns the report as prose
 * because the numbers only mean something together — "0 sent, 4 skipped" is a
 * consent problem and "0 sent, 4 deferred" is quiet hours doing its job.
 */
export async function runSmsQueueNow(): Promise<{ ok: boolean; message: string }> {
  await assertPermission("sms.send");
  const report = await drainSmsQueue();
  await logAudit({
    action: "sms.queue_run_manual",
    targetType: "sms_outbox",
    payload: report,
  });
  revalidatePath("/admin/sms/outbox");

  if (report.inert) {
    return { ok: false, message: `Nothing to drain — ${report.inert}` };
  }
  if (report.paused) {
    return {
      ok: false,
      message: "Sending is paused — nothing went out. Everything due is still queued.",
    };
  }
  const parts = [
    `${report.sent} sent`,
    report.segments > 0 ? `${report.segments} segments` : null,
    report.failed > 0 ? `${report.failed} failed` : null,
    report.skipped > 0 ? `${report.skipped} skipped (no consent, or suppressed)` : null,
    report.deferred > 0 ? `${report.deferred} pushed past quiet hours` : null,
    report.retried > 0 ? `${report.retried} re-queued for another attempt` : null,
  ].filter(Boolean);
  return {
    ok: report.errors.length === 0,
    message:
      parts.join(", ") +
      (report.errors.length > 0 ? ` — ${report.errors.join("; ")}` : ""),
  };
}

/**
 * Stop a campaign mid-flight.
 *
 * Cancels the rows that haven't gone yet and closes the campaign, in that order:
 * if the second write fails, the messages are still stopped and the campaign row
 * is merely stale, which somebody can fix. The reverse order would mark a
 * campaign cancelled while its remaining texts kept sending.
 *
 * Rows already `sending` are left alone. The provider call is in flight and the
 * text is effectively gone; flipping the status would only lose the delivery
 * result when the drain writes it back.
 */
export async function cancelCampaign(
  campaignId: string,
): Promise<{ ok: boolean; error?: string; message?: string }> {
  await assertPermission("sms.send");
  const admin = createAdminClient();

  const { data: campaign, error: readError } = await admin
    .from("sms_campaigns")
    .select("id, name, status")
    .eq("id", campaignId)
    .maybeSingle();
  if (readError) return { ok: false, error: readError.message };
  if (!campaign) return { ok: false, error: "That campaign no longer exists." };

  const { data: canceled, error } = await admin
    .from("sms_outbox")
    .update({
      status: "canceled",
      last_error: "Campaign cancelled by an admin",
      updated_at: new Date().toISOString(),
    })
    .eq("campaign_id", campaignId)
    .eq("status", "pending")
    .select("id");
  if (error) return { ok: false, error: error.message };

  const count = canceled?.length ?? 0;
  const { error: campaignError } = await admin
    .from("sms_campaigns")
    .update({ status: "canceled", updated_at: new Date().toISOString() })
    .eq("id", campaignId);
  if (campaignError) {
    return {
      ok: false,
      error: `Stopped ${count} queued message${count === 1 ? "" : "s"}, but the campaign row wouldn't update: ${campaignError.message}`,
    };
  }

  await logAudit({
    action: "sms.campaign_canceled",
    targetType: "sms_campaigns",
    targetId: campaignId,
    payload: { name: campaign.name, canceled: count },
  });
  revalidatePath("/admin/sms/outbox");
  return {
    ok: true,
    message:
      count === 0
        ? "Nothing was still waiting — the campaign had already drained."
        : `Stopped ${count} queued message${count === 1 ? "" : "s"}.`,
  };
}
