import "server-only";
import {
  asUuid,
  canManageChannel,
  canMentionEveryone,
  canPin,
  canPost,
  defaultReadCursor,
  dmKey,
  effectiveNotify,
  groupDisplayName,
  isParticipant,
  otherInDmKey,
  slowModeWait,
  SAFEGUARD_REASON,
  type Audience,
  type ChannelKind,
  type ChatViewer,
  type NotifyPref,
  type Posting,
  type Verdict,
  FINE_REASON,
  MUTED_REASON,
} from "@/lib/chat-access";
import {
  canStartConversation,
  countPins,
  findDm,
  getChannelBySystemKey,
  getChannelForViewer,
  getPeople,
  getPerson,
  getReads,
  hasPendingFine,
  isBlockedBetween,
  isMuted,
  lastSentAt,
  listBlockedIds,
  listMembers,
  listMessages,
  membershipAllowed,
  DELETED_NAME,
  type ChannelRow,
  type ChatMessage,
  type ChatPerson,
  type ReadRow,
} from "@/lib/chat";

/**
 * One channel's on-screen state, built in one place.
 *
 * Both entry points use it: /chat server-renders the first channel so it
 * arrives with the document, and the fetchChannel action returns it on every
 * switch. If the two could disagree, the weaker would become the real rule
 * (the lesson of lib/dm-thread.ts, which this replaces).
 */

export type ChannelInfo = {
  id: string;
  kind: ChannelKind;
  /** "general", "Maya Chen", "Ann, Bo". */
  label: string;
  /** The stored name (channels and named groups). */
  name: string | null;
  topic: string | null;
  audience: Audience;
  posting: Posting;
  archived: boolean;
  slowmodeSeconds: number;
  systemKey: string | null;
  teamId: string | null;
  cohortId: string | null;
  /** DM: the other person, null once their account is gone. */
  otherId: string | null;
  /** DM/group: explicit members. */
  memberIds: string[];
  compose: Verdict;
  /**
   * May react (toggleReaction's rule): a text channel's readers — even where
   * only staff post — unless muted or fined; in a DM or group, whoever may
   * post. Never in an archived channel or a moderator's view.
   */
  canReact: boolean;
  canManage: boolean;
  canPin: boolean;
  canMentionEveryone: boolean;
  /** A moderator reading a reported DM or group: read-only, and it says so. */
  moderatorView: boolean;
  /** DM: the viewer did the blocking, so the UI can offer Unblock. Being blocked is never announced. */
  blockedByYou: boolean;
  notify: NotifyPref;
  notifyIsDefault: boolean;
  /** Seconds left before slow mode lets the viewer post again. */
  slowmodeWait: number;
  messageCount: number;
};

export type ChannelPayload = {
  /** Null for a DM that doesn't exist yet: a draft to `draftTo`. */
  channel: ChannelInfo | null;
  draftTo: ChatPerson | null;
  draftCompose: Verdict | null;
  messages: ChatMessage[];
  hasMoreBefore: boolean;
  hasMoreAfter: boolean;
  /** The viewer's read cursor as it was on load: where the "new" line goes. */
  cursor: string;
  /** Everyone the messages and the header name. */
  people: Record<string, ChatPerson>;
  pins: number;
  /** The message to scroll to and flash, when opened around one. */
  focusId: string | null;
};

export type ChannelTarget =
  | { channelId: string; around?: string | null }
  | { withUserId: string }
  | { teamId: string }
  | { systemKey: string };

const EPOCH = new Date(0).toISOString();

/**
 * The ids a page of messages needs names for — only ids the server put
 * there or vetted: senders, reactors, the reply's sender, and mentions as
 * filterReaders kept them (`m.mentions`, the reply's stored mentions). A
 * <@id> someone typed for anyone else stays a bare token and renders as
 * "@unknown", or any message could look up any account's name and role.
 */
export function peopleIn(messages: readonly ChatMessage[]): string[] {
  const ids = new Set<string>();
  for (const m of messages) {
    if (m.senderId) ids.add(m.senderId);
    for (const id of m.mentions) ids.add(id);
    if (m.replyTo?.senderId) ids.add(m.replyTo.senderId);
    for (const id of m.replyTo?.mentions ?? []) ids.add(id);
    for (const ids2 of Object.values(m.reactions)) for (const id of ids2) ids.add(id);
  }
  return Array.from(ids);
}

