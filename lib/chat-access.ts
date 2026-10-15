// ---------------------------------------------------------------------------
// batch0 Chat — the rules, as pure functions.
//
// Import-free on purpose, so the same predicate runs in a server component,
// a server action, the client UI and `node --test` as-is. The SQL in
// migration 0101 (chat_can_read and friends) is the backstop for the read
// rule; lib/chat-migration-db.test.ts runs both over the same matrix so they
// can't drift. Everything else here — who may post, pin, delete, ping
// everyone — is enforced in app/chat/actions.ts, because no browser write
// path exists at all.
// ---------------------------------------------------------------------------

export type ChannelKind = "channel" | "dm" | "group";
export type Audience = "everyone" | "cohort" | "team" | "staff" | "members";
export type Posting = "everyone" | "staff";
export type NotifyPref = "all" | "mentions" | "none";

export const AUDIENCES: readonly Audience[] = ["everyone", "cohort", "team", "staff", "members"];

/** A channel, reduced to what any rule needs. */
export type ChannelScope = {
  id: string;
  kind: ChannelKind;
  audience: Audience;
  cohortId: string | null;
  teamId: string | null;
  posting: Posting;
  archivedAt: string | null;
  slowmodeSeconds: number;
};

/** Everything about a viewer the rules look at, resolved once per request. */
export type ChatViewer = {
  userId: string;
  /** Holds `chat.manage` or the '*' wildcard. */
  staff: boolean;
  /** A non-student role, or a student with an enrollment or accepted application. */
  vetted: boolean;
  cohortIds: readonly string[];
  teamIds: readonly string[];
  /** Channels with an explicit chat_members row for this viewer. */
  memberOf: readonly string[];
};

/**
 * Who may read a channel. Mirrors chat_can_read() in 0101 exactly:
 *
 *   - an explicit member, always;
 *   - for a text channel: staff, or the audience (everyone = vetted people,
 *     cohort = enrolled in it or mentoring someone who is, team = on it or
 *     mentoring someone who is; staff and members audiences add nobody beyond
 *     staff and explicit members). The mentor clauses live in the viewer:
 *     getChatViewer() folds a mentor's mentees' cohorts and teams into
 *     cohortIds and teamIds;
 *   - for a DM or group: staff only once someone in it has reported it, and
 *     only by reports that leave this moderator out (channelReportsOpenTo).
 *     With no report there is no staff read path — a promise the UI makes out
 *     loud, which is why `reported` is a required argument.
 */
export function canReadChannel(c: ChannelScope, viewer: ChatViewer, reported: boolean): boolean {
  if (!viewer.userId) return false;
  if (viewer.memberOf.includes(c.id)) return true;
  if (c.kind === "channel") {
    if (viewer.staff) return true;
    switch (c.audience) {
      case "everyone":
        return viewer.vetted;
      case "cohort":
        return !!c.cohortId && viewer.cohortIds.includes(c.cohortId);
      case "team":
        return !!c.teamId && viewer.teamIds.includes(c.teamId);
      default:
        return false;
    }
  }
  return viewer.staff && reported;
}

/** Does this one report leave the moderator out? A building block: the gate is channelReportsOpenTo. */
export function reportOpenTo(partyIds: readonly string[], viewer: Pick<ChatViewer, "userId" | "staff">): boolean {
  return !!viewer.userId && viewer.staff && !partyIds.includes(viewer.userId);
}

/**
 * May this moderator work a channel's reports — see them, resolve them, be
 * belled about them — and, for a DM or group, read the conversation because
 * of them? Only when the channel has a report and NO report on it names them
 * as a party (chat_reports.party_ids). Judged over every report on the
 * channel together, not report by report: a moderator someone reported and
 * who then left the group must not come back in through the next report,
 * which can no longer see them as a member. Mirrors chat_can_read() in 0101:
 * `exists (report on c) and not exists (report on c naming uid)`.
 */
