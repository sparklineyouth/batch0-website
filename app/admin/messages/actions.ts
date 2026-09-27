"use server";
import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { assertPermission } from "@/lib/server-guards";
import { runAction, type ActionResult } from "@/lib/action-result";
import { logAudit } from "@/lib/audit";
import type { ReportStatus } from "@/lib/dm-access";

/**
 * Moderation actions on reported DMs. Gated by `moderation.manage` — the same
 * permission that gates reading them at all (dm_can_read_conversation, 0089).
 *
 * Deliberately short: a moderator can resolve a report and remove a message,
 * and that's it. They can't post in the conversation, can't read an unreported
 * one, and can't un-report — the record of the report stays.
 */

/**
 * A moderator who is one of the two people in a conversation doesn't get to
 * rule on it: dismissing a report about yourself, or removing the messages it
 * is about, would make the report a formality. Another moderator handles it.
 */
async function assertNotParticipant(conversationId: string, userId: string) {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("dm_conversations")
    .select("user_a, user_b")
    .eq("id", conversationId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error("That conversation is gone.");
  if ((data as any).user_a === userId || (data as any).user_b === userId) {
    throw new Error("You're part of this conversation, so another moderator has to handle it.");
  }
}

function revalidateAll(conversationId?: string) {
  revalidatePath("/admin/messages");
  if (conversationId) revalidatePath(`/admin/messages/${conversationId}`);
}

/** Close a report: actioned (we did something) or dismissed (nothing to do). */
export async function resolveReport(input: {
  reportId: string;
  status: Extract<ReportStatus, "actioned" | "dismissed">;
}): Promise<ActionResult> {
  return runAction({ name: "resolveReport" }, async () => {
    const actor = await assertPermission("moderation.manage");
    if (input.status !== "actioned" && input.status !== "dismissed") {
      throw new Error("Pick an outcome.");
    }
    const admin = createAdminClient();
    const { data: report, error: readErr } = await admin
      .from("dm_reports")
      .select("conversation_id")
      .eq("id", input.reportId)
      .maybeSingle();
    if (readErr) throw new Error(readErr.message);
    if (!report) throw new Error("That report is gone.");
    await assertNotParticipant((report as any).conversation_id, actor.userId);

    const { data, error } = await admin
      .from("dm_reports")
      .update({
        status: input.status,
        reviewed_by: actor.userId,
        reviewed_at: new Date().toISOString(),
      })
      .eq("id", input.reportId)
      .select("conversation_id")
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) throw new Error("That report is gone.");

    await logAudit({
      action: `dm.report.${input.status}`,
      targetType: "dm_report",
      targetId: input.reportId,
    });
    revalidateAll((data as any).conversation_id);
  });
}

/**
 * Remove a message from a reported conversation. Both participants lose it —
 * which is the point when the content is the problem — so it's audited.
 *
 * Note this does NOT check the report again: a moderator only ever reaches the
 * page it's actioned from by passing dm_can_read_conversation(), and the same
 * gate is on the delete policy in 0089.
 */
export async function removeMessage(input: {
  messageId: string;
  conversationId: string;
}): Promise<ActionResult> {
  return runAction({ name: "removeMessage" }, async () => {
    const actor = await assertPermission("moderation.manage");
    const admin = createAdminClient();
    const { data: message } = await admin
      .from("dm_messages")
      .select("id, conversation_id, sender_id, body")
      .eq("id", input.messageId)
      .maybeSingle();
    if (!message) throw new Error("That message is already gone.");

    // Only inside a conversation somebody reported. The service-role client
    // bypasses RLS, so this check is the one that counts here.
    const { count } = await admin
      .from("dm_reports")
      .select("id", { count: "exact", head: true })
      .eq("conversation_id", (message as any).conversation_id);
    if ((count ?? 0) === 0) throw new Error("That conversation hasn't been reported.");
    await assertNotParticipant((message as any).conversation_id, actor.userId);

    const { error } = await admin.from("dm_messages").delete().eq("id", input.messageId);
    if (error) throw new Error(error.message);

    await logAudit({
      action: "dm.message.remove",
      targetType: "dm_message",
      targetId: input.messageId,
      // Who and where, not what: the audit log is readable with audit.view,
      // which does not include moderation.manage, so copying the body here
      // would open the message to people the report never opened it to.
      payload: {
        conversationId: (message as any).conversation_id,
        senderId: (message as any).sender_id,
        length: String((message as any).body).length,
      },
    });
    revalidateAll((message as any).conversation_id);
  });
}
