"use server";
import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { assertPermission, requireActor } from "@/lib/server-guards";
import { runAction, type ActionResult } from "@/lib/action-result";
import { logAudit } from "@/lib/audit";
import {
  AUDIENCES,
  CHANNEL_NAME_PATTERN,
  isUuid,
  normalizeChannelName,
  SLOWMODE_CHOICES,
  TOPIC_MAX,
  type Audience,
  type Posting,
} from "@/lib/chat-access";
import { getChannelRow, getPeople, type ChannelRow } from "@/lib/chat";

/**
 * Running chat: creating, editing, archiving and deleting text channels, and
 * adding people to one beyond its audience. Everything here needs
 * `chat.manage` — the same key the read rule (0101 chat_is_staff) and the
 * /admin/chat route use. Used from the admin page and from a channel's
 * settings inside /chat.
 */

export type ChannelInput = {
  name: string;
  topic?: string | null;
  audience: Audience;
  cohortId?: string | null;
  teamId?: string | null;
  posting: Posting;
  slowmodeSeconds?: number;
  position?: number;
};

function cleanInput(input: ChannelInput) {
  const name = normalizeChannelName(String(input.name ?? ""));
  if (!name || !CHANNEL_NAME_PATTERN.test(name)) {
    throw new Error("Give the channel a name: letters, numbers and hyphens.");
  }
  const topic = String(input.topic ?? "").trim().slice(0, TOPIC_MAX) || null;
  if (!AUDIENCES.includes(input.audience)) throw new Error("Pick who can see the channel.");
  const cohortId = input.audience === "cohort" ? input.cohortId : null;
  const teamId = input.audience === "team" ? input.teamId : null;
  if (input.audience === "cohort" && !isUuid(cohortId)) throw new Error("Pick the cohort.");
  if (input.audience === "team" && !isUuid(teamId)) throw new Error("Pick the team.");
  if (input.posting !== "everyone" && input.posting !== "staff") throw new Error("Pick who can post.");
  const slowmode = Number(input.slowmodeSeconds ?? 0);
  if (!(SLOWMODE_CHOICES as readonly number[]).includes(slowmode)) throw new Error("Pick a slow mode setting.");
  const position = Math.max(-1000, Math.min(1000, Math.round(Number(input.position ?? 30)) || 0));
  return {
    name,
    topic,
    audience: input.audience,
    cohort_id: cohortId ?? null,
    team_id: teamId ?? null,
    posting: input.posting,
    slowmode_seconds: slowmode,
    position,
  };
}

function revalidate() {
  revalidatePath("/admin/chat");
}

async function textChannel(id: string): Promise<ChannelRow> {
  const channel = await getChannelRow(id);
  if (!channel || channel.kind !== "channel") throw new Error("That channel doesn't exist.");
  return channel;
}

export async function createChannel(input: ChannelInput): Promise<ActionResult<{ channelId: string }>> {
  return runAction({ name: "chat.channel_create" }, async () => {
    const actor = await assertPermission("chat.manage");
    const row = cleanInput(input);
    const { data, error } = await createAdminClient()
      .from("chat_channels")
      .insert({ kind: "channel", ...row, created_by: actor.userId })
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    const channelId = (data as { id: string }).id;
    await logAudit({ action: "chat.channel_create", targetType: "chat_channel", targetId: channelId, payload: { name: row.name, audience: row.audience } });
    revalidate();
    return { channelId };
  });
}

export async function updateChannel(id: string, input: ChannelInput): Promise<ActionResult> {
  return runAction({ name: "chat.channel_update" }, async () => {
    await assertPermission("chat.manage");
    const channel = await textChannel(id);
    const row = cleanInput(input);
    // A channel the app owns keeps the audience it was made for: #general
    // turned into a team channel would strand everyone who relied on it.
    if (channel.systemKey && (row.audience !== channel.audience || row.cohort_id !== channel.cohortId || row.team_id !== channel.teamId)) {
      throw new Error("This channel's audience is fixed. Rename it or change who can post instead.");
    }
    const { error } = await createAdminClient().from("chat_channels").update(row).eq("id", id);
    if (error) throw new Error(error.message);
    await logAudit({ action: "chat.channel_update", targetType: "chat_channel", targetId: id, payload: { name: row.name, audience: row.audience, posting: row.posting, slowmode: row.slowmode_seconds } });
    revalidate();
  });
}

export async function setChannelArchived(id: string, archived: boolean): Promise<ActionResult> {
  return runAction({ name: "chat.channel_archive" }, async () => {
    await assertPermission("chat.manage");
    await textChannel(id);
    const { error } = await createAdminClient()
      .from("chat_channels")
      .update({ archived_at: archived ? new Date().toISOString() : null })
      .eq("id", id);
    if (error) throw new Error(error.message);
    await logAudit({ action: archived ? "chat.channel_archive" : "chat.channel_unarchive", targetType: "chat_channel", targetId: id });
    revalidate();
  });
}

