import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { getAllRoles } from "@/lib/roles";
import { ACCEPTED_STATUSES } from "@/lib/pre-cohort";
import { can, type Capabilities } from "@/lib/permissions";
import { isMissingSchemaError } from "@/lib/schema-ready";
import { clientIdsReady } from "@/lib/chat-send";
import {
  attentionFor,
  canReadChannel,
  channelReportsOpenTo,
  compareChannels,
  compareConversations,
  groupDisplayName,
  isConversationVisible,
  isUuid,
  muteActive,
  otherInDmKey,
  PEOPLE_SEARCH_MAX,
  REPORTABLE_DELETED_MS,
  reportVisibleTo,
  sidebarMentions,
  type Audience,
  type ChannelKind,
  type ChannelScope,
  type ChatViewer,
  type NotifyPref,
  type Posting,
  type ReactionMap,
  type Party,
  conversationAllowed,
  directoryOffers,
  dmVerdict,
  reachVerdict,
} from "@/lib/chat-access";
import { cutBody, plainText } from "@/lib/chat-format";
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
 *
 * PostgREST answers at most max-rows rows (1000 on Supabase) and says nothing
 * when it stops. Every read that can outgrow that pages (pageAll) or is
 * chunked so a chunk can't: a list that silently loses its tail would drop
 * someone's DMs, @everyone bells or channels without an error.
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
  /**
   * The replied-to message's mentions, as the server vetted them when it was
   * sent: the only <@id>s in `preview` that get a name.
   */
  mentions?: string[];
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
  /**
   * The id the sender's composer gave it (0104), the same on every retry:
   * how the sending screen knows the server's copy for the bubble it already
   * shows. Absent on rows from before 0104, system lines and posts made
   * elsewhere, and on every read before 0104 runs.
   */
  clientId?: string;
};

/**
 * A text channel's deleted message as a report target: who sent it and
 * when (posted, and deleted — Realtime already tells every reader when), never
 * what it said or who deleted it. Its words and files stay in
 * chat_message_revisions, which only a moderator the report leaves out reads
 * (the report page).
 */
export type DeletedMessageStub = { id: string; senderId: string; createdAt: string; deletedAt: string };

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
  /** The number on the row (sidebarMentions): a channel's mentions; a conversation's unread, or its mentions on "Only @mentions". */
  mentions: number;
  notify: NotifyPref | null;
  position: number;
};

const CHANNEL_COLS =
  "id, kind, name, topic, audience, cohort_id, team_id, posting, slowmode_seconds, position, system_key, dm_key, created_by, archived_at, last_message_at, last_message_preview, last_sender_id, message_count, created_at";

const MESSAGE_COLS =
  "id, channel_id, sender_id, body, kind, reply_to_id, mentions, mention_everyone, attachments, reactions, created_at, edited_at, deleted_at, pinned_at";

type DbError = { message: string; code?: string } | null;

/** A failed read throws: an outage must never render as "nothing here" (or "nobody blocked you"). */
function must<T>(res: { data: T | null; error: DbError }, what: string): T | null {
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

/** Supabase's default max-rows. A page this long means there may be more. */
const PAGE_ROWS = 1000;

/**
 * Every row a query matches, a page at a time. `build` must order by a
 * unique key, or rows can repeat or go missing between pages.
 */
export async function pageAll<T>(
  build: (from: number, to: number) => PromiseLike<{ data: unknown; error: DbError }>,
  what: string,
): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += PAGE_ROWS) {
    const page = (must(await build(from, from + PAGE_ROWS - 1), what) ?? []) as T[];
    out.push(...page);
    if (page.length < PAGE_ROWS) return out;
  }
}

const uniq = <T,>(xs: Iterable<T>): T[] => Array.from(new Set(xs));

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

export function toAttachments(raw: unknown): ChatAttachment[] {
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
    ...(typeof r.client_id === "string" ? { clientId: r.client_id } : {}),
  };
}

/**
 * The columns a page of messages for the screen reads: MESSAGE_COLS, plus
 * 0104's client_id once the database has it (lib/chat-send.ts).
 */
