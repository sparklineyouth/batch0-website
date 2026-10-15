import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { getAllRoles } from "@/lib/roles";
import { ACCEPTED_STATUSES } from "@/lib/pre-cohort";
import { can, type Capabilities } from "@/lib/permissions";
import { isMissingSchemaError } from "@/lib/schema-ready";
import {
  attentionFor,
  canReadChannel,
  compareChannels,
  compareConversations,
  groupDisplayName,
  isConversationVisible,
  isUuid,
  otherInDmKey,
  reportOpenTo,
  reportVisibleTo,
  type Audience,
  type ChannelKind,
  type ChannelScope,
  type ChatViewer,
  type NotifyPref,
  type Posting,
  type ReactionMap,
  type Party,
  conversationAllowed,
  SAFEGUARD_REASON,
} from "@/lib/chat-access";
import { plainText } from "@/lib/chat-format";
import type { ChatAttachment } from "@/lib/chat-files-rules";

/**
 * Reads for batch0 Chat (migration 0101).
 *
 * Service-role reads with explicit per-viewer checks, the shape the old DMs
 * (lib/dm.ts) had: a student may only read their OWN profiles row, and every
 * screen here needs other people's names, so names are resolved here on the
 * server and every function narrows to the viewer it was handed. RLS stays on
 * as the backstop (and is what Realtime applies), not as the thing that saves
 * us. Every rule comes from lib/chat-access.ts.
 *
 * Emails never enter a shape that reaches the browser. A person is a name, a
 * role label and a staff flag.
 */

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

export type ChatPerson = {
  id: string;
  name: string;
  /** "Mentor", "Admin", a custom role's label — or null for a student. */
  roleLabel: string | null;
  /** The role's colour token (lib/permissions.ts ROLE_COLORS). */
  roleColor: string | null;
  isStaff: boolean;
  /** Holds the student role — what the safeguarding rule looks at. */
  isStudent: boolean;
};

export type ChannelRow = ChannelScope & {
  name: string | null;
  topic: string | null;
  position: number;
  systemKey: string | null;
  dmKey: string | null;
  createdBy: string | null;
  lastMessageAt: string | null;
  lastMessagePreview: string | null;
  lastSenderId: string | null;
  messageCount: number;
  createdAt: string;
};

export type ReplyPreview = {
  id: string;
  senderId: string | null;
  preview: string;
  deleted: boolean;
};

export type ChatMessage = {
  id: string;
  channelId: string;
  senderId: string | null;
  body: string;
  kind: "message" | "system";
  replyTo: ReplyPreview | null;
  mentions: string[];
  mentionEveryone: boolean;
  attachments: ChatAttachment[];
  reactions: ReactionMap;
  createdAt: string;
  editedAt: string | null;
  pinnedAt: string | null;
};

export type SidebarItem = {
  id: string;
  kind: ChannelKind;
  /** What to show: "general", "Maya Chen", "Ann, Bo". */
  label: string;
  topic: string | null;
  audience: Audience;
  posting: Posting;
  systemKey: string | null;
  teamId: string | null;
  cohortId: string | null;
  /** DMs: the other person (null once their account is gone). */
  otherId: string | null;
  /** Groups: everyone in it. */
  memberIds: string[];
  lastMessageAt: string | null;
  /** DMs and groups only; a text channel's preview isn't shown. */
  preview: string | null;
  unread: number;
  mentions: number;
  notify: NotifyPref | null;
  position: number;
};

const CHANNEL_COLS =
  "id, kind, name, topic, audience, cohort_id, team_id, posting, slowmode_seconds, position, system_key, dm_key, created_by, archived_at, last_message_at, last_message_preview, last_sender_id, message_count, created_at";

const MESSAGE_COLS =
  "id, channel_id, sender_id, body, kind, reply_to_id, mentions, mention_everyone, attachments, reactions, created_at, edited_at, deleted_at, pinned_at";

/** A failed read throws: an outage must never render as "nothing here" (or "nobody blocked you"). */
function must<T>(res: { data: T | null; error: { message: string; code?: string } | null }, what: string): T | null {
  if (res.error) {
    const err = new Error(`Couldn't load ${what}: ${res.error.message}`) as Error & { code?: string };
    err.code = res.error.code;
    throw err;
  }
  return res.data;
}

/** Split into chunks short enough for a PostgREST `in` filter in a URL. */
function chunks<T>(items: readonly T[], size = 150): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export function toChannel(r: any): ChannelRow {
  return {
    id: r.id,
    kind: r.kind,
    name: r.name ?? null,
    topic: r.topic ?? null,
    audience: r.audience,
    cohortId: r.cohort_id ?? null,
    teamId: r.team_id ?? null,
    posting: r.posting,
    slowmodeSeconds: r.slowmode_seconds ?? 0,
    position: r.position ?? 0,
    systemKey: r.system_key ?? null,
    dmKey: r.dm_key ?? null,
    createdBy: r.created_by ?? null,
    archivedAt: r.archived_at ?? null,
    lastMessageAt: r.last_message_at ?? null,
    lastMessagePreview: r.last_message_preview ?? null,
    lastSenderId: r.last_sender_id ?? null,
    messageCount: r.message_count ?? 0,
    createdAt: r.created_at,
  };
}

function toAttachments(raw: unknown): ChatAttachment[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((a) => a && typeof a === "object" && typeof (a as any).path === "string")
    .map((a: any) => ({
      path: String(a.path),
      name: String(a.name ?? "file"),
      size: Number(a.size ?? 0),
      type: String(a.type ?? "application/octet-stream"),
    }));
}

