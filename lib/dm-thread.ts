import "server-only";
import {
  canStartConversation,
  deletedPerson,
  findConversation,
  getConversationForViewer,
  getPerson,
  isBlockedBetween,
  listBlockedIds,
  listMessages,
  type DmMessage,
  type DmPerson,
} from "@/lib/dm";
import {
  canSendToConversation,
  cursorFor,
  isParticipant,
  otherParticipant,
  type DmViewer,
} from "@/lib/dm-access";

/**
 * Building one conversation's on-screen state, in one place.
 *
 * Both entry points go through here: the full page server-renders it so the
 * thread arrives with the document, and the `fetchThread` server action
 * returns it to the popup. They must agree exactly — if the popup could reach
 * a conversation on terms the page wouldn't allow, the weaker of the two
 * surfaces becomes the real access rule.
 */

export type ThreadPayload = {
  /** Null for a conversation that doesn't exist yet — a draft to one person. */
  conversationId: string | null;
  other: DmPerson;
  messages: DmMessage[];
  /** The viewer's read cursor as it was on load, for the "new" divider. */
  cursor: string;
  /** Whether the composer is live. */
  canSend: boolean;
  /**
   * True when the viewer did the blocking, so the UI can offer Unblock.
   * Deliberately distinct from `frozen`: if the OTHER side blocked, the viewer
   * learns only that they can't send. Being blocked is never announced.
   */
  blockedByYou: boolean;
  /** Either side has blocked. Sending is off for both; the history stays. */
  frozen: boolean;
  /** A moderator reading a reported thread: read-only, and it says so. */
  moderatorView: boolean;
  /**
   * The other account has been deleted. The history stays, read-only, and
   * there's nobody to block or write to. (Deliberately no "reported" flag:
   * only a participant can report a DM, so telling the other participant a
   * report exists would tell them who filed it.)
   */
  otherDeleted: boolean;
};

const DELETED: Omit<DmPerson, "id"> = {
  name: "Deleted account",
  roleLabel: null,
  isStaff: false,
};

/**
 * By conversation id, or by person. Returns null when there is nothing the
 * viewer may see — the same answer for "no such conversation" and "not yours",
 * so a guessed id can't confirm a DM exists.
 */
export async function buildThreadPayload(
  viewer: DmViewer,
  input: { conversationId?: string; withUserId?: string },
): Promise<ThreadPayload | null> {
  if (input.conversationId) return byConversation(viewer, input.conversationId);

  const withUserId = input.withUserId;
  if (!withUserId || withUserId === viewer.userId) return null;

  // An existing conversation always wins; otherwise this is a draft and no row
  // is created until the first message actually sends.
  const existing = await findConversation(viewer.userId, withUserId);
  if (existing) return byConversation(viewer, existing.id);

  const [other, frozen, blocked] = await Promise.all([
    getPerson(withUserId),
    isBlockedBetween(viewer.userId, withUserId),
    listBlockedIds(viewer.userId),
  ]);
  if (!other) return null;
  // Someone the viewer may not cold-message looks like nobody at all — the
  // same answer as a person who doesn't exist.
  if (!(await canStartConversation(viewer, other)).ok) return null;
  return {
    conversationId: null,
    other,
    messages: [],
    cursor: new Date(0).toISOString(),
    canSend: !frozen,
    blockedByYou: blocked.includes(withUserId),
    frozen,
    moderatorView: false,
    otherDeleted: false,
  };
}

async function byConversation(
  viewer: DmViewer,
  id: string,
): Promise<ThreadPayload | null> {
  const convo = await getConversationForViewer(id, viewer);
  if (!convo) return null;

  // A moderator reading a reported thread is not a party to it: no cursor to
  // read, no block state that means anything, and no composer.
  const participant = isParticipant(convo, viewer.userId);
  // Null when the other account has been deleted.
  const otherId = participant ? otherParticipant(convo, viewer.userId) : (convo.userA ?? convo.userB);
  const bothPresent = !!convo.userA && !!convo.userB;
  const [other, messages, frozen, blocked] = await Promise.all([
    otherId ? getPerson(otherId) : Promise.resolve(null),
    // A moderator's view of a reported thread includes what was unsent.
    listMessages(convo.id, 300, { includeUnsent: !participant }),
    participant && bothPresent
      ? isBlockedBetween(convo.userA!, convo.userB!)
      : Promise.resolve(false),
    participant ? listBlockedIds(viewer.userId) : Promise.resolve([] as string[]),
  ]);

  return {
    conversationId: convo.id,
    other: other ?? (otherId ? { id: otherId, ...DELETED } : deletedPerson(convo.id)),
    messages,
    cursor: participant ? cursorFor(convo, viewer.userId) : new Date().toISOString(),
    canSend: canSendToConversation(convo, viewer, frozen),
    blockedByYou: !!otherId && blocked.includes(otherId),
    frozen,
    moderatorView: !participant,
    otherDeleted: participant && !bothPresent,
  };
}