async function screenMessageCols(): Promise<string> {
  return (await clientIdsReady()) ? `${MESSAGE_COLS}, client_id` : MESSAGE_COLS;
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
  const real = uniq(ids.filter(isUuid).map((id) => id.toLowerCase()));
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
  return (await getPeople([id])).get(id.toLowerCase()) ?? null;
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
 * Of these profiles, who has been let in: a non-student role, or a student
 * with an enrollment or an accepted application. Mirrors chat_is_vetted() in
 * 0101. Asked per person, never by loading every enrollment.
 */
async function vettedAmong(rows: readonly { id: string; role: string | null }[]): Promise<Set<string>> {
  const out = new Set<string>();
  const students: string[] = [];
  for (const r of rows) {
    if (r.role && r.role !== "student") out.add(r.id);
    else students.push(r.id);
  }
  if (students.length === 0) return out;
  const admin = createAdminClient();
  await Promise.all(
    chunks(uniq(students)).map(async (part) => {
      const [enr, apps] = await Promise.all([
        pageAll<{ user_id: string }>(
          (from, to) => admin.from("enrollments").select("user_id").in("user_id", part).order("id").range(from, to),
          "enrollments",
        ),
        pageAll<{ user_id: string }>(
          (from, to) =>
            admin
              .from("applications")
              .select("user_id")
              .in("user_id", part)
              .in("status", ACCEPTED_STATUSES as unknown as string[])
              .order("id")
              .range(from, to),
          "applications",
        ),
      ]);
      for (const r of enr) out.add(r.user_id);
      for (const r of apps) out.add(r.user_id);
    }),
  );
  return out;
}

/** vettedAmong, for ids. */
export async function vettedIds(ids: readonly string[]): Promise<Set<string>> {
  const unique = uniq(ids.filter(isUuid).map((id) => id.toLowerCase()));
  if (unique.length === 0) return new Set();
  const admin = createAdminClient();
  const rows = (
    await Promise.all(
      chunks(unique).map(
        async (part) =>
          (must(await admin.from("profiles").select("id, role").in("id", part), "people") ?? []) as {
            id: string;
            role: string | null;
          }[],
      ),
    )
  ).flat();
  return vettedAmong(rows);
}

// ---------------------------------------------------------------------------
// The viewer
// ---------------------------------------------------------------------------

/** Everything the rules need about this person, resolved in one parallel batch. */
export async function getChatViewer(userId: string, caps: Capabilities | null): Promise<ChatViewer> {
  const admin = createAdminClient();
  const [vetted, enrolled, teams, mentored, members] = await Promise.all([
    vettedIds([userId]),
    pageAll<{ cohort_id: string }>(
      (from, to) => admin.from("enrollments").select("cohort_id").eq("user_id", userId).order("id").range(from, to),
      "enrollments",
    ),
    pageAll<{ team_id: string }>(
      (from, to) => admin.from("team_members").select("team_id").eq("user_id", userId).order("id").range(from, to),
      "teams",
    ),
    mentoredScopes(userId),
    // Staff collect a DM with every applicant who writes in: thousands of
    // rows, every one of them a conversation they must still be able to open.
    pageAll<{ channel_id: string }>(
      (from, to) =>
        admin.from("chat_members").select("channel_id").eq("user_id", userId).order("channel_id").range(from, to),
      "channels",
    ),
  ]);
  return {
    userId,
    staff: can(caps, "chat.manage"),
    vetted: vetted.has(userId),
    cohortIds: uniq([...enrolled.map((r) => r.cohort_id), ...mentored.cohortIds]),
    teamIds: uniq([...teams.map((r) => r.team_id), ...mentored.teamIds]),
    memberOf: members.map((r) => r.channel_id),
  };
}

/**
 * The teams and cohorts a mentor's assigned students are on and enrolled
 * in. Their channels open to the mentor, the way the Discord sync used to
 * grant — derived on every read, so assigning or moving someone needs no
 * resync. Mirrors the mentor_assignments clauses of chat_can_read() in 0101.
 */
export async function mentoredScopes(mentorId: string): Promise<{ teamIds: string[]; cohortIds: string[] }> {
  const admin = createAdminClient();
  const students = uniq(
    (
      await pageAll<{ student_id: string }>(
        (from, to) =>
          admin.from("mentor_assignments").select("student_id").eq("mentor_id", mentorId).order("id").range(from, to),
        "mentor assignments",
      )
    ).map((r) => r.student_id),
  );
  const teamIds = new Set<string>();
  const cohortIds = new Set<string>();
  await Promise.all(
    chunks(students).map(async (part) => {
      const [teams, enrolled] = await Promise.all([
        pageAll<{ team_id: string }>(
          (from, to) => admin.from("team_members").select("team_id").in("user_id", part).order("id").range(from, to),
          "teams",
        ),
        pageAll<{ cohort_id: string }>(
          (from, to) => admin.from("enrollments").select("cohort_id").in("user_id", part).order("id").range(from, to),
          "enrollments",
        ),
      ]);
      for (const r of teams) teamIds.add(r.team_id);
      for (const r of enrolled) cohortIds.add(r.cohort_id);
    }),
  );
  return { teamIds: Array.from(teamIds), cohortIds: Array.from(cohortIds) };
}

/**
 * Mentors assigned to anyone among these students (or only those of
 * `among`, when given): the mentor half of a team or cohort channel's
 * audience.
 */
async function mentorsOf(students: readonly string[], among?: readonly string[]): Promise<string[]> {
  if (students.length === 0 || (among && among.length === 0)) return [];
  const admin = createAdminClient();
  const wanted = among ? new Set(among) : null;
  const out = new Set<string>();
  await Promise.all(
    chunks(uniq(students)).map(async (part) => {
      const rows = await pageAll<{ mentor_id: string }>(
        (from, to) => admin.from("mentor_assignments").select("mentor_id").in("student_id", part).order("id").range(from, to),
        "mentor assignments",
      );
      for (const r of rows) if (!wanted || wanted.has(r.mentor_id)) out.add(r.mentor_id);
    }),
  );
  return Array.from(out);
}

async function teamMemberIds(teamId: string): Promise<string[]> {
  const admin = createAdminClient();
  return (
    await pageAll<{ user_id: string }>(
      (from, to) => admin.from("team_members").select("user_id").eq("team_id", teamId).order("id").range(from, to),
      "team",
    )
  ).map((r) => r.user_id);
}

async function cohortStudentIds(cohortId: string): Promise<string[]> {
  const admin = createAdminClient();
  return (
    await pageAll<{ user_id: string }>(
      (from, to) => admin.from("enrollments").select("user_id").eq("cohort_id", cohortId).order("id").range(from, to),
      "enrollments",
    )
  ).map((r) => r.user_id);
}

/**
 * The viewer for ONE channel: exactly the facts canReadChannel reads for it
 * (membership of it, staff, and the one audience clause that applies), in one
 * to three small queries instead of getChatViewer's whole picture. For the
 * read paths that touch a single channel — a page of messages, a file, the
 * read cursor. Never hand it to anything that looks at another channel: its
 * lists name this channel or nothing.
 */
export async function getChannelViewer(userId: string, caps: Capabilities | null, channel: ChannelRow): Promise<ChatViewer> {
  const admin = createAdminClient();
  const staff = can(caps, "chat.manage");
  const membership = admin
    .from("chat_members")
    .select("user_id")
    .eq("channel_id", channel.id)
    .eq("user_id", userId)
    .maybeSingle()
    .then((res) => !!must(res, "membership"));
  const audience = (async (): Promise<Pick<ChatViewer, "vetted" | "cohortIds" | "teamIds">> => {
    const none = { vetted: false, cohortIds: [] as string[], teamIds: [] as string[] };
    if (channel.kind !== "channel" || staff) return none;
    if (channel.audience === "everyone") return { ...none, vetted: (await vettedIds([userId])).has(userId) };
    if (channel.audience === "cohort" && channel.cohortId) {
      const cohortId = channel.cohortId;
      const own = must(
        await admin.from("enrollments").select("id").eq("user_id", userId).eq("cohort_id", cohortId).limit(1),
        "enrollments",
      ) as unknown[] | null;
      if ((own ?? []).length > 0) return { ...none, cohortIds: [cohortId] };
      const scopes = await mentoredScopes(userId);
      return { ...none, cohortIds: scopes.cohortIds.includes(cohortId) ? [cohortId] : [] };
    }
    if (channel.audience === "team" && channel.teamId) {
      const teamId = channel.teamId;
      const own = must(
        await admin.from("team_members").select("id").eq("user_id", userId).eq("team_id", teamId).limit(1),
        "teams",
      ) as unknown[] | null;
      if ((own ?? []).length > 0) return { ...none, teamIds: [teamId] };
      const scopes = await mentoredScopes(userId);
      return { ...none, teamIds: scopes.teamIds.includes(teamId) ? [teamId] : [] };
    }
    return none;
  })();
  const [member, facts] = await Promise.all([membership, audience]);
  return { userId, staff, ...facts, memberOf: member ? [channel.id] : [] };
}

// ---------------------------------------------------------------------------
// Channels
// ---------------------------------------------------------------------------

export async function getChannelRow(id: string): Promise<ChannelRow | null> {
  if (!isUuid(id)) return null;
  const data = must(
    await createAdminClient().from("chat_channels").select(CHANNEL_COLS).eq("id", id.toLowerCase()).maybeSingle(),
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

/** Every report's parties on these channels, keyed by channel. */
async function reportPartiesByChannel(channelIds: readonly string[]): Promise<Map<string, { partyIds: string[] }[]>> {
  const out = new Map<string, { partyIds: string[] }[]>();
  const admin = createAdminClient();
  await Promise.all(
    chunks(uniq(channelIds)).map(async (part) => {
      const rows = await pageAll<{ channel_id: string; party_ids: string[] | null }>(
        (from, to) => admin.from("chat_reports").select("channel_id, party_ids").in("channel_id", part).order("id").range(from, to),
        "reports",
      );
      for (const r of rows) {
        const list = out.get(r.channel_id) ?? [];
        list.push({ partyIds: Array.isArray(r.party_ids) ? r.party_ids : [] });
        out.set(r.channel_id, list);
      }
    }),
  );
  return out;
}

/** Every report on one channel, as the rules see them. */
export async function listChannelReportParties(channelId: string): Promise<{ partyIds: string[] }[]> {
  return (await reportPartiesByChannel([channelId])).get(channelId) ?? [];
}

/**
 * Is this channel reported, by reports that leave this viewer out? The staff
 * read gate for DMs and groups (channelReportsOpenTo): a moderator any report
 * on it names gets false, however many later reports don't.
 */
export async function isReportedFor(channelId: string, viewer: ChatViewer): Promise<boolean> {
  if (!viewer.staff) return false;
  return channelReportsOpenTo(await listChannelReportParties(channelId), viewer);
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
  return readable(channel, viewer);
}

async function readable(channel: ChannelRow, viewer: ChatViewer): Promise<{ channel: ChannelRow; reported: boolean } | null> {
  // Only pay for the report lookup when it could change the answer.
  const reported =
    channel.kind !== "channel" && viewer.staff && !viewer.memberOf.includes(channel.id)
      ? await isReportedFor(channel.id, viewer)
      : false;
  return canReadChannel(channel, viewer, reported) ? { channel, reported } : null;
}

/**
 * getChannelForViewer for a read that touches only this channel, with the
 * viewer resolved just for it (getChannelViewer). Hands that viewer back so
 * the caller's other checks agree with the one that let it in.
 */
export async function openChannelFor(
  id: string,
  userId: string,
  caps: Capabilities | null,
): Promise<{ channel: ChannelRow; reported: boolean; viewer: ChatViewer } | null> {
  const channel = await getChannelRow(id);
  if (!channel) return null;
  const viewer = await getChannelViewer(userId, caps, channel);
  const found = await readable(channel, viewer);
  return found ? { ...found, viewer } : null;
}

/**
 * Every channel, DM and group the viewer can read (archived ones too — the
 * caller decides what to show). Then the shared rule as a filter, so the list
 * can never show more than the rule allows.
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
  const [audience, memberships] = await Promise.all([
    ors.length
      ? pageAll<any>(
          (from, to) => admin.from("chat_channels").select(CHANNEL_COLS).or(ors.join(",")).order("id").range(from, to),
          "channels",
        )
      : Promise.resolve([] as any[]),
    Promise.all(
      chunks(viewer.memberOf).map(
        async (part) => (must(await admin.from("chat_channels").select(CHANNEL_COLS).in("id", part), "channels") ?? []) as any[],
      ),
    ),
  ]);
  const seen = new Set<string>();
  return [...audience, ...memberships.flat()]
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
  await Promise.all(
    chunks(uniq(channelIds)).map(async (part) => {
      const rows = await pageAll<{ channel_id: string; user_id: string }>(
        (from, to) =>
          admin
            .from("chat_members")
            .select("channel_id, user_id")
            .in("channel_id", part)
            .order("channel_id")
            .order("user_id")
            .range(from, to),
        "members",
      );
      for (const r of rows) {
        const list = out.get(r.channel_id) ?? [];
        list.push(r.user_id);
        out.set(r.channel_id, list);
      }
    }),
  );
  return out;
}

export type ReadRow = {
  channel_id: string;
  last_read_at: string;
  seen_at: string | null;
  notify: NotifyPref | null;
  hidden_at: string | null;
};

export async function getReads(userId: string, channelIds: readonly string[]): Promise<Map<string, ReadRow>> {
  const out = new Map<string, ReadRow>();
  const admin = createAdminClient();
  // One row per channel at most, so a 150-id chunk can't outgrow a page.
  await Promise.all(
    chunks(uniq(channelIds)).map(async (part) => {
      const rows = (must(
        await admin
          .from("chat_reads")
          .select("channel_id, last_read_at, seen_at, notify, hidden_at")
          .eq("user_id", userId)
          .in("channel_id", part),
        "read state",
      ) ?? []) as ReadRow[];
      for (const r of rows) out.set(r.channel_id, r);
    }),
  );
  return out;
}

export async function getUnreadCounts(
  userId: string,
  channelIds: readonly string[],
): Promise<Map<string, { unread: number; mentions: number }>> {
  const out = new Map<string, { unread: number; mentions: number }>();
  if (channelIds.length === 0) return out;
  const admin = createAdminClient();
  // One row per channel, so a 500-id chunk stays under max-rows.
  await Promise.all(
    chunks(uniq(channelIds), 500).map(async (part) => {
      const rows = (must(
        await admin.rpc("chat_unread", { p_uid: userId, p_channel_ids: part }),
        "unread counts",
      ) ?? []) as { channel_id: string; unread: number; mentions: number }[];
      for (const r of rows) out.set(r.channel_id, { unread: r.unread ?? 0, mentions: r.mentions ?? 0 });
    }),
  );
  return out;
}

export type SidebarData = {
  channels: SidebarItem[];
  conversations: SidebarItem[];
  /** Everyone the sidebar names, the viewer included. */
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

  const personIds = new Set<string>([viewer.userId]);
  for (const c of live) {
    if (c.kind === "dm") {
      const other = otherInDmKey(c.dmKey, viewer.userId);
      if (other) personIds.add(other);
    }
    if (c.kind === "group") for (const id of members.get(c.id) ?? []) personIds.add(id);
  }
  const people = await getPeople(Array.from(personIds));
  const blockedSet = new Set(blocked);

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
        // A block is silence: the blocked person's words don't show in the
        // blocker's sidebar either (they collapse in the conversation).
        c.kind === "channel" || !c.lastMessagePreview || (c.lastSenderId && blockedSet.has(c.lastSenderId))
          ? null
          : // Stored as left(body, 140): a full-length one may be cut mid-spoiler.
            plainText(c.lastMessagePreview, (id) => people.get(id)?.name, () => null, 80, {
              cut: Array.from(c.lastMessagePreview).length >= 140,
            }),
      unread: count.unread,
      mentions: sidebarMentions(c.kind, count, read?.notify ?? null),
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
 * Who can read a channel, as people, in name order — the member list, and
 * the composer's instant @-mention candidates. The first MEMBER_LIST_MAX by
 * name; past that the composer asks searchChannelPeople as you type. Staff
 * are included on every text channel because they can read them all.
 */
export async function listChannelPeople(channel: ChannelRow): Promise<ChatPerson[]> {
  const ids = await listChannelAudienceIds(channel);
  const people = await getPeople(ids);
  return Array.from(people.values())
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, MEMBER_LIST_MAX);
}

/** The ids of everyone who can read a channel, all of them (bells for @everyone use it too). */
export async function listChannelAudienceIds(channel: ChannelRow): Promise<string[]> {
  const admin = createAdminClient();
  const ids = new Set<string>();
  const explicit = (await listMembers([channel.id])).get(channel.id) ?? [];
  for (const id of explicit) ids.add(id);
  if (channel.kind !== "channel") return Array.from(ids);

  const staffSlugs = await staffRoleSlugs();
  const sources: Promise<string[]>[] = [];
  if (staffSlugs.length) {
    sources.push(
      pageAll<{ id: string }>(
        (from, to) => admin.from("profiles").select("id").in("role", staffSlugs).order("id").range(from, to),
        "staff",
      ).then((rows) => rows.map((r) => r.id)),
    );
  }
  switch (channel.audience) {
    case "cohort":
      if (channel.cohortId) {
        sources.push(
          cohortStudentIds(channel.cohortId).then(async (students) => [...students, ...(await mentorsOf(students))]),
        );
      }
      break;
    case "team":
      if (channel.teamId) {
        sources.push(teamMemberIds(channel.teamId).then(async (members) => [...members, ...(await mentorsOf(members))]));
      }
      break;
    case "everyone":
      sources.push(
        pageAll<{ id: string }>(
          (from, to) => admin.from("profiles").select("id").neq("role", "student").order("id").range(from, to),
          "people",
        ).then((rows) => rows.map((r) => r.id)),
        pageAll<{ user_id: string }>(
          (from, to) => admin.from("enrollments").select("user_id").order("id").range(from, to),
          "enrollments",
        ).then((rows) => rows.map((r) => r.user_id)),
        pageAll<{ user_id: string }>(
          (from, to) =>
            admin
              .from("applications")
              .select("user_id")
              .in("status", ACCEPTED_STATUSES as unknown as string[])
              .order("id")
              .range(from, to),
          "applications",
        ).then((rows) => rows.map((r) => r.user_id)),
      );
      break;
    default:
      break;
  }
  for (const list of await Promise.all(sources)) for (const id of list) if (id) ids.add(id);
  return Array.from(ids);
}

/**
 * Mention autocomplete past the preloaded list: people whose name matches,
 * who can read this channel, in name order (names that start with the query
 * first). Matches names only, never email. A DM or group searches its members.
 */
export async function searchChannelPeople(
  channel: ChannelRow,
  query: string,
  limit = PEOPLE_SEARCH_MAX,
): Promise<ChatPerson[]> {
  const q = query.trim().replace(/[%,()"\\*_]/g, " ").replace(/\s+/g, " ").trim().slice(0, 60);
  if (!q) return [];
  const lower = q.toLowerCase();
  const rank = (p: ChatPerson) => {
    const name = p.name.toLowerCase();
    return name.startsWith(lower) ? 0 : name.split(/\s+/).some((w) => w.startsWith(lower)) ? 1 : 2;
  };
  const ordered = (people: ChatPerson[]) =>
    people.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name)).slice(0, limit);

  if (channel.kind !== "channel") {
    const members = (await listMembers([channel.id])).get(channel.id) ?? [];
    const people = await getPeople(members);
    return ordered(Array.from(people.values()).filter((p) => p.name.toLowerCase().includes(lower)));
  }

  // Name matches a page at a time, in name order, kept only when they can
  // read the channel: first names that start with the query, then names with
  // a word that does, then any that contain it, until there are enough to
  // rank. Ranking only what one "contains" scan found missed "Maya" behind
  // two hundred "Amara"s for "ma". Four pages a pattern is plenty for a
  // name: past that the query is too short to mean anyone.
  const admin = createAdminClient();
  const found = new Map<string, ChatPerson>();
  const checked = new Set<string>();
  const SCAN = 200;
  const PAGES = 4;
  for (const pattern of [`${q}%`, `% ${q}%`, `%${q}%`]) {
    for (let from = 0, pages = 0; found.size < limit * 3 && pages < PAGES; from += SCAN, pages++) {
      const rows = (must(
        await admin
          .from("profiles")
          .select("id, full_name, role")
          .ilike("full_name", pattern)
          .order("full_name")
          .order("id")
          .range(from, from + SCAN - 1),
        "people",
      ) ?? []) as any[];
      // The later patterns match the earlier ones' names again: vet each person once.
      const fresh = rows.filter((r) => !checked.has(r.id));
      for (const r of fresh) checked.add(r.id);
      if (fresh.length) {
        const readers = new Set(await readersAmong(channel, fresh.map((r) => r.id)));
        for (const p of await toPeople(fresh.filter((r) => readers.has(r.id)))) found.set(p.id, p);
      }
      if (rows.length < SCAN) break;
    }
  }
  return ordered(Array.from(found.values()));
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

async function attachReplies(rows: any[]): Promise<ChatMessage[]> {
  const replyIds = uniq(rows.map((r) => r.reply_to_id).filter(isUuid));
  const replies = new Map<string, ReplyPreview>();
  if (replyIds.length) {
    const admin = createAdminClient();
    const found = (
      await Promise.all(
        chunks(replyIds).map(
          async (part) =>
            (must(
              await admin.from("chat_messages").select("id, sender_id, body, attachments, mentions, deleted_at").in("id", part),
              "replies",
            ) ?? []) as any[],
        ),
      )
    ).flat();
    for (const r of found) {
      replies.set(r.id, {
        id: r.id,
        senderId: r.sender_id ?? null,
        // Mentions stay as <@id> here; the client resolves names.
        // Cut where a later parse can't misread it (cutBody): never through a
        // token, and a spoiler the cut runs into stays closed.
        preview: r.deleted_at ? "" : r.body ? cutBody(r.body, 300) : toAttachments(r.attachments).length ? "[attachment]" : "",
        deleted: !!r.deleted_at,
        mentions: !r.deleted_at && Array.isArray(r.mentions) ? r.mentions : [],
      });
    }
  }
  return rows.map((r) =>
    toMessage(
      r,
      r.reply_to_id
        ? (replies.get(r.reply_to_id) ?? { id: r.reply_to_id, senderId: null, preview: "", deleted: true, mentions: [] })
        : null,
    ),
  );
}

export const PAGE_SIZE = 50;

/** A PostgREST filter value, quoted: timestamps carry the `.` and `:` the filter grammar reserves. */
function quoted(value: string): string {
  return `"${value.replace(/["\\]/g, "")}"`;
}

/** The keyset filter for "strictly before (createdAt, id)" in posting order. */
function beforeKey(createdAt: string, id: string): string {
  return `created_at.lt.${quoted(createdAt)},and(created_at.eq.${quoted(createdAt)},id.lt.${id})`;
}

/**
 * A page of messages in posting order: the newest PAGE_SIZE, or the ones
 * before a cursor, or a window around one message (a search hit, a pin).
 * Deleted messages are left out. Only call after the channel's read check.
 *
 * The cursor is the compound (created_at, id) of the oldest message loaded:
 * rows written in one transaction share created_at, and a timestamp-only
 * cursor would skip whichever of them fell past a page's edge. A bare
 * `before` (no id) still works, as "older than this instant".
 */
export async function listMessages(
  channelId: string,
  opts: { before?: string; beforeId?: string; around?: string; limit?: number } = {},
): Promise<{ messages: ChatMessage[]; hasMoreBefore: boolean; hasMoreAfter: boolean }> {
  const admin = createAdminClient();
  const limit = Math.min(Math.max(opts.limit ?? PAGE_SIZE, 1), 100);
  const cols = await screenMessageCols();
  const base = () => admin.from("chat_messages").select(cols).eq("channel_id", channelId).is("deleted_at", null);

  if (opts.around && isUuid(opts.around)) {
    const target = must(
      await admin.from("chat_messages").select("id, created_at").eq("id", opts.around).eq("channel_id", channelId).maybeSingle(),
      "the message",
    ) as { id: string; created_at: string } | null;
    if (target) {
      const half = Math.floor(limit / 2);
      const t = quoted(target.created_at);
      const [older, newer] = await Promise.all([
        base()
          .or(`created_at.lt.${t},and(created_at.eq.${t},id.lte.${target.id})`)
          .order("created_at", { ascending: false })
          .order("id", { ascending: false })
          .limit(half + 1),
        base()
          .or(`created_at.gt.${t},and(created_at.eq.${t},id.gt.${target.id})`)
          .order("created_at", { ascending: true })
          .order("id", { ascending: true })
          .limit(half + 1),
      ]);
      const o = (must(older, "messages") ?? []) as any[];
      const n = (must(newer, "messages") ?? []) as any[];
      const rows = [...o.slice(0, half).reverse(), ...n.slice(0, half)];
      return { messages: await attachReplies(rows), hasMoreBefore: o.length > half, hasMoreAfter: n.length > half };
    }
  }

  let q = base();
  if (opts.before && Number.isFinite(Date.parse(opts.before))) {
    q = isUuid(opts.beforeId) ? q.or(beforeKey(opts.before, opts.beforeId.toLowerCase())) : q.lt("created_at", opts.before);
  }
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
    await createAdminClient()
      .from("chat_messages")
      .select(MESSAGE_COLS + ", deleted_by, pinned_by")
      .eq("id", id.toLowerCase())
      .maybeSingle(),
    "the message",
  );
}

export async function getMessages(ids: readonly string[]): Promise<ChatMessage[]> {
  const admin = createAdminClient();
  const wanted = uniq(ids.filter(isUuid).map((id) => id.toLowerCase()));
  if (wanted.length === 0) return [];
  const cols = await screenMessageCols();
  const rows = (
    await Promise.all(
      chunks(wanted).map(
        async (part) => (must(await admin.from("chat_messages").select(cols).in("id", part), "messages") ?? []) as any[],
      ),
    )
  ).flat();
  return attachReplies(rows.filter((r) => !r.deleted_at));
}

/** A channel's pins, newest first. A channel holds at most 50 (togglePin). */
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

/** How many pins, without loading them. */
export async function countPins(channelId: string): Promise<number> {
  const { count, error } = await createAdminClient()
    .from("chat_messages")
    .select("id", { count: "exact", head: true })
    .eq("channel_id", channelId)
    .is("deleted_at", null)
    .not("pinned_at", "is", null);
  if (error) throw new Error(`Couldn't load pins: ${error.message}`);
  return count ?? 0;
}

/**
 * Search the channels the viewer can read, or one channel. Plain substring
 * match, newest first: at batch0's size that's instant, and nobody has to
 * learn a query language. One channel is checked the way opening it is
 * (getChannelForViewer), so a moderator can search a reported DM they're
 * reading — the sidebar's list never holds those.
 */
export async function searchMessages(
  viewer: ChatViewer,
  query: string,
  channelId?: string | null,
): Promise<ChatMessage[]> {
  const q = query.trim().replace(/[%_\\]/g, (c) => `\\${c}`);
  if (q.length < 2) return [];
  let ids: string[];
  if (channelId) {
    const found = await getChannelForViewer(channelId, viewer);
    ids = found ? [found.channel.id] : [];
  } else {
    ids = (await listReadableChannels(viewer)).map((c) => c.id);
  }
  if (ids.length === 0) return [];
  const admin = createAdminClient();
  const rows = (
    await Promise.all(
      chunks(ids).map(
        async (part) =>
          (must(
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
          ) ?? []) as any[],
      ),
    )
  ).flat();
  rows.sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : a.id < b.id ? 1 : -1));
  return attachReplies(rows.slice(0, 40));
}