export function channelReportsOpenTo(
  reports: readonly { partyIds: readonly string[] }[],
  viewer: Pick<ChatViewer, "userId" | "staff">,
): boolean {
  if (reports.length === 0) return false;
  return reports.every((r) => reportOpenTo(r.partyIds, viewer));
}

/**
 * The queue's rule for one channel's reports: channelReportsOpenTo, and never
 * someone in the DM or group right now either — no snapshot can know who
 * joined after the last report.
 */
export function reportVisibleTo(
  channel: { id: string; kind: ChannelKind },
  channelReports: readonly { partyIds: readonly string[] }[],
  viewer: ChatViewer,
): boolean {
  if (!channelReportsOpenTo(channelReports, viewer)) return false;
  return channel.kind === "channel" || !viewer.memberOf.includes(channel.id);
}

/**
 * Who a new report is about, frozen when it's filed (chat_reports.party_ids):
 *
 *   - a DM or group: everyone in it now, and everyone who ever posted in it
 *     (someone who said it and then left is still who it's about);
 *   - the reported message's sender;
 *   - every party to an earlier report on the same channel, so the set only
 *     ever grows.
 *
 * A text channel's report is about one message, not the people in the room:
 * staff read every channel anyway, and naming everyone who ever posted in
 * #general would hide its reports from every moderator who ever said hello.
 */
export function reportPartyIds(input: {
  kind: ChannelKind;
  members: readonly string[];
  senders: readonly (string | null)[];
  messageSenderId: string | null;
  earlier: readonly { partyIds: readonly string[] }[];
}): string[] {
  const out = new Set<string>();
  if (input.kind !== "channel") {
    for (const id of input.members) if (id) out.add(id);
    for (const id of input.senders) if (id) out.add(id);
  }
  if (input.messageSenderId) out.add(input.messageSenderId);
  for (const r of input.earlier) for (const id of r.partyIds) if (id) out.add(id);
  return Array.from(out);
}

/**
 * Who hears about a new report. `eligible` is every moderator the channel's
 * reports stay open to (none of them a party); the reporter isn't belled
 * about their own report. With nobody eligible the report would reach no
 * one — every moderator is in it — so it has to `escalate` outside chat.
 */
export function reportRouting(
  moderatorIds: readonly string[],
  channelReports: readonly { partyIds: readonly string[] }[],
  reporterId: string,
): { notify: string[]; escalate: boolean } {
  const eligible = Array.from(new Set(moderatorIds)).filter((id) =>
    channelReportsOpenTo(channelReports, { userId: id, staff: true }),
  );
  return { notify: eligible.filter((id) => id !== reporterId), escalate: eligible.length === 0 };
}

/** Is the viewer a party to this DM or group (not a moderator looking in)? */
export function isParticipant(c: Pick<ChannelScope, "id" | "kind">, viewer: ChatViewer): boolean {
  return c.kind !== "channel" && viewer.memberOf.includes(c.id);
}

export type Verdict = { ok: true } | { ok: false; reason: string };

const OK: Verdict = { ok: true };
const no = (reason: string): Verdict => ({ ok: false, reason });

/** A chat mute (chat_mutes): no posting, reacting, pinning or starting conversations. */
export const MUTED_REASON = "You can't post in chat right now.";

/** A pending fine locks everything but a DM with the team. */
export const FINE_REASON = "Settle your pending fine first. You can still message the batch0 team about it.";

/**
 * Is a chat_mutes row in force? `until` null means until a moderator lifts
 * it. Staff are never muted: they run chat, and could lift it themselves.
 */
export function muteActive(mute: { until: string | null } | null | undefined, nowMs: number): boolean {
  if (!mute) return false;
  if (mute.until === null) return true;
  const until = Date.parse(mute.until);
  return Number.isFinite(until) && until > nowMs;
}

/**
 * Who may post. Reading isn't enough:
 *   - an archived channel is history, read-only for everyone;
 *   - a staff-posting channel (#announcements) is read-only for everyone else;
 *   - a moderator reading a reported DM is not a party to it;
 *   - a DM freezes for both sides once either has blocked the other, and goes
 *     read-only when the other account is gone;
 *   - a muted or fined account can't post (the caller works out the one
 *     exception both share, a DM with the team, and passes false there).
 */