function toMessage(r: any, reply: ReplyPreview | null): ChatMessage {
  return {
    id: r.id,
    channelId: r.channel_id,
    senderId: r.sender_id ?? null,
    body: r.body ?? "",
    kind: r.kind ?? "message",
    replyTo: reply,
    mentions: Array.isArray(r.mentions) ? r.mentions : [],
    mentionEveryone: !!r.mention_everyone,
    attachments: toAttachments(r.attachments),
    reactions: r.reactions && typeof r.reactions === "object" ? r.reactions : {},
    createdAt: r.created_at,
    editedAt: r.edited_at ?? null,
    pinnedAt: r.pinned_at ?? null,
  };
}

// ---------------------------------------------------------------------------
// People
// ---------------------------------------------------------------------------

const DELETED_NAME = "Deleted account";

/** Role slug → label, colour, and whether it runs chat. From the roles table, so a custom role labels itself. */
async function roleMeta(): Promise<Map<string, { label: string; color: string | null; isStaff: boolean }>> {
  const roles = await getAllRoles();
  const m = new Map<string, { label: string; color: string | null; isStaff: boolean }>();
  for (const r of roles) {
    const isStaff = r.permissions.includes("*") || r.permissions.includes("chat.manage");
    m.set(r.slug, { label: r.label, color: r.color ?? null, isStaff });
  }
  return m;
}

async function toPeople(rows: any[]): Promise<ChatPerson[]> {
  const meta = await roleMeta();
  return rows.map((r) => {
    const info = meta.get(r.role);
    return {
      id: r.id,
      name: r.full_name?.trim() || "A batch0 member",
      // Students are the default; only other roles wear a label.
      roleLabel: r.role && r.role !== "student" ? (info?.label ?? null) : null,
      roleColor: r.role && r.role !== "student" ? (info?.color ?? null) : null,
      isStaff: !!info?.isStaff,
      isStudent: !r.role || r.role === "student",
    };
  });
}

export async function getPeople(ids: readonly (string | null | undefined)[]): Promise<Map<string, ChatPerson>> {
  const real = Array.from(new Set(ids.filter(isUuid)));
  if (real.length === 0) return new Map();
  const admin = createAdminClient();
  const rows = (
    await Promise.all(
      chunks(real).map(
        async (part) => must(await admin.from("profiles").select("id, full_name, role").in("id", part), "people") ?? [],
      ),
    )
  ).flat();
  const people = await toPeople(rows);
  return new Map(people.map((p) => [p.id, p]));
}

export async function getPerson(id: string): Promise<ChatPerson | null> {
  return (await getPeople([id])).get(id) ?? null;
}

export function deletedPerson(id: string): ChatPerson {
  return { id, name: DELETED_NAME, roleLabel: null, roleColor: null, isStaff: false, isStudent: false };
}

/** People as the safeguarding rule sees them (lib/chat-access.ts conversationAllowed). */
export function asParty(p: ChatPerson): Party {
  return { id: p.id, student: p.isStudent, staff: p.isStaff };
}

/**
 * Is this DM or group's membership one the safeguarding rule allows? A
 * deleted account counts as nobody.
 */
export async function membershipAllowed(memberIds: readonly string[]): Promise<boolean> {
  const people = await getPeople(memberIds);
  return conversationAllowed(Array.from(people.values()).map(asParty));
}

/** Role slugs that run chat (staff). */
async function staffRoleSlugs(): Promise<string[]> {
  return Array.from((await roleMeta()).entries())
    .filter(([, m]) => m.isStaff)
    .map(([slug]) => slug);
}

/**
 * Of these people, who has been let in: a non-student role, or a student
 * with an enrollment or an accepted application. Mirrors chat_is_vetted() in
 * 0101. Asked per person, never by loading every enrollment.
 */
export async function vettedIds(ids: readonly string[]): Promise<Set<string>> {
  const unique = Array.from(new Set(ids.filter(isUuid)));
  if (unique.length === 0) return new Set();
  const admin = createAdminClient();
  const out = new Set<string>();
  const students: string[] = [];
  for (const part of chunks(unique)) {
    const rows = (must(await admin.from("profiles").select("id, role").in("id", part), "people") ?? []) as {
      id: string;
      role: string | null;
    }[];
    for (const r of rows) {
      if (r.role && r.role !== "student") out.add(r.id);
      else students.push(r.id);
    }
  }
  for (const part of chunks(students)) {
    const [enr, apps] = await Promise.all([
      admin.from("enrollments").select("user_id").in("user_id", part),
      admin
        .from("applications")
        .select("user_id")
        .in("user_id", part)
        .in("status", ACCEPTED_STATUSES as unknown as string[]),
    ]);
    for (const r of (must(enr, "enrollments") ?? []) as any[]) out.add(r.user_id);
    for (const r of (must(apps, "applications") ?? []) as any[]) out.add(r.user_id);
  }
  return out;
}

// ---------------------------------------------------------------------------
// The viewer
// ---------------------------------------------------------------------------

/** Everything the rules need about this person, resolved in one parallel batch. */
export async function getChatViewer(userId: string, caps: Capabilities | null): Promise<ChatViewer> {
  const admin = createAdminClient();
  const [vetted, enr, teams, mentored, members] = await Promise.all([
    vettedIds([userId]),
    admin.from("enrollments").select("cohort_id").eq("user_id", userId),
    admin.from("team_members").select("team_id").eq("user_id", userId),
    mentoredTeamIds(userId),
    admin.from("chat_members").select("channel_id").eq("user_id", userId).limit(2000),
  ]);
  const own = ((must(teams, "teams") ?? []) as any[]).map((r) => r.team_id as string);
  return {
    userId,
    staff: can(caps, "chat.manage"),
    vetted: vetted.has(userId),
    cohortIds: ((must(enr, "enrollments") ?? []) as any[]).map((r) => r.cohort_id),
    teamIds: Array.from(new Set([...own, ...mentored])),
    memberOf: ((must(members, "channels") ?? []) as any[]).map((r) => r.channel_id),
  };
}

/**
 * The teams a mentor's assigned students are on. A team's channel opens to
 * those mentors, the way the Discord team-channel sync used to — derived on
 * every read, so assigning or moving someone needs no resync. Mirrors the
 * mentor_assignments clause of chat_can_read() in 0101.
 */
