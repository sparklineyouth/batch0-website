// ---------------------------------------------------------------------------
// Direct messages — the rules, as pure functions.
//
// Dependency-free on purpose, so the same predicate runs in a server
// component, in a server action, in the client popup, and (in spirit) in the
// SQL functions dm_can_read_conversation() / dm_is_participant() /
// dm_is_blocked() in migration 0089. Keep them in lockstep: the SQL is the
// backstop, these are what the product actually behaves like.
// ---------------------------------------------------------------------------

/**
 * A conversation, reduced to what any rule here needs to decide. A side is
 * null once that account has been deleted: the conversation outlives it, so
 * the other person keeps their history (and a report keeps its evidence).
 */
export type ConversationScope = {
  id: string;
  userA: string | null;
  userB: string | null;
};

export type DmViewer = {
  userId: string;
  /** Holds `moderation.manage` (or the '*' wildcard). */
  moderates: boolean;
};

/**
 * The ordered pair. A DM between two people is one row, and which of the two
 * lands in `user_a` must not depend on who clicked first — otherwise the
 * unique index lets the same pair exist twice. Sorting the ids is the whole
 * trick, and the `dm_conversations_ordered` check constraint refuses any row
 * that didn't do it.
 */
export function orderPair(x: string, y: string): { userA: string; userB: string } {
  return x < y ? { userA: x, userB: y } : { userA: y, userB: x };
}

/**
 * The other person — null when their account has been deleted. Throws rather
 * than guess if the viewer isn't in it.
 */
export function otherParticipant(c: ConversationScope, userId: string): string | null {
  if (!userId) throw new Error("Not your conversation.");
  if (c.userA === userId) return c.userB;
  if (c.userB === userId) return c.userA;
  throw new Error("Not your conversation.");
}

export function isParticipant(c: ConversationScope, userId: string): boolean {
  return !!userId && (c.userA === userId || c.userB === userId);
}

/**
 * Who may read a conversation: its two participants, always — plus a
 * moderator, but only once it has been reported. A DM nobody reported has no
 * staff read path, and that is a promise the UI makes out loud, so `reported`
 * is a required argument rather than an optional one someone can forget.
 */
export function canReadConversation(
  c: ConversationScope,
  viewer: DmViewer,
  reported: boolean,
): boolean {
  if (isParticipant(c, viewer.userId)) return true;
  return viewer.moderates && reported;
}

/**
 * Who may post. Reading isn't enough on two counts: a moderator looking at a
 * reported thread is not a party to it, and a block freezes the thread for
 * both sides while leaving the history intact.
 */
export function canSendToConversation(
  c: ConversationScope,
  viewer: DmViewer,
  blocked: boolean,
): boolean {
  // Nobody is left to receive a message once the other account is gone.
  return !blocked && isParticipant(c, viewer.userId) && !!c.userA && !!c.userB;
}

/**
 * Unread, for one side. `sender !== me` is the load-bearing half: your own
 * message is never unread to you, whatever your cursor says — which is why
 * sending doesn't need to move your own cursor.
 */
export function unreadCount(
  messages: readonly { senderId: string; createdAt: string }[],
  userId: string,
  lastReadAt: string,
): number {
  return messages.filter(
    (m) => m.senderId !== userId && m.createdAt > lastReadAt,
  ).length;
}

/** This viewer's read cursor on a conversation row. */
export function cursorFor(
  c: ConversationScope & { aLastReadAt: string; bLastReadAt: string },
  userId: string,
): string {
  return c.userA === userId ? c.aLastReadAt : c.bLastReadAt;
}

/** Which column a mark-as-read writes to. */
export function cursorColumnFor(
  c: ConversationScope,
  userId: string,
): "a_last_read_at" | "b_last_read_at" {
  if (c.userA === userId) return "a_last_read_at";
  if (c.userB === userId) return "b_last_read_at";
  throw new Error("Not your conversation.");
}

/**
 * Whether a conversation has anything unread for this viewer, from the
 * denormalised columns alone — no message rows needed. This is what the inbox
 * list and the popup badge use, so a 40-row inbox is one query.
 */
export function hasUnread(
  c: ConversationScope & {
    aLastReadAt: string;
    bLastReadAt: string;
    lastMessageAt: string | null;
    lastSenderId: string | null;
  },
  userId: string,
): boolean {
  if (!c.lastMessageAt) return false;
  // Own last message: nothing to catch up on by definition.
  if (c.lastSenderId === userId) return false;
  return c.lastMessageAt > cursorFor(c, userId);
}

/**
 * How recently a recipient must have read a conversation to count as being in
 * it right now. A message to someone who read the thread within this window
 * rings no bell — they are looking at it, and the live thread shows it.
 */
export const BELL_QUIET_MS = 2 * 60_000;

/**
 * Should this message ring the recipient's bell? One bell per burst: only
 * when they had caught up (anything unread already has a bell pointing at
 * it) AND they are not in the conversation right now. Without the second
 * half, a live back-and-forth rang the bell on every single message, because
 * reading each message as it arrives puts the reader back to "caught up".
 */
export function shouldBell(
  c: ConversationScope & {
    aLastReadAt: string;
    bLastReadAt: string;
    lastMessageAt: string | null;
    lastSenderId: string | null;
  },
  recipientId: string,
  nowMs: number,
): boolean {
  if (hasUnread(c, recipientId)) return false;
  const readAt = Date.parse(cursorFor(c, recipientId));
  return !(Number.isFinite(readAt) && nowMs - readAt < BELL_QUIET_MS);
}

/**
 * The later of two Postgres timestamps. Compared as instants, with the
 * string form breaking a tie: Date.parse keeps milliseconds, Postgres keeps
 * microseconds, and within one timestamp format a longer fraction sorts
 * later as a string.
 */
export function laterTimestamp(a: string, b: string): string {
  const da = Date.parse(a);
  const db = Date.parse(b);
  if (!Number.isFinite(da)) return b;
  if (!Number.isFinite(db)) return a;
  if (da !== db) return da > db ? a : b;
  return a >= b ? a : b;
}

export const MESSAGE_MAX = 4000;
export const REPORT_REASON_MAX = 2000;
/** Longest preview the trigger stores on the conversation row. */
export const PREVIEW_MAX = 140;

export type ReportStatus = "open" | "actioned" | "dismissed";