export function canPost(
  c: ChannelScope,
  viewer: ChatViewer,
  ctx: {
    reported?: boolean;
    blocked?: boolean;
    otherPresent?: boolean;
    safeguarded?: boolean;
    muted?: boolean;
    fined?: boolean;
  } = {},
): Verdict {
  if (!canReadChannel(c, viewer, !!ctx.reported)) return no("That channel isn't available.");
  if (c.archivedAt) return no("This channel is archived. It's read-only now.");
  if (c.kind === "channel") {
    if (c.posting === "staff" && !viewer.staff) return no("Only the batch0 team posts here.");
    return personalLock(viewer, ctx);
  }
  if (!isParticipant(c, viewer)) return no("You're reading this as a moderator. You can't post in it.");
  // A conversation that predates the rule (an old DM carried over by 0101)
  // stays readable but goes quiet.
  if (ctx.safeguarded) return no(SAFEGUARD_REASON);
  if (c.kind === "dm") {
    if (ctx.otherPresent === false) return no("That person isn't on batch0 anymore.");
    // Deliberately doesn't say who blocked whom.
    if (ctx.blocked) return no("You can't send messages in this conversation.");
  }
  return personalLock(viewer, ctx);
}

function personalLock(viewer: ChatViewer, ctx: { muted?: boolean; fined?: boolean }): Verdict {
  if (viewer.staff) return OK;
  if (ctx.muted) return no(MUTED_REASON);
  if (ctx.fined) return no(FINE_REASON);
  return OK;
}

/** Channel settings: staff for text channels; any member for a group; nobody for a DM. */
export function canManageChannel(c: Pick<ChannelScope, "id" | "kind">, viewer: ChatViewer): boolean {
  if (c.kind === "channel") return viewer.staff;
  if (c.kind === "group") return viewer.memberOf.includes(c.id);
  return false;
}

/** Pins: staff in text channels; either side of a DM; any member of a group. */
export function canPin(c: Pick<ChannelScope, "id" | "kind">, viewer: ChatViewer): boolean {
  if (c.kind === "channel") return viewer.staff;
  return viewer.memberOf.includes(c.id);
}

/** @everyone / @here: staff, in text channels only. */
export function canMentionEveryone(c: Pick<ChannelScope, "kind">, viewer: ChatViewer): boolean {
  return c.kind === "channel" && viewer.staff;
}

export type MessageScope = {
  senderId: string | null;
  kind: "message" | "system";
  deletedAt: string | null;
};

/** Your own messages only. System lines are nobody's to edit. */
export function canEditMessage(m: MessageScope, viewer: ChatViewer): boolean {
  return m.kind === "message" && !m.deletedAt && !!m.senderId && m.senderId === viewer.userId;
}

/**
 * Your own message, anywhere you can still read it; or staff removing
 * someone else's — in a text channel, or as a moderator in a DM or group that
 * was reported (the only way they can be reading one they're not in). Never
 * in a conversation they're a party to: a moderator in a DM is just one side
 * of it, and wiping the other side's words is evidence gone.
 */
export function canDeleteMessage(
  m: MessageScope,
  c: Pick<ChannelScope, "id" | "kind">,
  viewer: ChatViewer,
): boolean {
  if (m.deletedAt) return false;
  if (m.senderId && m.senderId === viewer.userId && m.kind === "message") return true;
  if (!viewer.staff) return false;
  return c.kind === "channel" || !isParticipant(c, viewer);
}

// ---------------------------------------------------------------------------
// DMs and groups
// ---------------------------------------------------------------------------

/**
 * The key that makes a DM between two people one row: the two ids, lowercased
 * and sorted. Which one clicked first must not matter, and neither may the
 * case a uuid arrived in (isUuid accepts both, Postgres stores lowercase), or
 * the unique index would let the same pair — or one person alone — exist.
 */