export async function mentoredTeamIds(mentorId: string): Promise<string[]> {
  const admin = createAdminClient();
  const students = ((must(await admin.from("mentor_assignments").select("student_id").eq("mentor_id", mentorId).limit(1000), "mentor assignments") ??
    []) as any[]).map((r) => r.student_id as string);
  const out = new Set<string>();
  for (const part of chunks(Array.from(new Set(students)))) {
    const rows = (must(await admin.from("team_members").select("team_id").in("user_id", part), "teams") ?? []) as any[];
    for (const r of rows) out.add(r.team_id);
  }
  return Array.from(out);
}

/** Mentors assigned to anyone on this team: part of its channel's audience. */
async function teamMentorIds(teamId: string, among?: readonly string[]): Promise<string[]> {
  const admin = createAdminClient();
  const students = ((must(await admin.from("team_members").select("user_id").eq("team_id", teamId).limit(1000), "team") ?? []) as any[]).map(
    (r) => r.user_id as string,
  );
  const out = new Set<string>();
  for (const part of chunks(Array.from(new Set(students)))) {
    let q = admin.from("mentor_assignments").select("mentor_id").in("student_id", part);
    if (among) q = q.in("mentor_id", among as string[]);
    const rows = (must(await q, "mentor assignments") ?? []) as any[];
    for (const r of rows) out.add(r.mentor_id);
  }
  return Array.from(out);
}

// ---------------------------------------------------------------------------
// Channels
// ---------------------------------------------------------------------------

export async function getChannelRow(id: string): Promise<ChannelRow | null> {
  if (!isUuid(id)) return null;
  const data = must(
    await createAdminClient().from("chat_channels").select(CHANNEL_COLS).eq("id", id).maybeSingle(),
    "the channel",
  );
  return data ? toChannel(data) : null;
}

export async function getChannelBySystemKey(key: string): Promise<ChannelRow | null> {
  const data = must(
    await createAdminClient().from("chat_channels").select(CHANNEL_COLS).eq("system_key", key).maybeSingle(),
    "the channel",
  );
  return data ? toChannel(data) : null;
}

/**
 * Is this channel reported, by a report this viewer may see? The staff read
 * gate for DMs and groups — a moderator the report is about gets false.
 */
export async function isReportedFor(channelId: string, viewer: ChatViewer): Promise<boolean> {
  if (!viewer.staff) return false;
  const { data, error } = await createAdminClient().from("chat_reports").select("party_ids").eq("channel_id", channelId);
  if (error) throw new Error(`Couldn't load reports: ${error.message}`);
  return ((data ?? []) as { party_ids: string[] | null }[]).some((r) => reportOpenTo(r.party_ids ?? [], viewer));
}

/**
 * One channel, or null when it doesn't exist OR the viewer may not read it —
 * deliberately the same answer, so a guessed id can't confirm a DM exists.
 */
export async function getChannelForViewer(
  id: string,
  viewer: ChatViewer,
): Promise<{ channel: ChannelRow; reported: boolean } | null> {
  const channel = await getChannelRow(id);
  if (!channel) return null;
  // Only pay for the report lookup when it could change the answer.
  const reported =
    channel.kind !== "channel" && viewer.staff && !viewer.memberOf.includes(channel.id)
      ? await isReportedFor(channel.id, viewer)
      : false;
  return canReadChannel(channel, viewer, reported) ? { channel, reported } : null;
}

/**
 * Every channel, DM and group the viewer can read (archived ones too — the
 * caller decides what to show). One query, then the shared rule as a filter
 * so the list can never show more than the rule allows.
 */
export async function listReadableChannels(viewer: ChatViewer): Promise<ChannelRow[]> {
  const admin = createAdminClient();
  const ors: string[] = [];
  if (viewer.staff) ors.push("kind.eq.channel");
  else {
    if (viewer.vetted) ors.push("and(kind.eq.channel,audience.eq.everyone)");
    if (viewer.cohortIds.length) ors.push(`and(kind.eq.channel,audience.eq.cohort,cohort_id.in.(${viewer.cohortIds.join(",")}))`);
    if (viewer.teamIds.length) ors.push(`and(kind.eq.channel,audience.eq.team,team_id.in.(${viewer.teamIds.join(",")}))`);
  }
  const results: any[] = [];
  if (ors.length) {
    results.push(...(must(await admin.from("chat_channels").select(CHANNEL_COLS).or(ors.join(",")).limit(1000), "channels") ?? []));
  }
  for (const part of chunks(viewer.memberOf)) {
    results.push(...(must(await admin.from("chat_channels").select(CHANNEL_COLS).in("id", part), "channels") ?? []));
  }
  const seen = new Set<string>();
  return results
    .map(toChannel)
    .filter((c) => {
      if (seen.has(c.id)) return false;
      seen.add(c.id);
      return canReadChannel(c, viewer, false);
    });
}

/** Explicit members of channels, keyed by channel. */
export async function listMembers(channelIds: readonly string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  const admin = createAdminClient();
  for (const part of chunks(Array.from(new Set(channelIds)))) {
    const rows = (must(await admin.from("chat_members").select("channel_id, user_id").in("channel_id", part), "members") ?? []) as any[];
    for (const r of rows) {
      const list = out.get(r.channel_id) ?? [];
      list.push(r.user_id);
      out.set(r.channel_id, list);
    }
  }
  return out;
}

type ReadRow = {
  channel_id: string;
  last_read_at: string;
  seen_at: string | null;
  notify: NotifyPref | null;
  hidden_at: string | null;
};