/**
 * Resolve a target to a channel the viewer may read, or a DM draft. Null for
 * anything they can't see — the same answer as "doesn't exist".
 */
export async function buildChannelPayload(viewer: ChatViewer, target: ChannelTarget): Promise<ChannelPayload | null> {
  if ("withUserId" in target) {
    const other = asUuid(target.withUserId);
    if (!other || other === viewer.userId) return null;
    const existing = await findDm(dmKey(viewer.userId, other));
    if (existing) return byChannel(viewer, existing.id, null);
    const person = await getPerson(other);
    if (!person) return null;
    // Someone the viewer may not cold-message looks like nobody at all —
    // except for the safeguarding rule, which is policy, not a secret, so
    // the draft opens and says why it can't be sent. canStartConversation
    // answers "not reachable" before it ever gets to safeguarding, so a
    // fresh signup can't use this to read a mentor's name and role.
    const allowed = await canStartConversation(viewer, person);
    if (!allowed.ok && allowed.reason !== SAFEGUARD_REASON) return null;
    const [frozen, locked] = await Promise.all([isBlockedBetween(viewer.userId, other), personalLocks(viewer, person)]);
    return {
      channel: null,
      draftTo: person,
      draftCompose: !allowed.ok
        ? allowed
        : frozen
          ? { ok: false, reason: "You can't send messages to this person." }
          : locked.muted
            ? { ok: false, reason: MUTED_REASON }
            : locked.fined
              ? { ok: false, reason: FINE_REASON }
              : { ok: true },
      messages: [],
      hasMoreBefore: false,
      hasMoreAfter: false,
      cursor: EPOCH,
      people: { [person.id]: person },
      pins: 0,
      focusId: null,
    };
  }
  if ("teamId" in target) {
    const teamId = asUuid(target.teamId);
    if (!teamId) return null;
    const row = await getChannelBySystemKey(`team:${teamId}`);
    return row ? byChannel(viewer, row.id, null) : null;
  }
  if ("systemKey" in target) {
    const row = await getChannelBySystemKey(target.systemKey);
    return row ? byChannel(viewer, row.id, null) : null;
  }
  return byChannel(viewer, target.channelId, target.around ?? null);
}

async function byChannel(viewer: ChatViewer, id: string, around: string | null): Promise<ChannelPayload | null> {
  const found = await getChannelForViewer(id, viewer);
  if (!found) return null;
  const { channel, reported } = found;
  const [{ info, read }, page, pins] = await Promise.all([
    describe(viewer, channel, reported),
    listMessages(channel.id, around ? { around } : {}),
    countPins(channel.id),
  ]);
  const people = await getPeople([...peopleIn(page.messages), ...info.memberIds, info.otherId]);
  return {
    channel: info,
    draftTo: null,
    draftCompose: null,
    messages: page.messages,
    hasMoreBefore: page.hasMoreBefore,
    hasMoreAfter: page.hasMoreAfter,
    // A text channel never opened starts its "new" line where its badge
    // started counting, not at the dawn of time.
    cursor: info.moderatorView ? new Date().toISOString() : (read?.last_read_at ?? defaultReadCursor(channel.kind, Date.now())),
    people: Object.fromEntries(people),
    pins,
    focusId: around && page.messages.some((m) => m.id === around) ? around : null,
  };
}

/**
 * The two locks that follow a person rather than a channel: a chat mute and
 * a pending fine. Staff carry neither, and both leave one door open — a DM
 * with the batch0 team, so someone muted or fined can still ask about it.
 */
export async function personalLocks(
  viewer: ChatViewer,
  dmWith: Pick<ChatPerson, "isStaff"> | null,
): Promise<{ muted: boolean; fined: boolean }> {
  if (viewer.staff || dmWith?.isStaff) return { muted: false, fined: false };
  const [muted, fined] = await Promise.all([isMuted(viewer.userId), hasPendingFine(viewer.userId)]);
  return { muted, fined };
}