/** Where the next page of "report a deleted message" starts: the last stub shown. */
export type DeletedCursor = { deletedAt: string; id: string };

/**
 * The report targets for something posted in a text channel and then
 * deleted: its messages deleted in the last REPORTABLE_DELETED_MS, most
 * recently deleted first, a page at a time, as stubs — who and when, never a
 * word or a file (the select names neither). History and search leave
 * deleted messages out, so without these a message deleted before anyone
 * reported it couldn't be reported at all. Never the viewer's own, never a
 * system line, never a deleted account's (account deletion takes their
 * earlier versions too, so there is nothing left to review). Whether the
 * sender deleted it or a moderator removed it isn't said: deleted_by stays
 * with the team.
 *
 * The window counts from the delete, not the post: a message posted a month
 * ago, edited into something abusive yesterday and deleted, is as fresh a
 * report as one posted yesterday. And it pages on (deleted_at, id) with
 * nothing skipped, so a burst of deletes — fifty junk messages posted and
 * deleted to bury one, or a moderator clearing out a spam run — only pushes
 * the one that matters onto the next page, never out of reach. 0104's
 * partial (channel_id, deleted_at desc, id desc) index is the read; before
 * it, the channel's own index still bounds it.
 *
 * DMs and groups have none: reporting the conversation hands it all over,
 * deleted messages included. Only call after the channel's read check.
 */