export async function getReads(userId: string, channelIds: readonly string[]): Promise<Map<string, ReadRow>> {
  const out = new Map<string, ReadRow>();
  const admin = createAdminClient();
  for (const part of chunks(channelIds)) {
    const rows = (must(
      await admin
        .from("chat_reads")
        .select("channel_id, last_read_at, seen_at, notify, hidden_at")
        .eq("user_id", userId)
        .in("channel_id", part),
      "read state",
    ) ?? []) as ReadRow[];
    for (const r of rows) out.set(r.channel_id, r);
  }
  return out;
}

export async function getUnreadCounts(
  userId: string,
  channelIds: readonly string[],
): Promise<Map<string, { unread: number; mentions: number }>> {
  const out = new Map<string, { unread: number; mentions: number }>();
  if (channelIds.length === 0) return out;
  const admin = createAdminClient();
  for (const part of chunks(channelIds, 500)) {
    const rows = (must(
      await admin.rpc("chat_unread", { p_uid: userId, p_channel_ids: part }),
      "unread counts",
    ) ?? []) as { channel_id: string; unread: number; mentions: number }[];
    for (const r of rows) out.set(r.channel_id, { unread: r.unread ?? 0, mentions: r.mentions ?? 0 });
  }
  return out;
}

export type SidebarData = {
  channels: SidebarItem[];
  conversations: SidebarItem[];
  people: Record<string, ChatPerson>;
  /** People the viewer has blocked: their messages collapse in channels and groups. */
  blocked: string[];
};

/**
 * The left rail: text channels in their order, then DMs and groups by most
 * recent. Archived channels and closed conversations are left out (a direct
 * link still opens them).
 */
export async function buildSidebar(viewer: ChatViewer): Promise<SidebarData> {
  const all = await listReadableChannels(viewer);
  const live = all.filter((c) => c.kind !== "channel" || !c.archivedAt);
  const ids = live.map((c) => c.id);
  const groupIds = live.filter((c) => c.kind === "group").map((c) => c.id);
  const [reads, counts, members, blocked] = await Promise.all([
    getReads(viewer.userId, ids),
    getUnreadCounts(viewer.userId, ids),
    listMembers(groupIds),
    listBlockedIds(viewer.userId),
  ]);

  const personIds = new Set<string>();
  for (const c of live) {
    if (c.kind === "dm") {
      const other = otherInDmKey(c.dmKey, viewer.userId);
      if (other) personIds.add(other);
    }
    if (c.kind === "group") for (const id of members.get(c.id) ?? []) personIds.add(id);
  }
  const people = await getPeople(Array.from(personIds));

  const channels: SidebarItem[] = [];
  const conversations: SidebarItem[] = [];
  for (const c of live) {
    const read = reads.get(c.id);
    const count = counts.get(c.id) ?? { unread: 0, mentions: 0 };
    const memberIds = c.kind === "group" ? (members.get(c.id) ?? []) : [];
    let otherId: string | null = null;
    let label = c.name ?? "channel";
    if (c.kind === "dm") {
      otherId = otherInDmKey(c.dmKey, viewer.userId);
      // A DM key that doesn't name the viewer as one side: a legacy DM whose
      // other account was deleted. The viewer is its only member.
      label = otherId ? (people.get(otherId)?.name ?? DELETED_NAME) : DELETED_NAME;
      if (otherId && !people.has(otherId)) otherId = null;
    } else if (c.kind === "group") {
      label = groupDisplayName(
        c.name,
        memberIds.map((id) => ({ id, name: people.get(id)?.name ?? DELETED_NAME })),
        viewer.userId,
      );
    }
    const item: SidebarItem = {
      id: c.id,
      kind: c.kind,
      label,
      topic: c.topic,
      audience: c.audience,
      posting: c.posting,
      systemKey: c.systemKey,
      teamId: c.teamId,
      cohortId: c.cohortId,
      otherId,
      memberIds,
      lastMessageAt: c.lastMessageAt,
      preview:
        c.kind === "channel" || !c.lastMessagePreview
          ? null
          : plainText(c.lastMessagePreview, (id) => people.get(id)?.name, () => null, 80),
      unread: count.unread,
      mentions: c.kind === "channel" ? count.mentions : count.unread,
      notify: read?.notify ?? null,
      position: c.position,
    };
    if (c.kind === "channel") channels.push(item);
    else if (isConversationVisible(read?.hidden_at ?? null, c.lastMessageAt)) conversations.push(item);
  }
  channels.sort((a, b) => compareChannels({ ...a, name: a.label }, { ...b, name: b.label }));
  conversations.sort((a, b) => compareConversations({ ...a, name: a.label }, { ...b, name: b.label }));
  return { channels, conversations, people: Object.fromEntries(people), blocked };
}

/** How many things want the viewer's attention: DM/group unread plus channel mentions. */
export async function countAttention(viewer: ChatViewer): Promise<number> {
  const all = (await listReadableChannels(viewer)).filter((c) => !c.archivedAt || c.kind !== "channel");
  const ids = all.map((c) => c.id);
  const [counts, reads] = await Promise.all([getUnreadCounts(viewer.userId, ids), getReads(viewer.userId, ids)]);
  let n = 0;
  for (const c of all) {
    const k = counts.get(c.id);
    if (!k) continue;
    const read = reads.get(c.id);
    n += attentionFor(c.kind, k, read?.notify ?? null, isConversationVisible(read?.hidden_at ?? null, c.lastMessageAt));
  }
  return n;
}

// ---------------------------------------------------------------------------
// Who is in a channel
// ---------------------------------------------------------------------------

const MEMBER_LIST_MAX = 300;

/**
 * Everyone who can read a channel, as people — the member list, and the
 * mention autocomplete. Capped; for #general at batch0's size it's everyone.
 * Staff are included on every text channel because they can read them all.
 */
export async function listChannelPeople(channel: ChannelRow): Promise<ChatPerson[]> {
  const ids = await listChannelAudienceIds(channel, MEMBER_LIST_MAX);
  const people = await getPeople(ids);
  return Array.from(people.values()).sort((a, b) => a.name.localeCompare(b.name));
}

