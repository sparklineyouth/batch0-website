import "server-only";
import {
  canManageChannel,
  canMentionEveryone,
  canPin,
  canPost,
  dmKey,
  effectiveNotify,
  groupDisplayName,
  isParticipant,
  isUuid,
  otherInDmKey,
  slowModeWait,
  SAFEGUARD_REASON,
  type Audience,
  type ChannelKind,
  type ChatViewer,
  type NotifyPref,
  type Posting,
  type Verdict,
} from "@/lib/chat-access";
import { mentionedIds } from "@/lib/chat-format";
import {
  canStartConversation,
  findDm,
  getChannelBySystemKey,
  getChannelForViewer,
  getPeople,
  getPerson,
  getReads,
  isBlockedBetween,
  lastSentAt,
  listBlockedIds,
  listMembers,
  listMessages,
  listPins,
  membershipAllowed,
  DELETED_NAME,
  type ChannelRow,
  type ChatMessage,
  type ChatPerson,
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

/** The ids a page of messages needs names for. */
export function peopleIn(messages: readonly ChatMessage[]): string[] {
  const ids = new Set<string>();
  for (const m of messages) {
    if (m.senderId) ids.add(m.senderId);
    for (const id of m.mentions) ids.add(id);
    for (const id of mentionedIds(m.body)) ids.add(id);
    if (m.replyTo?.senderId) ids.add(m.replyTo.senderId);
    if (m.replyTo?.preview) for (const id of mentionedIds(m.replyTo.preview)) ids.add(id);
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
    const other = target.withUserId;
    if (!isUuid(other) || other === viewer.userId) return null;
    const existing = await findDm(dmKey(viewer.userId, other));
    if (existing) return byChannel(viewer, existing.id, null);
    const person = await getPerson(other);
    if (!person) return null;
    // Someone the viewer may not cold-message looks like nobody at all —
    // except for the safeguarding rule, which is policy, not a secret, so
    // the draft opens and says why it can't be sent.
    const allowed = await canStartConversation(viewer, person);
    if (!allowed.ok && allowed.reason !== SAFEGUARD_REASON) return null;
    const frozen = await isBlockedBetween(viewer.userId, other);
    return {
      channel: null,
      draftTo: person,
      draftCompose: !allowed.ok
        ? allowed
        : frozen
          ? { ok: false, reason: "You can't send messages to this person." }
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
    if (!isUuid(target.teamId)) return null;
    const row = await getChannelBySystemKey(`team:${target.teamId}`);
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
  const info = await describeChannel(viewer, channel, reported);
  const [page, reads, pins] = await Promise.all([
    listMessages(channel.id, around ? { around } : {}),
    info.moderatorView ? Promise.resolve(new Map()) : getReads(viewer.userId, [channel.id]),
    listPins(channel.id),
  ]);
  const people = await getPeople([...peopleIn(page.messages), ...info.memberIds, info.otherId]);
  return {
    channel: info,
    draftTo: null,
    draftCompose: null,
    messages: page.messages,
    hasMoreBefore: page.hasMoreBefore,
    hasMoreAfter: page.hasMoreAfter,
    cursor: info.moderatorView ? new Date().toISOString() : (reads.get(channel.id)?.last_read_at ?? EPOCH),
    people: Object.fromEntries(people),
    pins: pins.length,
    focusId: around && page.messages.some((m) => m.id === around) ? around : null,
  };
}

/** The header, the composer's state and every permission flag for one channel. */
export async function describeChannel(viewer: ChatViewer, channel: ChannelRow, reported: boolean): Promise<ChannelInfo> {
  const members = channel.kind === "channel" ? [] : ((await listMembers([channel.id])).get(channel.id) ?? []);
  const participant = isParticipant(channel, viewer);
  const otherId = channel.kind === "dm" ? otherInDmKey(channel.dmKey, viewer.userId) : null;
  const [people, reads, blocked, frozen, last, allowed] = await Promise.all([
    getPeople(channel.kind === "group" ? members : otherId ? [otherId] : []),
    participant || channel.kind === "channel" ? getReads(viewer.userId, [channel.id]) : Promise.resolve(new Map()),
    channel.kind === "dm" && participant ? listBlockedIds(viewer.userId) : Promise.resolve([] as string[]),
    channel.kind === "dm" && participant && otherId ? isBlockedBetween(viewer.userId, otherId) : Promise.resolve(false),
    channel.kind === "channel" && channel.slowmodeSeconds > 0 && !viewer.staff
      ? lastSentAt(channel.id, viewer.userId)
      : Promise.resolve(null),
    channel.kind !== "channel" && participant ? membershipAllowed(members) : Promise.resolve(true),
  ]);
  const otherPresent = channel.kind === "dm" ? !!otherId && people.has(otherId) && members.includes(otherId) : true;

  let label = channel.name ?? "channel";
  if (channel.kind === "dm") {
    label = otherId ? (people.get(otherId)?.name ?? DELETED_NAME) : DELETED_NAME;
  } else if (channel.kind === "group") {
    label = groupDisplayName(
      channel.name,
      members.map((m) => ({ id: m, name: people.get(m)?.name ?? DELETED_NAME })),
      viewer.userId,
    );
  }
  const pref = (reads.get(channel.id)?.notify ?? null) as NotifyPref | null;
  return {
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
    otherId: otherPresent ? otherId : null,
    memberIds: members,
    compose: canPost(channel, viewer, { reported, blocked: frozen, otherPresent, safeguarded: !allowed }),
    canManage: canManageChannel(channel, viewer),
    canPin: canPin(channel, viewer),
    canMentionEveryone: canMentionEveryone(channel, viewer),
    moderatorView: channel.kind !== "channel" && !participant,
    blockedByYou: !!otherId && blocked.includes(otherId),
    notify: effectiveNotify(channel.kind, pref),
    notifyIsDefault: pref === null,
    slowmodeWait: slowModeWait(channel, viewer, last, Date.now()),
    messageCount: channel.messageCount,
  };
}
