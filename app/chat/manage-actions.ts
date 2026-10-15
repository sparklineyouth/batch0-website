"use server";
import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { assertPermission, requireActor } from "@/lib/server-guards";
import { runAction, type ActionResult } from "@/lib/action-result";
import { logAudit } from "@/lib/audit";
import { isMissingSchemaError } from "@/lib/schema-ready";
import {
  asUuid,
  AUDIENCES,
  CHANNEL_NAME_PATTERN,
  isUuid,
  normalizeChannelName,
  SLOWMODE_CHOICES,
  TOPIC_MAX,
  type Audience,
  type Posting,
} from "@/lib/chat-access";
import { countChannelReports, getChannelRow, getChatViewer, getPeople, getPerson, getReport, type ChannelRow } from "@/lib/chat";
import { removeChannelFiles } from "@/lib/chat-files";

/**
 * Running chat: creating, editing, archiving and deleting text channels,
 * adding people to one beyond its audience, working reports, and muting
 * someone in chat. Everything here needs
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

/**
 * Validate a channel form. `keepPosition` is the stored position on an edit:
 * a form that doesn't show the field (the in-chat settings dialog) leaves the
 * channel where it was in the sidebar instead of resetting it.
 */
function cleanInput(input: ChannelInput, keepPosition = 30) {
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
  const position = Math.max(-1000, Math.min(1000, Math.round(Number(input.position ?? keepPosition)) || 0));
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
    const row = cleanInput(input, channel.position);
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
 * make itself (a cohort's or team's channel is archived, not deleted, when
 * the cohort or team goes), and never one with a report on it, whatever its
 * status and whoever can see it: the report and the revisions behind it are
 * evidence, and deleting the room must not be a way to lose them — not even
 * for a moderator the report is about, who can't see it in the queue. Archive
 * is the reversible option, and the default in the UI.
 */
const REPORTED_CHANNEL = "This channel has been reported, so it's kept as a record. Archive it instead.";

export async function deleteChannel(id: string, confirmName: string): Promise<ActionResult> {
  return runAction({ name: "chat.channel_delete" }, async () => {
    await assertPermission("chat.manage");
    const channel = await textChannel(id);
    if (channel.systemKey) throw new Error("batch0 made this channel, so it can be archived but not deleted.");
    if (String(confirmName ?? "").trim() !== channel.name) throw new Error(`Type the channel's name (${channel.name}) to delete it.`);
    if ((await countChannelReports(channel.id)) > 0) throw new Error(REPORTED_CHANNEL);
    const { error } = await createAdminClient().from("chat_channels").delete().eq("id", channel.id);
    // A report filed since the count: 0101's foreign key refuses the delete.
    if (error) throw new Error(error.code === "23503" ? REPORTED_CHANNEL : error.message);
    await removeChannelFiles(channel.id);
    await logAudit({ action: "chat.channel_delete", targetType: "chat_channel", targetId: channel.id, payload: { name: channel.name, messages: channel.messageCount } });
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
    id = id.toLowerCase();
    if (!["actioned", "dismissed", "open"].includes(status)) throw new Error("Pick an outcome.");
    const admin = createAdminClient();
    // A moderator any report on the channel names never works it — not even
    // after leaving the group, and not when it's their own message in a
    // channel (getReport applies channelReportsOpenTo).
    const report = await getReport(id, await getChatViewer(actor.userId, actor.caps));
    if (!report) throw new Error("That report doesn't exist.");
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

// ---------------------------------------------------------------------------
// Muting: what stops someone posting in chat without touching their role,
// enrollment or anything else they do on batch0 (chat_mutes, 0101).
// ---------------------------------------------------------------------------

/** The longest timed mute: a year. Longer than that is "until lifted". */
const MUTE_MAX_MINUTES = 60 * 24 * 365;

/**
 * Mute someone in chat for `minutes`, or until a moderator lifts it (null).
 * While muted they can read everything they could before, report and block,
 * and still DM the batch0 team — about the mute, say — but can't post, react,
 * pin, or start or change a conversation; the composer says so. Staff can't
 * be muted: they run chat and could lift it themselves (change their role).
 */
export async function mutePerson(userId: string, minutes: number | null, reason: string): Promise<ActionResult> {
  return runAction({ name: "chat.mute" }, async () => {
    const actor = await assertPermission("chat.manage");
    const id = asUuid(userId);
    if (!id) throw new Error("That person isn't available.");
    if (id === actor.userId) throw new Error("You can't mute yourself.");
    const person = await getPerson(id);
    if (!person) throw new Error("That person isn't available.");
    if (person.isStaff) throw new Error(`${person.name} runs chat, so a mute wouldn't hold. Change their role first.`);
    let until: string | null = null;
    if (minutes !== null) {
      const m = Math.round(Number(minutes));
      if (!Number.isFinite(m) || m < 1 || m > MUTE_MAX_MINUTES) throw new Error("Pick how long to mute them for.");
      until = new Date(Date.now() + m * 60_000).toISOString();
    }
    const note = String(reason ?? "").trim().slice(0, 500) || null;
    const { error } = await createAdminClient()
      .from("chat_mutes")
      .upsert(
        { user_id: id, until, reason: note, created_by: actor.userId, created_at: new Date().toISOString() },
        { onConflict: "user_id" },
      );
    if (error) {
      if (isMissingSchemaError(error)) throw new Error("Muting needs the latest chat migration (0101). Run it again, then try.");
      throw new Error(error.message);
    }
    // The reason stays on the mute row (staff only); the audit row says what
    // was done, by whom, for how long.
    await logAudit({ action: "chat.mute", targetType: "profile", targetId: id, payload: { minutes: minutes === null ? null : Math.round(Number(minutes)) } });
    revalidatePath("/admin/chat", "layout");
  });
}

/** Lift someone's chat mute. Nothing to do when they aren't muted. */
export async function unmutePerson(userId: string): Promise<ActionResult> {
  return runAction({ name: "chat.unmute" }, async () => {
    await assertPermission("chat.manage");
    const id = asUuid(userId);
    if (!id) throw new Error("That person isn't available.");
    const { data, error } = await createAdminClient().from("chat_mutes").delete().eq("user_id", id).select("user_id");
    if (error) {
      if (isMissingSchemaError(error)) return;
      throw new Error(error.message);
    }
    if ((data ?? []).length > 0) await logAudit({ action: "chat.unmute", targetType: "profile", targetId: id });
    revalidatePath("/admin/chat", "layout");
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