export async function listDeletedForReport(
  channel: ChannelRow,
  viewerId: string,
  opts: { before?: DeletedCursor | null; limit?: number } = {},
): Promise<{ messages: DeletedMessageStub[]; hasMore: boolean }> {
  if (channel.kind !== "channel") return { messages: [], hasMore: false };
  const limit = Math.min(Math.max(opts.limit ?? DELETED_PAGE_SIZE, 1), 100);
  const since = new Date(Date.now() - REPORTABLE_DELETED_MS).toISOString();
  let q = createAdminClient()
    .from("chat_messages")
    .select("id, sender_id, created_at, deleted_at")
    .eq("channel_id", channel.id)
    .eq("kind", "message")
    .not("sender_id", "is", null)
    .neq("sender_id", viewerId)
    .not("deleted_at", "is", null)
    .gte("deleted_at", since);
  const before = opts.before;
  if (before && Number.isFinite(Date.parse(before.deletedAt)) && isUuid(before.id)) {
    const t = quoted(before.deletedAt);
    q = q.or(`deleted_at.lt.${t},and(deleted_at.eq.${t},id.lt.${before.id.toLowerCase()})`);
  }
  const rows = (must(
    await q.order("deleted_at", { ascending: false }).order("id", { ascending: false }).limit(limit + 1),
    "deleted messages",
  ) ?? []) as { id: string; sender_id: string; created_at: string; deleted_at: string }[];
  return {
    messages: rows.slice(0, limit).map((r) => ({ id: r.id, senderId: r.sender_id, createdAt: r.created_at, deletedAt: r.deleted_at })),
    hasMore: rows.length > limit,
  };
}