export function dmKey(x: string, y: string): string {
  const a = (x ?? "").toLowerCase();
  const b = (y ?? "").toLowerCase();
  if (!a || !b || a === b) throw new Error("A DM needs two different people.");
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}

/** The other person in a DM key, or null if the viewer isn't in it. */
export function otherInDmKey(key: string | null, userId: string): string | null {
  if (!key || key.startsWith("legacy:")) return null;
  const me = (userId ?? "").toLowerCase();
  const [a, b] = key.toLowerCase().split(":");
  if (!me) return null;
  if (a === me) return b || null;
  if (b === me) return a || null;
  return null;
}

/** A group's size, the viewer included. Discord's limit for a group DM. */
export const GROUP_MAX_MEMBERS = 10;

/**
 * May this viewer pick `others` other people for a new conversation? One
 * other person is a DM (createGroup opens that instead); two or more make a
 * group, which fits GROUP_MAX_MEMBERS with the viewer and is for people who've
 * been let in — a fresh signup can still DM the team.
 */
export function canStartGroup(viewer: ChatViewer, others: number): Verdict {
  if (others < 1) return no("Pick at least one person.");
  if (others + 1 > GROUP_MAX_MEMBERS) return no(`A group holds up to ${GROUP_MAX_MEMBERS} people.`);
  if (others > 1 && !viewer.staff && !viewer.vetted) {
    return no("Group chats open once you've been accepted. For now you can message the batch0 team.");
  }
  return OK;
}

// ---------------------------------------------------------------------------
// Safeguarding: students are 13–18, and batch0 promises (components/faq.tsx)
// there are no unmonitored private channels between students and adults.
// So a DM or group may not put a student alone with a non-staff adult — a
// mentor, an investor, a custom non-staff role. Those conversations happen in
// team and cohort channels, which staff can read. A group that includes a
// staff member is monitored by definition and is allowed. Students talk to
// each other, and anyone talks to staff, freely.
// ---------------------------------------------------------------------------

export type Party = {
  id: string;
  /** Holds the student role. */
  student: boolean;
  /** Runs chat (chat.manage or '*'). */
  staff: boolean;
};

/**
 * Said to everyone the rule stops, so it can't send anyone somewhere they
 * can't go: an investor or an intern reads no team or cohort channel, and
 * the team is the one door open to all of them.
 */
export const SAFEGUARD_REASON =
  "Students and adults outside the batch0 team don't message each other privately. Mentors and students talk in team and cohort channels, where the batch0 team can see the conversation. For anything else, message the batch0 team.";

/** May these people share a private conversation (a DM, or a group)? */
export function conversationAllowed(parties: readonly Party[]): boolean {
  if (parties.some((p) => p.staff)) return true;
  const hasStudent = parties.some((p) => p.student);
  const hasAdult = parties.some((p) => !p.student);
  return !(hasStudent && hasAdult);
}

export const ONLY_THE_TEAM_REASON =
  "For now you can message the batch0 team. Messaging other people opens once you've been accepted.";

/**
 * May the actor reach this person at all — the directory rule (0089's):
 * staff reach and are reachable by everyone; vetted people reach each other;
 * a fresh signup reaches staff only. No safeguarding here: a group checks
 * this per person and conversationAllowed once on the whole membership.
 */
export function reachVerdict(
  actor: Pick<ChatViewer, "staff" | "vetted">,
  recipient: { staff: boolean; vetted: boolean },
): Verdict {
  if (actor.staff || recipient.staff) return OK;
  if (!actor.vetted) return no(ONLY_THE_TEAM_REASON);
  if (!recipient.vetted) return no("That person isn't available.");
  return OK;
}

/**
 * May the actor open a DM with this person? Reachable first — so a fresh
 * signup learns nothing about a non-staff account, not even that the
 * safeguarding rule would apply to it — then the safeguarding rule for the
 * pair.
 */