/** The header, the composer's state and every permission flag for one channel. */
export async function describeChannel(viewer: ChatViewer, channel: ChannelRow, reported: boolean): Promise<ChannelInfo> {
  return (await describe(viewer, channel, reported)).info;
}

async function describe(
  viewer: ChatViewer,
  channel: ChannelRow,
  reported: boolean,
): Promise<{ info: ChannelInfo; read: ReadRow | null }> {
  const members = channel.kind === "channel" ? [] : ((await listMembers([channel.id])).get(channel.id) ?? []);
  const participant = isParticipant(channel, viewer);
  const otherId = channel.kind === "dm" ? otherInDmKey(channel.dmKey, viewer.userId) : null;
  // A moderator reading a reported DM is neither side of it: name both.
  const named = channel.kind === "group" || (channel.kind === "dm" && !participant) ? members : otherId ? [otherId] : [];
  const [people, reads, blocked, frozen, last, allowed] = await Promise.all([
    getPeople(named),
    participant || channel.kind === "channel" ? getReads(viewer.userId, [channel.id]) : Promise.resolve(new Map<string, ReadRow>()),
    channel.kind === "dm" && participant ? listBlockedIds(viewer.userId) : Promise.resolve([] as string[]),
    channel.kind === "dm" && participant && otherId ? isBlockedBetween(viewer.userId, otherId) : Promise.resolve(false),
    channel.kind === "channel" && channel.slowmodeSeconds > 0 && !viewer.staff
      ? lastSentAt(channel.id, viewer.userId)
      : Promise.resolve(null),
    channel.kind !== "channel" && participant ? membershipAllowed(members) : Promise.resolve(true),
  ]);
  const otherPresent = channel.kind === "dm" ? !!otherId && people.has(otherId) && members.includes(otherId) : true;
  // Only someone who could otherwise post pays for the mute and fine lookups.
  const locks =
    channel.kind === "channel" || participant
      ? await personalLocks(viewer, channel.kind === "dm" && otherId ? (people.get(otherId) ?? null) : null)
      : { muted: false, fined: false };

  let label = channel.name ?? "channel";
  if (channel.kind === "dm") {
    label = participant
      ? otherId
        ? (people.get(otherId)?.name ?? DELETED_NAME)
        : DELETED_NAME
      : members.length
        ? members.map((m) => people.get(m)?.name ?? DELETED_NAME).join(" & ")
        : DELETED_NAME;
  } else if (channel.kind === "group") {
    label = groupDisplayName(
      channel.name,
      members.map((m) => ({ id: m, name: people.get(m)?.name ?? DELETED_NAME })),
      viewer.userId,
    );
  }
  const read = reads.get(channel.id) ?? null;
  const pref = (read?.notify ?? null) as NotifyPref | null;
  const compose = canPost(channel, viewer, {
    reported,
    blocked: frozen,
    otherPresent,
    safeguarded: !allowed,
    muted: locks.muted,
    fined: locks.fined,
  });
  const moderatorView = channel.kind !== "channel" && !participant;
  return {
    read,
    info: {
      id: channel.id,
      kind: channel.kind,
      label,
      name: channel.name,
      topic: channel.topic,
      audience: channel.audience,
      posting: channel.posting,
      archived: !!channel.archivedAt,
      slowmodeSeconds: channel.slowmodeSeconds,
      systemKey: channel.systemKey,
      teamId: channel.teamId,
      cohortId: channel.cohortId,
      otherId: participant && otherPresent ? otherId : null,
      memberIds: members,
      compose,
      canReact:
        !channel.archivedAt &&
        !moderatorView &&
        (channel.kind === "channel" ? !locks.muted && !locks.fined : compose.ok),
      canManage: canManageChannel(channel, viewer),
      canPin: canPin(channel, viewer),
      canMentionEveryone: canMentionEveryone(channel, viewer),
      moderatorView,
      blockedByYou: !!otherId && blocked.includes(otherId),
      notify: effectiveNotify(channel.kind, pref),
      notifyIsDefault: pref === null,
      slowmodeWait: slowModeWait(channel, viewer, last, Date.now()),
      messageCount: channel.messageCount,
    },
  };
}