/**
 * Delete a channel and every message in it. Only for channels batch0 didn't
 * make itself (a cohort's or team's channel goes when the cohort or team
 * does) — archive is the reversible option and the default in the UI.
 */
export async function deleteChannel(id: string, confirmName: string): Promise<ActionResult> {
  return runAction({ name: "chat.channel_delete" }, async () => {
    await assertPermission("chat.manage");
    const channel = await textChannel(id);
    if (channel.systemKey) throw new Error("batch0 made this channel, so it can be archived but not deleted.");
    if (String(confirmName ?? "").trim() !== channel.name) throw new Error(`Type the channel's name (${channel.name}) to delete it.`);
    const { error } = await createAdminClient().from("chat_channels").delete().eq("id", id);
    if (error) throw new Error(error.message);
    await logAudit({ action: "chat.channel_delete", targetType: "chat_channel", targetId: id, payload: { name: channel.name, messages: channel.messageCount } });
    revalidate();
  });
}

/** Add people to a text channel beyond its audience (a mentor in a cohort channel, members of a private one). */
export async function addChannelMembers(id: string, userIds: string[]): Promise<ActionResult<{ added: number }>> {
  return runAction({ name: "chat.channel_add" }, async () => {
    const actor = await assertPermission("chat.manage");
    await textChannel(id);
    const ids = Array.from(new Set(userIds.filter(isUuid))).slice(0, 200);
    const people = await getPeople(ids);
    const real = ids.filter((uid) => people.has(uid));
    if (real.length === 0) throw new Error("Pick someone to add.");
    const { error } = await createAdminClient()
      .from("chat_members")
      .upsert(real.map((uid) => ({ channel_id: id, user_id: uid, added_by: actor.userId })), {
        onConflict: "channel_id,user_id",
        ignoreDuplicates: true,
      });
    if (error) throw new Error(error.message);
    await logAudit({ action: "chat.channel_add_members", targetType: "chat_channel", targetId: id, payload: { count: real.length } });
    revalidate();
    return { added: real.length };
  });
}

export async function removeChannelMember(id: string, userId: string): Promise<ActionResult> {
  return runAction({ name: "chat.channel_remove" }, async () => {
    await assertPermission("chat.manage");
    await textChannel(id);
    if (!isUuid(userId)) throw new Error("That person isn't in this channel.");
    const { error } = await createAdminClient().from("chat_members").delete().eq("channel_id", id).eq("user_id", userId);
    if (error) throw new Error(error.message);
    await logAudit({ action: "chat.channel_remove_member", targetType: "chat_channel", targetId: id, payload: { userId } });
    revalidate();
  });
}

/** Close a report: acted on, or nothing to do. */
export async function resolveReport(id: string, status: "actioned" | "dismissed" | "open"): Promise<ActionResult> {
  return runAction({ name: "chat.report_resolve" }, async () => {
    const actor = await assertPermission("chat.manage");
    if (!isUuid(id)) throw new Error("That report doesn't exist.");
    if (!["actioned", "dismissed", "open"].includes(status)) throw new Error("Pick an outcome.");
    const admin = createAdminClient();
    const { data: report } = await admin.from("chat_reports").select("channel_id").eq("id", id).maybeSingle();
    if (!report) throw new Error("That report doesn't exist.");
    // A moderator who is in the reported conversation never works its report.
    const { data: member } = await admin
      .from("chat_members")
      .select("user_id")
      .eq("channel_id", (report as any).channel_id)
      .eq("user_id", actor.userId)
      .maybeSingle();
    const channel = await getChannelRow((report as any).channel_id);
    if (member && channel && channel.kind !== "channel") throw new Error("That report doesn't exist.");
    const { error } = await admin
      .from("chat_reports")
      .update(
        status === "open"
          ? { status, reviewed_by: null, reviewed_at: null }
          : { status, reviewed_by: actor.userId, reviewed_at: new Date().toISOString() },
      )
      .eq("id", id);
    if (error) throw new Error(error.message);
    await logAudit({ action: `chat.report_${status}`, targetType: "chat_report", targetId: id });
    revalidatePath("/admin/chat");
    revalidatePath(`/admin/chat/reports/${id}`);
  });
}

/** For the in-chat "Create channel" button: whether to show it. */
export async function viewerRunsChat(): Promise<boolean> {
  try {
    const actor = await requireActor();
    return actor.caps.superAdmin || actor.caps.permissions.includes("chat.manage");
  } catch {
    return false;
  }
}