export function dmVerdict(
  actor: Pick<ChatViewer, "staff" | "vetted"> & { party: Party | null },
  recipient: Party & { vetted: boolean },
): Verdict {
  const reach = reachVerdict(actor, recipient);
  if (!reach.ok || actor.staff || recipient.staff) return reach;
  if (actor.party && !conversationAllowed([actor.party, recipient])) return no(SAFEGUARD_REASON);
  return OK;
}

/** What a group is called when nobody named it: the other people, by name. */
export function groupDisplayName(
  name: string | null,
  memberNames: readonly { id: string; name: string }[],
  viewerId: string,
): string {
  if (name?.trim()) return name.trim();
  const others = memberNames.filter((m) => m.id !== viewerId).map((m) => m.name);
  if (others.length === 0) return "Just you";
  if (others.length <= 3) return others.join(", ");
  return `${others.slice(0, 3).join(", ")} +${others.length - 3}`;
}

// ---------------------------------------------------------------------------
// Slow mode, unread, bells
// ---------------------------------------------------------------------------

/**
 * Seconds this person still has to wait before posting again, or 0. Staff are
 * exempt; so is everyone in a DM or group.
 */
export function slowModeWait(
  c: Pick<ChannelScope, "kind" | "slowmodeSeconds">,
  viewer: ChatViewer,
  lastSentAt: string | null,
  nowMs: number,
): number {
  if (c.kind !== "channel" || viewer.staff || c.slowmodeSeconds <= 0 || !lastSentAt) return 0;
  const last = Date.parse(lastSentAt);
  if (!Number.isFinite(last)) return 0;
  const left = c.slowmodeSeconds * 1000 - (nowMs - last);
  return left > 0 ? Math.ceil(left / 1000) : 0;
}

/**
 * The notification preference in force. Unset means the default: every
 * message in a DM or group, mentions only in a text channel.
 */
export function effectiveNotify(kind: ChannelKind, pref: NotifyPref | null | undefined): NotifyPref {
  if (pref === "all" || pref === "mentions" || pref === "none") return pref;
  return kind === "channel" ? "mentions" : "all";
}

/**
 * What one channel adds to the Chat badge: a text channel its mentions, a DM
 * or group 1 while anything in it is unread. Nothing when it's muted, and
 * nothing for a conversation closed since its last message — the sidebar's
 * rule, so the badge never counts what the sidebar shows as read.
 */
export function attentionFor(
  kind: ChannelKind,
  counts: { unread: number; mentions: number },
  pref: NotifyPref | null | undefined,
  visible: boolean,
): number {
  if (effectiveNotify(kind, pref) === "none") return 0;
  if (kind === "channel") return counts.mentions;
  return visible && counts.unread > 0 ? 1 : 0;
}

/** Does this message concern this recipient enough to ring a bell at all? */
export function wantsBell(
  kind: ChannelKind,
  pref: NotifyPref | null | undefined,
  mentioned: boolean,
): boolean {
  const p = effectiveNotify(kind, pref);
  if (p === "none") return false;
  if (p === "all") return true;
  return mentioned;
}

/**
 * A bell's title. Never the words, and never a group's name or members: an
 * admin can read every notification row, so a title naming the group would
 * be a staff read path into an unreported conversation (and an unnamed
 * group's "name" is its members, the recipient included).
 */
export function bellTitle(
  kind: ChannelKind,
  input: { sender: string; channelName: string | null; mentioned: boolean; everyone: boolean },
): string {
  if (kind === "dm") return `${input.sender} messaged you`;
  if (kind === "group") return `${input.sender} in a group chat`;
  const where = `#${input.channelName ?? "channel"}`;
  if (input.everyone) return `${input.sender} pinged everyone in ${where}`;
  if (input.mentioned) return `${input.sender} mentioned you in ${where}`;
  return `${input.sender} posted in ${where}`;
}

/**
 * How far back a text channel someone has never opened counts as unread —
 * chat_unread()'s window in 0101, so joining a cohort doesn't open on "99+".
 */
