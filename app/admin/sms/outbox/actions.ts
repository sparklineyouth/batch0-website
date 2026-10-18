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

/**
 * Cancel one row that hasn't gone yet: one still `pending`, or one `failed`
 * that the drain's retry pass would otherwise send again (under the attempt
 * cap). A failed row waiting for its retry is as much "still queued" as a
 * pending one — it goes out in five or thirty minutes unless something stops it.
 */
export async function cancelQueuedSms(
  id: string,
): Promise<{ ok: boolean; error?: string }> {
  await assertPermission("sms.send");
  const admin = createAdminClient();

  const { data: row, error: readError } = await admin
    .from("sms_outbox")
    .select("status, attempts")
    .eq("id", id)
    .maybeSingle();
  if (readError) return { ok: false, error: readError.message };
  const awaitingRetry = row?.status === "failed" && (row.attempts ?? 0) < MAX_ATTEMPTS;
  if (!row || (row.status !== "pending" && !awaitingRetry)) {
    return { ok: false, error: "Too late — that one already left the queue." };
  }

  // The status filter is the lock, not decoration: the drain runs on its own
  // clock and may have claimed or retried this row between the read and the
  // click. Better a refusal than marking a text somebody already received as
  // cancelled.
  let update = admin
    .from("sms_outbox")
    .update({
      status: "canceled",
      last_error: "Cancelled by an admin",
      updated_at: new Date().toISOString(),
    })
    .eq("id", id)
    .eq("status", row.status);
  if (awaitingRetry) update = update.lt("attempts", MAX_ATTEMPTS);
  const { data, error } = await update.select("id, to_phone");
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
    // Not "attempted 3 times": a row reaches the cap after one try when the
    // carrier called the failure permanent, and a direct send (a test) is
    // written at the cap because its sender already saw it fail.
    return {
      ok: false,
      error:
        `This message is done retrying${row.last_error ? ` — "${row.last_error}"` : ""}. ` +
        `Either it failed ${MAX_ATTEMPTS} times, or it failed in a way another attempt ` +
        `wouldn't fix. Fix the number or the content and send a new message rather than retrying this one.`,
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
      message:
        "Sending is paused — nothing went out. Everything due is still queued." +
        (report.reconciled > 0
          ? ` (${report.reconciled} missed opt-out${report.reconciled === 1 ? " was" : "s were"} recorded.)`
          : ""),
    };
  }
  const parts = [
    `${report.sent} sent`,
    report.segments > 0 ? `${report.segments} segments` : null,
    report.failed > 0 ? `${report.failed} failed` : null,
    report.skipped > 0 ? `${report.skipped} skipped (no consent, or suppressed)` : null,
    report.deferred > 0 ? `${report.deferred} pushed past quiet hours` : null,
    report.retried > 0 ? `${report.retried} re-queued for another attempt` : null,
    report.canceled > 0 ? `${report.canceled} closed (campaign stopped)` : null,
    report.reconciled > 0
      ? `${report.reconciled} missed opt-out${report.reconciled === 1 ? "" : "s"} recorded`
      : null,
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
 * Closes the campaign, then cancels every row of it that hasn't gone yet, in
 * that order. The drain checks the campaign's status before it re-queues or
 * sends a campaign row (lib/sms/queue.ts), so the campaign row is the brake:
 * once it says `canceled`, a row this function then fails to reach is still
 * never sent — the drain closes it instead.
 *
 * "Hasn't gone yet" is three statuses, not one:
 *   pending   — waiting for its send_after.
 *   sending   — claimed by a drain that is working through its batch (up to 60
 *               rows over ~45 seconds). The drain re-checks each row is still
 *               `sending` immediately before the provider call, so cancelling
 *               these stops every one it hasn't reached. The one whose call is
 *               already in flight goes out regardless, and its result
 *               overwrites `canceled` with what really happened.
 *   failed    — under the attempt cap, i.e. waiting for the retry pass, which
 *               would otherwise text the student five or thirty minutes later.
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

  const { error: campaignError } = await admin
    .from("sms_campaigns")
    .update({ status: "canceled", updated_at: new Date().toISOString() })
    .eq("id", campaignId);
  if (campaignError) {
    // Nothing is stopped yet, so say so rather than cancelling rows behind a
    // campaign that still reads as live.
    return { ok: false, error: `The campaign wouldn't stop: ${campaignError.message}` };
  }

  const patch = {
    status: "canceled",
    last_error: "Campaign cancelled by an admin",
    updated_at: new Date().toISOString(),
  };
  const [waiting, claimed, retrying] = await Promise.all([
    admin.from("sms_outbox").update(patch).eq("campaign_id", campaignId).eq("status", "pending").select("id"),
    admin.from("sms_outbox").update(patch).eq("campaign_id", campaignId).eq("status", "sending").select("id"),
    admin
      .from("sms_outbox")
      .update(patch)
      .eq("campaign_id", campaignId)
      .eq("status", "failed")
      .lt("attempts", MAX_ATTEMPTS)
      .select("id"),
  ]);
  const count =
    (waiting.data?.length ?? 0) + (claimed.data?.length ?? 0) + (retrying.data?.length ?? 0);
  const rowError = waiting.error ?? claimed.error ?? retrying.error;
  if (rowError) {
    return {
      ok: false,
      error:
        `The campaign is stopped and the drain won't send any more of it, but ` +
        `some of its queued rows still read as waiting: ${rowError.message}`,
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
        : `Stopped ${count} message${count === 1 ? "" : "s"} that hadn't gone out.` +
          // A claimed row may be the one whose provider call is in flight right
          // now; that one still arrives, and the outbox will say so.
          ((claimed.data?.length ?? 0) > 0
            ? " A drain was mid-batch, so the one it was handing to the carrier at that moment may still arrive."
            : ""),
  };
}