/** One page of "report a deleted message". */
export const DELETED_PAGE_SIZE = 50;

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

/** Is this recipient let in? Only asked when the answer can matter. */
async function recipientVetted(actor: ChatViewer, recipient: ChatPerson): Promise<boolean> {
  if (actor.staff || recipient.isStaff || !actor.vetted) return false;
  return (await vettedIds([recipient.id])).has(recipient.id);
}

/**
 * May the actor reach this person at all (reachVerdict): the directory rule,
 * without safeguarding. A group checks this per person and safeguarding once,
 * on the whole membership: a student may start a group with a mentor when a
 * staff member is in it too.
 */
export async function canReach(
  actor: ChatViewer,
  recipient: ChatPerson,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  return reachVerdict(actor, { staff: recipient.isStaff, vetted: await recipientVetted(actor, recipient) });
}

/** May the actor open a DM with this person (dmVerdict: reachable, then safeguarding)? */
export async function canStartConversation(
  actor: ChatViewer,
  recipient: ChatPerson,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (actor.staff || recipient.isStaff) return { ok: true };
  const [vetted, me] = await Promise.all([recipientVetted(actor, recipient), getPerson(actor.userId)]);
  return dmVerdict({ ...actor, party: me ? asParty(me) : null }, { ...asParty(recipient), vetted });
}