export const UNREAD_LOOKBACK_MS = 14 * 24 * 60 * 60_000;

/**
 * Where the "new" line goes when there's no read cursor yet: a text channel
 * counts from UNREAD_LOOKBACK_MS back (what the sidebar badge counted), a DM
 * or group from the start.
 */
export function defaultReadCursor(kind: ChannelKind, nowMs: number): string {
  return new Date(kind === "channel" ? nowMs - UNREAD_LOOKBACK_MS : 0).toISOString();
}

/**
 * How recently a recipient must have had the channel open to count as being
 * in it right now. They're looking at it, and the live view shows the
 * message, so no bell.
 */
export const BELL_QUIET_MS = 2 * 60_000;

/**
 * One bell per burst (the 0089 rule): not while an unread bell for this
 * channel already points at it, and not while they're in it right now.
 */
export function shouldBell(
  input: { recipientSeenAt: string | null; hasUnreadBell: boolean },
  nowMs: number,
): boolean {
  if (input.hasUnreadBell) return false;
  const seen = input.recipientSeenAt ? Date.parse(input.recipientSeenAt) : NaN;
  return !(Number.isFinite(seen) && nowMs - seen < BELL_QUIET_MS);
}

/**
 * The later of two Postgres timestamps. Compared as instants, the string form
 * breaking a tie: Date.parse keeps milliseconds, Postgres keeps microseconds,
 * and within one format a longer fraction sorts later as a string.
 */
export function laterTimestamp(a: string, b: string): string {
  const da = Date.parse(a);
  const db = Date.parse(b);
  if (!Number.isFinite(da)) return b;
  if (!Number.isFinite(db)) return a;
  if (da !== db) return da > db ? a : b;
  return a >= b ? a : b;
}

/** Is `a` strictly after `b`? Same instant-then-string rule. */
export function isAfter(a: string, b: string): boolean {
  return a !== b && laterTimestamp(a, b) === a;
}

/** Badge text: a count, capped the way the sidebar shows it. */
export function badgeText(n: number): string {
  if (n <= 0) return "";
  return n > 99 ? "99+" : String(n);
}

// ---------------------------------------------------------------------------
// Names, limits, reactions
// ---------------------------------------------------------------------------

export const MESSAGE_MAX = 4000;
export const TOPIC_MAX = 300;
export const CHANNEL_NAME_MAX = 80;
export const GROUP_NAME_MAX = 80;
export const REPORT_REASON_MAX = 2000;
export const SLOWMODE_CHOICES = [0, 5, 10, 30, 60, 120, 300, 900, 3600] as const;

/**
 * A Discord-style channel name: lowercase letters, digits and single hyphens.
 * "Fall 2026 — Team A!" → "fall-2026-team-a". Matches the check constraint
 * on chat_channels.name.
 */
export function normalizeChannelName(input: string): string {
  return input
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, CHANNEL_NAME_MAX)
    .replace(/-+$/g, "");
}

export const CHANNEL_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,79}$/;

/**
 * A post from outside the composer (an announcement cross-post), fitted to
 * MESSAGE_MAX: trimmed, and when it's longer, cut at the last word break
 * that leaves room for "…" and the link to the full text — never a post that
 * just stops mid-sentence.
 */
export function fitPostBody(raw: string, link?: string): string {
  const body = raw.trim();
  if (body.length <= MESSAGE_MAX) return body;
  const tail = link ? `…\n\nRead the rest: ${link}` : "…";
  const room = MESSAGE_MAX - tail.length;
  const cut = body.slice(0, room);
  const space = Math.max(cut.lastIndexOf(" "), cut.lastIndexOf("\n"));
  // A word break near the end; otherwise (one enormous word) a hard cut.
  const head = (space > room * 0.8 ? cut.slice(0, space) : cut).trimEnd();
  return `${head}${tail}`;
}

/**
 * The reaction palette. A fixed set rather than any string: it keeps the
 * column honest, and the picker shows exactly what the server accepts.
 */