/** The ids of everyone who can read a channel (bells for @everyone use it too). */
export async function listChannelAudienceIds(channel: ChannelRow, limit = 5000): Promise<string[]> {
  const admin = createAdminClient();
  const ids = new Set<string>();
  const explicit = (await listMembers([channel.id])).get(channel.id) ?? [];
  for (const id of explicit) ids.add(id);
  if (channel.kind !== "channel") return Array.from(ids);

  const staffSlugs = await staffRoleSlugs();
  if (staffSlugs.length) {
    const staff = (must(await admin.from("profiles").select("id").in("role", staffSlugs).limit(limit), "staff") ?? []) as any[];
    for (const r of staff) ids.add(r.id);
  }
  switch (channel.audience) {
    case "cohort": {
      const rows = (must(await admin.from("enrollments").select("user_id").eq("cohort_id", channel.cohortId!).limit(limit), "enrollments") ?? []) as any[];
      for (const r of rows) ids.add(r.user_id);
      break;
    }
    case "team": {
      const rows = (must(await admin.from("team_members").select("user_id").eq("team_id", channel.teamId!).limit(limit), "team") ?? []) as any[];
      for (const r of rows) ids.add(r.user_id);
      for (const id of await teamMentorIds(channel.teamId!)) ids.add(id);
      break;
    }
    case "everyone": {
      const [nonStudents, enrolled, accepted] = await Promise.all([
        admin.from("profiles").select("id").neq("role", "student").limit(limit),
        admin.from("enrollments").select("user_id").limit(limit),
        admin.from("applications").select("user_id").in("status", ACCEPTED_STATUSES as unknown as string[]).limit(limit),
      ]);
      for (const r of (must(nonStudents, "people") ?? []) as any[]) ids.add(r.id);
      for (const r of (must(enrolled, "enrollments") ?? []) as any[]) ids.add(r.user_id);
      for (const r of (must(accepted, "applications") ?? []) as any[]) ids.add(r.user_id);
      break;
    }
    default:
      break;
  }
  return Array.from(ids).slice(0, limit);
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

async function attachReplies(rows: any[]): Promise<ChatMessage[]> {
  const replyIds = Array.from(new Set(rows.map((r) => r.reply_to_id).filter(isUuid)));
  const replies = new Map<string, ReplyPreview>();
  if (replyIds.length) {
    const admin = createAdminClient();
    for (const part of chunks(replyIds)) {
      const found = (must(
        await admin.from("chat_messages").select("id, sender_id, body, attachments, deleted_at").in("id", part),
        "replies",
      ) ?? []) as any[];
      for (const r of found) {
        replies.set(r.id, {
          id: r.id,
          senderId: r.sender_id ?? null,
          // Mentions stay as <@id> here; the client resolves names.
          preview: r.deleted_at ? "" : r.body ? r.body.slice(0, 300) : toAttachments(r.attachments).length ? "[attachment]" : "",
          deleted: !!r.deleted_at,
        });
      }
    }
  }
  return rows.map((r) =>
    toMessage(
      r,
      r.reply_to_id
        ? (replies.get(r.reply_to_id) ?? { id: r.reply_to_id, senderId: null, preview: "", deleted: true })
        : null,
    ),
  );
}

export const PAGE_SIZE = 50;

/**
 * A page of messages in posting order: the newest PAGE_SIZE, or the ones
 * before `before`, or a window around one message (a search hit, a pin).
 * Deleted messages are left out. Only call after getChannelForViewer().
 */
export async function listMessages(
  channelId: string,
  opts: { before?: string; around?: string; limit?: number } = {},
): Promise<{ messages: ChatMessage[]; hasMoreBefore: boolean; hasMoreAfter: boolean }> {
  const admin = createAdminClient();
  const limit = Math.min(Math.max(opts.limit ?? PAGE_SIZE, 1), 100);
  const base = () => admin.from("chat_messages").select(MESSAGE_COLS).eq("channel_id", channelId).is("deleted_at", null);

  if (opts.around && isUuid(opts.around)) {
    const target = must(
      await admin.from("chat_messages").select("created_at").eq("id", opts.around).eq("channel_id", channelId).maybeSingle(),
      "the message",
    ) as { created_at: string } | null;
    if (target) {
      const half = Math.floor(limit / 2);
      const [older, newer] = await Promise.all([
        base().lte("created_at", target.created_at).order("created_at", { ascending: false }).order("id", { ascending: false }).limit(half + 1),
        base().gt("created_at", target.created_at).order("created_at", { ascending: true }).limit(half + 1),
      ]);
      const o = (must(older, "messages") ?? []) as any[];
      const n = (must(newer, "messages") ?? []) as any[];
      const rows = [...o.slice(0, half).reverse(), ...n.slice(0, half)];
      return { messages: await attachReplies(rows), hasMoreBefore: o.length > half, hasMoreAfter: n.length > half };
    }
  }

  let q = base();
  if (opts.before) q = q.lt("created_at", opts.before);
  const rows = (must(
    await q.order("created_at", { ascending: false }).order("id", { ascending: false }).limit(limit + 1),
    "messages",
  ) ?? []) as any[];
  const page = rows.slice(0, limit).reverse();
  return { messages: await attachReplies(page), hasMoreBefore: rows.length > limit, hasMoreAfter: false };
}

export async function getMessageRow(id: string): Promise<any | null> {
  if (!isUuid(id)) return null;
  return must(
    await createAdminClient().from("chat_messages").select(MESSAGE_COLS + ", deleted_by, pinned_by").eq("id", id).maybeSingle(),
    "the message",
  );
}

export async function getMessages(ids: readonly string[]): Promise<ChatMessage[]> {
  const rows: any[] = [];
  const admin = createAdminClient();
  for (const part of chunks(ids.filter(isUuid))) {
    rows.push(...((must(await admin.from("chat_messages").select(MESSAGE_COLS).in("id", part), "messages") ?? []) as any[]));
  }
  return attachReplies(rows.filter((r) => !r.deleted_at));
}

export async function listPins(channelId: string): Promise<ChatMessage[]> {
  const rows = (must(
    await createAdminClient()
      .from("chat_messages")
      .select(MESSAGE_COLS)
      .eq("channel_id", channelId)
      .is("deleted_at", null)
      .not("pinned_at", "is", null)
      .order("pinned_at", { ascending: false })
      .limit(50),
    "pins",
  ) ?? []) as any[];
  return attachReplies(rows);
}

/**
 * Search the channels the viewer can read (or one of them). Plain substring
 * match, newest first: at batch0's size that's instant, and nobody has to
 * learn a query language.
 */
export async function searchMessages(
  viewer: ChatViewer,
  query: string,
  channelId?: string | null,
): Promise<ChatMessage[]> {
  const q = query.trim().replace(/[%_\\]/g, (c) => `\\${c}`);
  if (q.length < 2) return [];
  const channels = await listReadableChannels(viewer);
  const ids = channelId ? channels.filter((c) => c.id === channelId).map((c) => c.id) : channels.map((c) => c.id);
  if (ids.length === 0) return [];
  const admin = createAdminClient();
  const rows: any[] = [];
  for (const part of chunks(ids)) {
    rows.push(
      ...((must(
        await admin
          .from("chat_messages")
          .select(MESSAGE_COLS)
          .in("channel_id", part)
          .is("deleted_at", null)
          .eq("kind", "message")
          .ilike("body", `%${q}%`)
          .order("created_at", { ascending: false })
          .limit(40),
        "search",
      ) ?? []) as any[]),
    );
  }
  rows.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  return attachReplies(rows.slice(0, 40));
}

/** When this person last posted in this channel — slow mode's clock. */
export async function lastSentAt(channelId: string, userId: string): Promise<string | null> {
  const row = must(
    await createAdminClient()
      .from("chat_messages")
      .select("created_at")
      .eq("channel_id", channelId)
      .eq("sender_id", userId)
      .eq("kind", "message")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    "your last message",
  ) as { created_at: string } | null;
  return row?.created_at ?? null;
}

// ---------------------------------------------------------------------------
// Who can reach whom (DMs and groups)
//
// Signing up is instant and unverified, and most accounts belong to high
// schoolers, so the open graph is open to people who have been LET IN — the
// 0089 rule, unchanged:
//   staff reach, and are reachable by, everyone (an applicant can always ask
//   the team); vetted people reach each other; a fresh signup reaches staff
//   only and is listed in nobody else's directory. An existing conversation is
//   never cut off by this: someone the team wrote to can always reply.
// ---------------------------------------------------------------------------

export async function canStartConversation(
  actor: ChatViewer,
  recipient: ChatPerson,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (actor.staff || recipient.isStaff) return { ok: true };
  const me = await getPerson(actor.userId);
  if (me && !conversationAllowed([asParty(me), asParty(recipient)])) {
    return { ok: false, reason: SAFEGUARD_REASON };
  }
  if (!actor.vetted) {
    return {
      ok: false,
      reason: "For now you can message the batch0 team. Messaging other people opens once you've been accepted.",
    };
  }
  const vetted = await vettedIds([recipient.id]);
  if (!vetted.has(recipient.id)) return { ok: false, reason: "That person isn't available." };
  return { ok: true };
}

/**
 * The directory for a new DM or group: by name, scoped to who the viewer may
 * reach. Never lists anyone on either side of a block (showing someone who
 * blocked you and then failing would announce it), and matches email only
 * for staff (a student typing a guessed address must not get a confirming hit).
 */
export async function searchDirectory(query: string, viewer: ChatViewer, limit = 20): Promise<ChatPerson[]> {
  const q = query.trim();
  const admin = createAdminClient();
  const hidden = new Set<string>([viewer.userId, ...(await listBlockRelatedIds(viewer.userId))]);
  const escaped = q.replace(/[%,()"\\*]/g, " ").trim();
  if (q && !escaped) return [];

  const byName = (req: any) => {
    if (!escaped) return req;
    return viewer.staff
      ? req.or(`full_name.ilike.%${escaped}%,email.ilike.%${escaped}%`)
      : req.ilike("full_name", `%${escaped}%`);
  };
  const base = () => admin.from("profiles").select("id, full_name, role");
  const pageSize = limit + hidden.size + 10;

  let rows: any[] = [];
  if (viewer.staff) {
    rows = must(await byName(base()).order("full_name", { ascending: true }).limit(pageSize), "people") ?? [];
  } else if (!viewer.vetted) {
    const staff = await staffRoleSlugs();
    rows = staff.length
      ? (must(await byName(base().in("role", staff)).order("full_name", { ascending: true }).limit(pageSize), "people") ?? [])
      : [];
  } else {
    const nonStudents: any[] =
      must(await byName(base().neq("role", "student")).order("full_name", { ascending: true }).limit(pageSize), "people") ?? [];
    const joined = (table: "enrollments" | "applications") => {
      let req: any = admin
        .from(table)
        .select(`profile:profiles!${table}_user_id_fkey!inner(id, full_name, role)`)
        .eq("profile.role", "student");
      if (table === "applications") req = req.in("status", ACCEPTED_STATUSES as unknown as string[]);
      if (escaped) req = req.ilike("profile.full_name", `%${escaped}%`);
      return req.limit(pageSize * 3);
    };
    const [enr, apps] = await Promise.all([joined("enrollments"), joined("applications")]);
    const students = [...((must(enr, "people") ?? []) as any[]), ...((must(apps, "people") ?? []) as any[])]
      .map((r) => (Array.isArray(r.profile) ? r.profile[0] : r.profile))
      .filter(Boolean);
    rows = [...nonStudents, ...students].sort((a, b) =>
      String(a.full_name ?? "").localeCompare(String(b.full_name ?? "")),
    );
  }

  const seen = new Set<string>();
  const candidates = await toPeople(
    rows.filter((r: any) => {
      if (hidden.has(r.id) || seen.has(r.id)) return false;
      seen.add(r.id);
      return true;
    }),
  );
  // Nobody the safeguarding rule wouldn't let the viewer DM: offering them
  // and then refusing would only confuse.
  const me = viewer.staff ? null : await getPerson(viewer.userId);
  return candidates
    .filter((p) => !me || conversationAllowed([asParty(me), asParty(p)]))
    .slice(0, limit);
}

/** The DM between two people, if there is one. */
export async function findDm(dmKeyValue: string): Promise<ChannelRow | null> {
  const data = must(
    await createAdminClient().from("chat_channels").select(CHANNEL_COLS).eq("dm_key", dmKeyValue).maybeSingle(),
    "the conversation",
  );
  return data ? toChannel(data) : null;
}

// ---------------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------------

export async function listBlockedIds(userId: string): Promise<string[]> {
  const data = must(
    await createAdminClient().from("chat_blocks").select("blocked_id").eq("blocker_id", userId),
    "blocks",
  );
  return (data ?? []).map((r: any) => r.blocked_id as string);
}

/** Everyone on either side of a block with this user. Never surfaced as two lists. */
export async function listBlockRelatedIds(userId: string): Promise<string[]> {
  const data = must(
    await createAdminClient()
      .from("chat_blocks")
      .select("blocker_id, blocked_id")
      .or(`blocker_id.eq.${userId},blocked_id.eq.${userId}`),
    "blocks",
  );
  const ids = new Set<string>();
  for (const r of (data ?? []) as any[]) ids.add(r.blocker_id === userId ? r.blocked_id : r.blocker_id);
  return Array.from(ids);
}

/** Symmetric, and fails closed: an error throws rather than reading as "not blocked". */
export async function isBlockedBetween(x: string, y: string): Promise<boolean> {
  const data = must(
    await createAdminClient()
      .from("chat_blocks")
      .select("blocker_id")
      .or(`and(blocker_id.eq.${x},blocked_id.eq.${y}),and(blocker_id.eq.${y},blocked_id.eq.${x})`)
      .limit(1),
    "blocks",
  );
  return (data ?? []).length > 0;
}

export async function listBlockedPeople(userId: string): Promise<ChatPerson[]> {
  const ids = await listBlockedIds(userId);
  if (ids.length === 0) return [];
  const map = await getPeople(ids);
  return ids.map((id) => map.get(id)).filter((p): p is ChatPerson => !!p);
}

// ---------------------------------------------------------------------------
// Moderation (callers hold chat.manage)
// ---------------------------------------------------------------------------

export type ReportStatus = "open" | "actioned" | "dismissed";

export type ChatReport = {
  id: string;
  channelId: string;
  /** Who it's about — never shown to them (reportVisibleTo). */
  partyIds: string[];
  messageId: string | null;
  reporterId: string | null;
  reporterName: string;
  reason: string;
  status: ReportStatus;
  reviewedBy: string | null;
  reviewedAt: string | null;
  createdAt: string;
};

const REPORT_COLS = "id, channel_id, message_id, reporter_id, reason, status, reviewed_by, reviewed_at, party_ids, created_at";

async function hydrateReports(rows: any[]): Promise<ChatReport[]> {
  const people = await getPeople(rows.map((r) => r.reporter_id));
  return rows.map((r) => ({
    id: r.id,
    channelId: r.channel_id,
    partyIds: Array.isArray(r.party_ids) ? r.party_ids : [],
    messageId: r.message_id ?? null,
    reporterId: r.reporter_id ?? null,
    reporterName: r.reporter_id ? (people.get(r.reporter_id)?.name ?? DELETED_NAME) : DELETED_NAME,
    reason: r.reason,
    status: r.status,
    reviewedBy: r.reviewed_by ?? null,
    reviewedAt: r.reviewed_at ?? null,
    createdAt: r.created_at,
  }));
}

async function channelKinds(ids: readonly string[]): Promise<Map<string, ChannelKind>> {
  const out = new Map<string, ChannelKind>();
  const admin = createAdminClient();
  for (const part of chunks(Array.from(new Set(ids)))) {
    const rows = (must(await admin.from("chat_channels").select("id, kind").in("id", part), "channels") ?? []) as any[];
    for (const r of rows) out.set(r.id, r.kind);
  }
  return out;
}

/** Drop the reports this moderator may not see (reportVisibleTo). */
async function visibleReports(viewer: ChatViewer, rows: any[]): Promise<ChatReport[]> {
  const kinds = await channelKinds(rows.map((r) => r.channel_id));
  const keep = rows.filter((r) => {
    const kind = kinds.get(r.channel_id);
    return !!kind && reportVisibleTo({ channelId: r.channel_id, partyIds: r.party_ids ?? [] }, kind, viewer);
  });
  return hydrateReports(keep);
}

/**
 * The queue, minus every report about the moderator looking at it: who
 * reported them, and why, is exactly what the person reported must not learn.
 */
export async function listReports(viewer: ChatViewer, status: ReportStatus | "all" = "open"): Promise<ChatReport[]> {
  let q = createAdminClient().from("chat_reports").select(REPORT_COLS);
  if (status !== "all") q = q.eq("status", status);
  const rows = (must(await q.order("created_at", { ascending: false }).limit(300), "reports") ?? []) as any[];
  return visibleReports(viewer, rows);
}

/** One report, or null when it doesn't exist OR it's about this viewer — the same answer. */
export async function getReport(id: string, viewer: ChatViewer): Promise<ChatReport | null> {
  if (!isUuid(id)) return null;
  const row = must(await createAdminClient().from("chat_reports").select(REPORT_COLS).eq("id", id).maybeSingle(), "the report");
  return row ? ((await visibleReports(viewer, [row]))[0] ?? null) : null;
}

export async function listReportsForChannel(channelId: string, viewer: ChatViewer): Promise<ChatReport[]> {
  const rows = (must(
    await createAdminClient().from("chat_reports").select(REPORT_COLS).eq("channel_id", channelId).order("created_at", { ascending: false }),
    "reports",
  ) ?? []) as any[];
  return visibleReports(viewer, rows);
}

export async function countOpenReports(viewer: ChatViewer): Promise<number> {
  try {
    return (await listReports(viewer, "open")).length;
  } catch (err) {
    if (isMissingSchemaError(err)) return 0;
    throw err;
  }
}

/** What a reported message said, including every version before an edit or delete. */
export async function listRevisions(messageId: string): Promise<{ body: string; reason: string; createdAt: string; attachments: ChatAttachment[] }[]> {
  const rows = (must(
    await createAdminClient()
      .from("chat_message_revisions")
      .select("body, reason, created_at, attachments")
      .eq("message_id", messageId)
      .order("created_at", { ascending: true }),
    "revisions",
  ) ?? []) as any[];
  return rows.map((r) => ({ body: r.body, reason: r.reason, createdAt: r.created_at, attachments: toAttachments(r.attachments) }));
}

/** A moderator's transcript: deleted messages included, with what they said. */
export async function listTranscript(channelId: string, limit = 300): Promise<(ChatMessage & { deletedAt: string | null; original: string | null })[]> {
  const admin = createAdminClient();
  const rows = (must(
    await admin
      .from("chat_messages")
      .select(MESSAGE_COLS)
      .eq("channel_id", channelId)
      .order("created_at", { ascending: false })
      .limit(limit),
    "the transcript",
  ) ?? []) as any[];
  const page = rows.reverse();
  const deletedIds = page.filter((r) => r.deleted_at).map((r) => r.id);
  const originals = new Map<string, string>();
  for (const part of chunks(deletedIds)) {
    const revs = (must(
      await admin.from("chat_message_revisions").select("message_id, body, created_at").in("message_id", part).order("created_at", { ascending: true }),
      "revisions",
    ) ?? []) as any[];
    for (const r of revs) originals.set(r.message_id, r.body);
  }
  const messages = await attachReplies(page);
  return messages.map((m, i) => ({
    ...m,
    deletedAt: page[i].deleted_at ?? null,
    original: page[i].deleted_at ? (originals.get(m.id) ?? null) : null,
  }));
}

/** Everyone who should hear about a new report. */
export async function listModeratorIds(): Promise<string[]> {
  const slugs = await staffRoleSlugs();
  if (slugs.length === 0) return [];
  const { data } = await createAdminClient().from("profiles").select("id").in("role", slugs).limit(500);
  return (data ?? []).map((p: any) => p.id as string);
}

/** Does this user owe a fine? A fined account may only message the team. */
export async function hasPendingFine(userId: string): Promise<boolean> {
  const data = must(
    await createAdminClient()
      .from("user_charges")
      .select("id")
      .eq("user_id", userId)
      .eq("kind", "fine")
      .eq("status", "pending")
      .limit(1),
    "charges",
  );
  return (data ?? []).length > 0;
}

/** Every channel, for the admin page (archived included). */
export async function listAllChannels(): Promise<ChannelRow[]> {
  const rows = (must(
    await createAdminClient().from("chat_channels").select(CHANNEL_COLS).eq("kind", "channel").order("position").order("name").limit(2000),
    "channels",
  ) ?? []) as any[];
  return rows.map(toChannel);
}

export { DELETED_NAME };

/**
 * Of these people, who can read this channel — so a mention can only ever
 * ping someone who'll see it, and a typed <@id> for a stranger is just text.
 */
export async function filterReaders(channel: ChannelRow, ids: readonly string[]): Promise<string[]> {
  return readersAmong(channel, Array.from(new Set(ids.filter(isUuid))).slice(0, 50));
}

/**
 * Which of these people can read the channel right now — no cap, chunked, so
 * it can vet a whole "All messages" list. Same answer as canReadChannel for
 * each of them, minus the report path (a bell never rides that).
 */
export async function readersAmong(channel: ChannelRow, ids: readonly string[]): Promise<string[]> {
  const wanted = Array.from(new Set(ids.filter(isUuid)));
  if (wanted.length === 0) return [];
  const admin = createAdminClient();
  const explicit = new Set((await listMembers([channel.id])).get(channel.id) ?? []);
  if (channel.kind !== "channel") return wanted.filter((id) => explicit.has(id));

  const staffSlugs = new Set(await staffRoleSlugs());
  const ok = new Set<string>();
  const rest: string[] = [];
  for (const part of chunks(wanted)) {
    const profiles = (must(await admin.from("profiles").select("id, role").in("id", part), "people") ?? []) as any[];
    for (const p of profiles) {
      if (explicit.has(p.id) || staffSlugs.has(p.role)) ok.add(p.id);
      else rest.push(p.id);
    }
  }
  if (rest.length) {
    if (channel.audience === "everyone") {
      for (const id of await vettedIds(rest)) ok.add(id);
    } else if (channel.audience === "cohort" && channel.cohortId) {
      for (const part of chunks(rest)) {
        const rows = (must(await admin.from("enrollments").select("user_id").eq("cohort_id", channel.cohortId).in("user_id", part), "enrollments") ?? []) as any[];
        for (const r of rows) ok.add(r.user_id);
      }
    } else if (channel.audience === "team" && channel.teamId) {
      for (const part of chunks(rest)) {
        const rows = (must(await admin.from("team_members").select("user_id").eq("team_id", channel.teamId).in("user_id", part), "team") ?? []) as any[];
        for (const r of rows) ok.add(r.user_id);
      }
      const left = rest.filter((id) => !ok.has(id));
      if (left.length) for (const id of await teamMentorIds(channel.teamId, left)) ok.add(id);
    }
  }
  return wanted.filter((id) => ok.has(id));
}