/**
 * The directory for a new DM or group: by name, in name order, scoped to who
 * the viewer may reach. Never lists anyone on either side of a block (showing
 * someone who blocked you and then failing would announce it), and matches
 * email only for staff (a student typing a guessed address must not get a
 * confirming hit).
 *
 * `group` is who else a GROUP being put together holds (its members, or the
 * people picked for it so far). Without it the list is for a DM, and the
 * safeguarding rule is asked about the pair; with it, about the whole group
 * with each candidate in it (directoryOffers) — the question createGroup and
 * addToGroup ask before anything is written, which stay the final word. So
 * a student adding to a group a staff member is in sees the mentor they may
 * add, and still never sees one for a DM.
 *
 * `withheld` says the safeguarding rule, and only it, left someone matching
 * the search out — so the picker can say what would let them in ("pick
 * someone from the batch0 team first") exactly when that's the reason, and
 * not under every typo. It never counts a block (those are gone before the
 * rule is asked) or anyone the viewer can't reach, and it names nobody: a
 * person's role is on their name everywhere in Chat already.
 */
export async function searchDirectory(
  query: string,
  viewer: ChatViewer,
  limit = 20,
  group: readonly string[] | null = null,
): Promise<{ people: ChatPerson[]; withheld: boolean }> {
  const q = query.trim();
  const admin = createAdminClient();
  const hidden = new Set<string>([viewer.userId, ...(await listBlockRelatedIds(viewer.userId))]);
  const escaped = q.replace(/[%,()"\\*]/g, " ").trim();
  if (q && !escaped) return { people: [], withheld: false };

  const byName = (req: any) => {
    if (!escaped) return req;
    return viewer.staff
      ? req.or(`full_name.ilike.%${escaped}%,email.ilike.%${escaped}%`)
      : req.ilike("full_name", `%${escaped}%`);
  };
  const base = () => admin.from("profiles").select("id, full_name, role");
  const want = limit + hidden.size + 10;

  let rows: any[] = [];
  if (viewer.staff) {
    rows = must(await byName(base()).order("full_name", { ascending: true }).order("id").limit(want), "people") ?? [];
  } else if (!viewer.vetted) {
    const staff = await staffRoleSlugs();
    rows = staff.length
      ? (must(await byName(base().in("role", staff)).order("full_name", { ascending: true }).order("id").limit(want), "people") ?? [])
      : [];
  } else {
    // Everyone let in, in name order: a page of name matches at a time, kept
    // when vetted, until there are enough — never an arbitrary slice of
    // enrollment rows sorted afterwards.
    const SCAN = 200;
    for (let from = 0, pages = 0; rows.length < want && pages < 10; from += SCAN, pages++) {
      const page = (must(
        await byName(base()).order("full_name", { ascending: true }).order("id").range(from, from + SCAN - 1),
        "people",
      ) ?? []) as { id: string; full_name: string | null; role: string | null }[];
      if (page.length === 0) break;
      const vetted = await vettedAmong(page);
      rows.push(...page.filter((r) => vetted.has(r.id)));
      if (page.length < SCAN) break;
    }
  }

  const seen = new Set<string>();
  const candidates = await toPeople(
    rows.filter((r: any) => {
      if (hidden.has(r.id) || seen.has(r.id)) return false;
      seen.add(r.id);
      return true;
    }),
  );
  // Nobody the safeguarding rule wouldn't let into the conversation: offering
  // them and then refusing would only confuse. A deleted account in the group
  // counts as nobody, as it does for membershipAllowed.
  const me = viewer.staff ? null : await getPerson(viewer.userId);
  const others =
    me && group?.length
      ? Array.from((await getPeople(group.filter((id) => id !== viewer.userId))).values()).map(asParty)
      : [];
  const offered = candidates.filter((p) => !me || directoryOffers(asParty(me), asParty(p), group ? others : null));
  return { people: offered.slice(0, limit), withheld: offered.length < candidates.length };
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
  const admin = createAdminClient();
  const rows = await pageAll<{ blocked_id: string }>(
    (from, to) => admin.from("chat_blocks").select("blocked_id").eq("blocker_id", userId).order("blocked_id").range(from, to),
    "blocks",
  );
  return rows.map((r) => r.blocked_id);
}

/** Everyone on either side of a block with this user. Never surfaced as two lists. */
export async function listBlockRelatedIds(userId: string): Promise<string[]> {
  const admin = createAdminClient();
  const rows = await pageAll<{ blocker_id: string; blocked_id: string }>(
    (from, to) =>
      admin
        .from("chat_blocks")
        .select("blocker_id, blocked_id")
        .or(`blocker_id.eq.${userId},blocked_id.eq.${userId}`)
        .order("blocker_id")
        .order("blocked_id")
        .range(from, to),
    "blocks",
  );
  const ids = new Set<string>();
  for (const r of rows) ids.add(r.blocker_id === userId ? r.blocked_id : r.blocker_id);
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
  await Promise.all(
    chunks(uniq(ids)).map(async (part) => {
      const rows = (must(await admin.from("chat_channels").select("id, kind").in("id", part), "channels") ?? []) as any[];
      for (const r of rows) out.set(r.id, r.kind);
    }),
  );
  return out;
}

/**
 * The rows this moderator may see (reportVisibleTo): a text-channel report on
 * its own parties; a DM's or group's together with every report on it, so a
 * moderator named by one report on a conversation sees none of its reports.
 */
async function visibleReportRows(viewer: ChatViewer, rows: any[]): Promise<any[]> {
  if (!viewer.staff || rows.length === 0) return [];
  const channelIds = uniq(rows.map((r) => r.channel_id).filter(isUuid));
  const [kinds, parties] = await Promise.all([channelKinds(channelIds), reportPartiesByChannel(channelIds)]);
  return rows.filter((r) => {
    const own = [{ partyIds: Array.isArray(r.party_ids) ? (r.party_ids as string[]) : [] }];
    // A report whose channel is gone stands on its own parties.
    const all = r.channel_id ? (parties.get(r.channel_id) ?? own) : own;
    const kind = (r.channel_id && kinds.get(r.channel_id)) || "channel";
    return reportVisibleTo({ id: r.channel_id ?? "", kind }, own[0], all, viewer);
  });
}

/**
 * The queue, minus every report about the moderator looking at it: who
 * reported them, and why, is exactly what the person reported must not learn.
 * Open reports come back in full; closed ones, the newest `limit`.
 */
export async function listReports(
  viewer: ChatViewer,
  status: ReportStatus | "all" = "open",
  opts: { limit?: number } = {},
): Promise<ChatReport[]> {
  const admin = createAdminClient();
  const query = () => {
    let q = admin.from("chat_reports").select(REPORT_COLS);
    if (status !== "all") q = q.eq("status", status);
    return q.order("created_at", { ascending: false }).order("id", { ascending: false });
  };
  const rows = opts.limit
    ? ((must(await query().limit(Math.min(opts.limit, PAGE_ROWS)), "reports") ?? []) as any[])
    : await pageAll<any>((from, to) => query().range(from, to), "reports");
  return hydrateReports(await visibleReportRows(viewer, rows));
}

/** One report, or null when it doesn't exist OR this viewer may not see it — the same answer. */
export async function getReport(id: string, viewer: ChatViewer): Promise<ChatReport | null> {
  if (!isUuid(id)) return null;
  const row = must(
    await createAdminClient().from("chat_reports").select(REPORT_COLS).eq("id", id.toLowerCase()).maybeSingle(),
    "the report",
  );
  if (!row) return null;
  return (await hydrateReports(await visibleReportRows(viewer, [row])))[0] ?? null;
}

export async function listReportsForChannel(channelId: string, viewer: ChatViewer): Promise<ChatReport[]> {
  const admin = createAdminClient();
  const rows = await pageAll<any>(
    (from, to) =>
      admin
        .from("chat_reports")
        .select(REPORT_COLS)
        .eq("channel_id", channelId)
        .order("created_at", { ascending: false })
        .order("id", { ascending: false })
        .range(from, to),
    "reports",
  );
  return hydrateReports(await visibleReportRows(viewer, rows));
}

/** How many reports a channel has, any status. Fails closed: an error throws, never reads as none. */
export async function countChannelReports(channelId: string): Promise<number> {
  const { count, error } = await createAdminClient()
    .from("chat_reports")
    .select("id", { count: "exact", head: true })
    .eq("channel_id", channelId);
  if (error) throw new Error(`Couldn't check for reports: ${error.message}`);
  return count ?? 0;
}

export async function countOpenReports(viewer: ChatViewer): Promise<number> {
  try {
    const admin = createAdminClient();
    const rows = await pageAll<any>(
      (from, to) => admin.from("chat_reports").select("id, channel_id, party_ids").eq("status", "open").order("id").range(from, to),
      "reports",
    );
    return (await visibleReportRows(viewer, rows)).length;
  } catch (err) {
    if (isMissingSchemaError(err)) return 0;
    throw err;
  }
}

export type Revision = { body: string; reason: string; createdAt: string; attachments: ChatAttachment[] };

/** What a reported message said, including every version before an edit or delete. */
export async function listRevisions(messageId: string): Promise<Revision[]> {
  const rows = (await revisionsFor([messageId])).get(messageId) ?? [];
  return rows;
}

/** Revisions of these messages, oldest first, keyed by message. */
async function revisionsFor(messageIds: readonly string[]): Promise<Map<string, Revision[]>> {
  const out = new Map<string, Revision[]>();
  const admin = createAdminClient();
  await Promise.all(
    chunks(uniq(messageIds)).map(async (part) => {
      const rows = await pageAll<any>(
        (from, to) =>
          admin
            .from("chat_message_revisions")
            .select("id, message_id, body, reason, created_at, attachments")
            .in("message_id", part)
            .order("created_at", { ascending: true })
            .order("id", { ascending: true })
            .range(from, to),
        "revisions",
      );
      for (const r of rows) {
        const list = out.get(r.message_id) ?? [];
        list.push({ body: r.body, reason: r.reason, createdAt: r.created_at, attachments: toAttachments(r.attachments) });
        out.set(r.message_id, list);
      }
    }),
  );
  return out;
}

export type TranscriptMessage = ChatMessage & {
  deletedAt: string | null;
  /** Every earlier version (edits) and what it said before a delete, oldest first. */
  revisions: Revision[];
};

/**
 * A moderator's transcript: deleted messages included, with every earlier
 * version of anything edited or deleted (words and attachments). Around one
 * message when the report names one — the reported message and its context,
 * however old — otherwise the newest `limit`.
 */
export async function listTranscript(
  channelId: string,
  opts: { around?: string | null; limit?: number } = {},
): Promise<{ messages: TranscriptMessage[]; hasMoreBefore: boolean; hasMoreAfter: boolean }> {
  const admin = createAdminClient();
  const limit = Math.min(Math.max(opts.limit ?? 200, 2), 500);
  const base = () => admin.from("chat_messages").select(MESSAGE_COLS).eq("channel_id", channelId);
  let rows: any[] = [];
  let hasMoreBefore = false;
  let hasMoreAfter = false;
  const target =
    opts.around && isUuid(opts.around)
      ? (must(
          await admin.from("chat_messages").select("id, created_at").eq("id", opts.around).eq("channel_id", channelId).maybeSingle(),
          "the message",
        ) as { id: string; created_at: string } | null)
      : null;
  if (target) {
    const half = Math.floor(limit / 2);
    const t = quoted(target.created_at);
    const [older, newer] = await Promise.all([
      base()
        .or(`created_at.lt.${t},and(created_at.eq.${t},id.lte.${target.id})`)
        .order("created_at", { ascending: false })
        .order("id", { ascending: false })
        .limit(half + 1),
      base()
        .or(`created_at.gt.${t},and(created_at.eq.${t},id.gt.${target.id})`)
        .order("created_at", { ascending: true })
        .order("id", { ascending: true })
        .limit(half + 1),
    ]);
    const o = (must(older, "the transcript") ?? []) as any[];
    const n = (must(newer, "the transcript") ?? []) as any[];
    rows = [...o.slice(0, half).reverse(), ...n.slice(0, half)];
    hasMoreBefore = o.length > half;
    hasMoreAfter = n.length > half;
  } else {
    const newest = (must(
      await base().order("created_at", { ascending: false }).order("id", { ascending: false }).limit(limit + 1),
      "the transcript",
    ) ?? []) as any[];
    hasMoreBefore = newest.length > limit;
    rows = newest.slice(0, limit).reverse();
  }
  const changed = rows.filter((r) => r.deleted_at || r.edited_at).map((r) => r.id);
  const [revisions, messages] = await Promise.all([revisionsFor(changed), attachReplies(rows)]);
  return {
    messages: messages.map((m, i) => ({
      ...m,
      deletedAt: rows[i].deleted_at ?? null,
      revisions: revisions.get(m.id) ?? [],
    })),
    hasMoreBefore,
    hasMoreAfter,
  };
}

/** Everyone who runs chat: who hears about reports and flags. Fails closed. */
export async function listModeratorIds(): Promise<string[]> {
  const slugs = await staffRoleSlugs();
  if (slugs.length === 0) return [];
  const admin = createAdminClient();
  const rows = await pageAll<{ id: string }>(
    (from, to) => admin.from("profiles").select("id").in("role", slugs).order("id").range(from, to),
    "moderators",
  );
  return rows.map((r) => r.id);
}

/** Everyone who ever posted in a channel, deleted messages included: who a conversation report is about. */
export async function listChannelSenderIds(channelId: string): Promise<string[]> {
  const admin = createAdminClient();
  const rows = await pageAll<{ sender_id: string | null }>(
    (from, to) =>
      admin
        .from("chat_messages")
        .select("sender_id")
        .eq("channel_id", channelId)
        .not("sender_id", "is", null)
        .order("id")
        .range(from, to),
    "senders",
  );
  return uniq(rows.map((r) => r.sender_id).filter((id): id is string => !!id));
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

export type ChatMute = { userId: string; until: string | null; reason: string | null; createdBy: string | null; createdAt: string };

/**
 * This person's chat mute (chat_mutes, 0101), expired or not — or null.
 * Fails closed on an error; a database without the table has muted nobody.
 */
export async function getMute(userId: string): Promise<ChatMute | null> {
  const { data, error } = await createAdminClient()
    .from("chat_mutes")
    .select("user_id, until, reason, created_by, created_at")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) {
    if (isMissingSchemaError(error)) return null;
    throw new Error(`Couldn't check for a chat mute: ${error.message}`);
  }
  if (!data) return null;
  const r = data as any;
  return { userId: r.user_id, until: r.until ?? null, reason: r.reason ?? null, createdBy: r.created_by ?? null, createdAt: r.created_at };
}

/** Is this person muted in chat right now? */
export async function isMuted(userId: string): Promise<boolean> {
  return muteActive(await getMute(userId), Date.now());
}

/** Every text channel, for the admin page (archived included). */
export async function listAllChannels(): Promise<ChannelRow[]> {
  const admin = createAdminClient();
  const rows = await pageAll<any>(
    (from, to) => admin.from("chat_channels").select(CHANNEL_COLS).eq("kind", "channel").order("position").order("name").order("id").range(from, to),
    "channels",
  );
  return rows.map(toChannel);
}

export { DELETED_NAME };

/**
 * Of these people, who can read this channel — so a mention can only ever
 * ping someone who'll see it, and a typed <@id> for a stranger is just text.
 */
export async function filterReaders(channel: ChannelRow, ids: readonly string[]): Promise<string[]> {
  return readersAmong(channel, uniq(ids.filter(isUuid).map((id) => id.toLowerCase())).slice(0, 50));
}

/**
 * Which of these people can read the channel right now — no cap, chunked, so
 * it can vet a whole "All messages" list. Same answer as canReadChannel for
 * each of them, minus the report path (a bell never rides that).
 */
export async function readersAmong(channel: ChannelRow, ids: readonly string[]): Promise<string[]> {
  const wanted = uniq(ids.filter(isUuid).map((id) => id.toLowerCase()));
  if (wanted.length === 0) return [];
  const admin = createAdminClient();
  const explicit = new Set((await listMembers([channel.id])).get(channel.id) ?? []);
  if (channel.kind !== "channel") return wanted.filter((id) => explicit.has(id));

  const staffSlugs = new Set(await staffRoleSlugs());
  const ok = new Set<string>();
  const rest: { id: string; role: string | null }[] = [];
  const profiles = (
    await Promise.all(
      chunks(wanted).map(async (part) => (must(await admin.from("profiles").select("id, role").in("id", part), "people") ?? []) as any[]),
    )
  ).flat();
  for (const p of profiles) {
    if (explicit.has(p.id) || staffSlugs.has(p.role)) ok.add(p.id);
    else rest.push({ id: p.id, role: p.role ?? null });
  }
  if (rest.length) {
    const restIds = rest.map((r) => r.id);
    if (channel.audience === "everyone") {
      for (const id of await vettedAmong(rest)) ok.add(id);
    } else if (channel.audience === "cohort" && channel.cohortId) {
      const cohortId = channel.cohortId;
      await Promise.all(
        chunks(restIds).map(async (part) => {
          const rows = (must(await admin.from("enrollments").select("user_id").eq("cohort_id", cohortId).in("user_id", part), "enrollments") ?? []) as any[];
          for (const r of rows) ok.add(r.user_id);
        }),
      );
      const left = restIds.filter((id) => !ok.has(id));
      if (left.length) for (const id of await mentorsOf(await cohortStudentIds(cohortId), left)) ok.add(id);
    } else if (channel.audience === "team" && channel.teamId) {
      const teamId = channel.teamId;
      await Promise.all(
        chunks(restIds).map(async (part) => {
          const rows = (must(await admin.from("team_members").select("user_id").eq("team_id", teamId).in("user_id", part), "team") ?? []) as any[];
          for (const r of rows) ok.add(r.user_id);
        }),
      );
      const left = restIds.filter((id) => !ok.has(id));
      if (left.length) for (const id of await mentorsOf(await teamMemberIds(teamId), left)) ok.add(id);
    }
  }
  return wanted.filter((id) => ok.has(id));
}