export const REACTION_EMOJI = [
  "👍", "❤️", "😂", "🎉", "🔥", "👀", "🙏", "✅",
  "💯", "🚀", "😮", "😢", "👏", "🤔", "💡", "🙌",
  "😅", "😍", "🤝", "📈", "💸", "🧠", "⚡", "🏆",
  "👎", "❌", "⭐", "🫡", "😎", "🥳", "💀", "🤯",
] as const;

const REACTION_SET: ReadonlySet<string> = new Set(REACTION_EMOJI);

export function isAllowedReaction(emoji: string): boolean {
  return REACTION_SET.has(emoji);
}

/** Reactions as stored on the message: emoji → the ids who reacted. */
export type ReactionMap = Record<string, string[]>;

/** Ordered for display: most reacted first, then palette order. */
export function sortedReactions(map: ReactionMap | null | undefined): { emoji: string; userIds: string[] }[] {
  const order = new Map<string, number>(REACTION_EMOJI.map((e, i) => [e, i]));
  return Object.entries(map ?? {})
    .filter(([, ids]) => Array.isArray(ids) && ids.length > 0)
    .map(([emoji, userIds]) => ({ emoji, userIds }))
    .sort(
      (a, b) =>
        b.userIds.length - a.userIds.length ||
        (order.get(a.emoji) ?? 999) - (order.get(b.emoji) ?? 999),
    );
}

/** Apply one toggle to a reaction map, for the optimistic UI. */
export function toggleReaction(map: ReactionMap, emoji: string, userId: string): ReactionMap {
  const next: ReactionMap = {};
  for (const [e, ids] of Object.entries(map)) next[e] = [...ids];
  const ids = next[emoji] ?? [];
  if (ids.includes(userId)) {
    const rest = ids.filter((id) => id !== userId);
    if (rest.length > 0) next[emoji] = rest;
    else delete next[emoji];
  } else {
    next[emoji] = [...ids, userId];
  }
  return next;
}

// ---------------------------------------------------------------------------
// Sidebar ordering
// ---------------------------------------------------------------------------

export type SidebarSortable = {
  kind: ChannelKind;
  position: number;
  name: string;
  lastMessageAt: string | null;
};

/** Text channels by position then name. */
export function compareChannels(a: SidebarSortable, b: SidebarSortable): number {
  return a.position - b.position || a.name.localeCompare(b.name);
}

/** DMs and groups: most recent conversation first; never-used ones last. */
export function compareConversations(a: SidebarSortable, b: SidebarSortable): number {
  if (a.lastMessageAt && b.lastMessageAt) {
    if (a.lastMessageAt === b.lastMessageAt) return a.name.localeCompare(b.name);
    return isAfter(a.lastMessageAt, b.lastMessageAt) ? -1 : 1;
  }
  if (a.lastMessageAt) return -1;
  if (b.lastMessageAt) return 1;
  return a.name.localeCompare(b.name);
}

/**
 * Is a closed DM or group back in the sidebar? Closing hides it until a
 * message newer than the close arrives.
 */
export function isConversationVisible(hiddenAt: string | null, lastMessageAt: string | null): boolean {
  if (!hiddenAt) return true;
  return !!lastMessageAt && isAfter(lastMessageAt, hiddenAt);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Is this a real id? Anything else from a URL or a form is nobody. */
export function isUuid(id: unknown): id is string {
  return typeof id === "string" && UUID_RE.test(id);
}

/**
 * A uuid from outside, in the one case Postgres stores it in: lowercase, or
 * null for anything that isn't one. Ids are compared as strings all over (DM
 * keys, member lists, people maps), so an uppercase copy of a real id would
 * otherwise be a different person.
 */
export function asUuid(id: unknown): string | null {
  return isUuid(id) ? id.toLowerCase() : null;
}

/** Mention autocomplete beyond the preloaded list: how many people one search returns. */
export const PEOPLE_SEARCH_MAX = 8;
