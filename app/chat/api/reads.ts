import "server-only";
import { getViewer } from "@/lib/auth";
import type { Capabilities } from "@/lib/permissions";
import { isUuid } from "@/lib/chat-access";
import {
  buildSidebar,
  countAttention,
  getChatViewer,
  getMessageRow,
  getMessages,
  getPeople,
  listChannelPeople,
  listMessages,
  listPins,
  listThreadReplies,
  openChannelFor,
  type ChatMessage,
  type ChatPerson,
  type SidebarData,
} from "@/lib/chat";
import { peopleIn } from "@/lib/chat-payload";
import { withAbout } from "@/lib/chat-about";
import { describeThread, getThreadRow, threadsReady, type ThreadInfo } from "@/lib/chat-threads";
import { listOpenQuestions, openQuestionCount } from "@/lib/chat-questions";
import { isQuestionChannel } from "@/lib/chat-threads-rules";

/**
 * Chat's reads, shared by the GET routes beside this file (what the client
 * polls with) and the read server actions in app/chat/actions.ts (kept for
 * anything still calling them), so the two can't disagree.
 *
 * Who's asking is the locally verified JWT (lib/auth.ts getViewer, getClaims)
 * rather than a GoTrue round trip: these run on every poll, and a read only
 * shows what the database says the person may see right now. Writes keep the
 * strict check (lib/server-guards.ts). A read that touches one channel
 * resolves the viewer for that channel alone (openChannelFor).
 *
 * Each returns null for "not available" — doesn't exist, or not yours to
 * read, the same answer — and throws on a failure worth retrying.
 */

export type Reader = { userId: string; caps: Capabilities };

/** The signed-in reader, or null when signed out. */
export async function currentReader(): Promise<Reader | null> {
  const viewer = await getViewer();
  return viewer ? { userId: viewer.profile.id, caps: viewer.caps } : null;
}

export type MessagesPayload = {
  messages: ChatMessage[];
  hasMoreBefore: boolean;
  hasMoreAfter: boolean;
  people: Record<string, ChatPerson>;
  /** Everything created before this instant that isn't in `messages` (and is inside the page) is gone. */
  asOf: string;
  /**
   * #help's newest page only (0110): how many open questions it has, so the
   * header's Unanswered count catches up on the 30-second resync. Absent
   * elsewhere, and when it couldn't be counted.
   */
  unanswered?: number;
};

export type MessagesByIdPayload = { messages: ChatMessage[]; people: Record<string, ChatPerson> };

export async function readSidebar(r: Reader): Promise<SidebarData> {
  return buildSidebar(await getChatViewer(r.userId, r.caps));
}

/**
 * The nav badge's count, and whose it is — the badge listens for that
 * person's chat bells. Never fails: zero when signed out, before 0101, or
 * on any error (a badge is never worth an error page).
 */
export async function readAttention(r: Reader | null): Promise<{ n: number; userId: string | null }> {
  if (!r) return { n: 0, userId: null };
  try {
    return { n: await countAttention(await getChatViewer(r.userId, r.caps)), userId: r.userId };
  } catch {
    return { n: 0, userId: r.userId };
  }
}

/** Older messages (before a (createdAt, id) cursor), a window around one, or the newest page. */
export async function readMessages(
  r: Reader,
  channelId: string,
  opts: { before?: string | null; beforeId?: string | null; around?: string | null } = {},
): Promise<MessagesPayload | null> {
  const found = await openChannelFor(channelId, r.userId, r.caps);
  if (!found) return null;
  // Taken before the query, less a margin for clock skew, so a message that
  // lands mid-request is never mistaken for a deleted one.
  const asOf = new Date(Date.now() - 3_000).toISOString();
  const page = await listMessages(found.channel.id, {
    before: opts.before ?? undefined,
    beforeId: opts.beforeId ?? undefined,
    around: opts.around ?? undefined,
  });
  const newest = !opts.before && !opts.around;
  const [messages, unanswered] = await Promise.all([
    withAbout(page.messages),
    newest && isQuestionChannel(found.channel.systemKey) ? openQuestionCount(found.channel.id) : Promise.resolve(null),
  ]);
  const people = await getPeople(peopleIn(messages));
  return { ...page, messages, people: Object.fromEntries(people), asOf, ...(unanswered === null ? {} : { unanswered }) };
}

/** Messages by id — the realtime path hands the client ids it then hydrates. */
export async function readMessagesById(r: Reader, channelId: string, ids: readonly string[]): Promise<MessagesByIdPayload | null> {
  const found = await openChannelFor(channelId, r.userId, r.caps);
  if (!found) return null;
  const messages = await withAbout(
    (await getMessages(ids.filter(isUuid).slice(0, 50))).filter((m) => m.channelId === found.channel.id),
  );
  return { messages, people: Object.fromEntries(await getPeople(peopleIn(messages))) };
}

export type ThreadPayload = {
  info: ThreadInfo;
  /** The message the thread hangs off; null once it's deleted (its replies stay). */
  root: ChatMessage | null;
  replies: ChatMessage[];
  hasMoreBefore: boolean;
  people: Record<string, ChatPerson>;
  /** As MessagesPayload.asOf: a reply created before this that isn't in the page (and is inside it) is gone. */
  asOf: string;
};

/**
 * One thread (0110): the message it hangs off, a page of replies (the
 * newest, or the ones before a (createdAt, id) cursor), and what this viewer
 * may do with it. Read by exactly who reads its channel — the channel check
 * first, then the root must be a feed message IN that channel — so a thread
 * id from somewhere else opens nothing, and a follow opens nothing either.
 */
export async function readThread(
  r: Reader,
  channelId: string,
  rootId: string,
  opts: { before?: string | null; beforeId?: string | null } = {},
): Promise<ThreadPayload | null> {
  if (!(await threadsReady())) return null;
  const found = await openChannelFor(channelId, r.userId, r.caps);
  if (!found || found.channel.kind !== "channel") return null;
  const root = await getMessageRow(rootId);
  if (!root || root.channel_id !== found.channel.id || root.thread_root_id || root.kind !== "message") return null;
  const asOf = new Date(Date.now() - 3_000).toISOString();
  const [row, page, rootMessages] = await Promise.all([
    getThreadRow(root.id),
    listThreadReplies(found.channel.id, root.id, { before: opts.before ?? undefined, beforeId: opts.beforeId ?? undefined }),
    root.deleted_at ? Promise.resolve([] as ChatMessage[]) : getMessages([root.id]).then((m) => withAbout(m)),
  ]);
  const shownRoot = rootMessages[0] ?? null;
  const info = await describeThread(found.viewer, r.caps, found.channel, root, row);
  if (shownRoot?.thread?.about) info.about = shownRoot.thread.about;
  const people = await getPeople(peopleIn([...(shownRoot ? [shownRoot] : []), ...page.replies]));
  return { info, root: shownRoot, replies: page.replies, hasMoreBefore: page.hasMoreBefore, people: Object.fromEntries(people), asOf };
}

export type UnansweredPayload = { questions: ChatMessage[]; total: number; people: Record<string, ChatPerson> };

/** #help's Unanswered list (0110): its open questions, waiting longest first. Only in #help, for its readers. */
export async function readUnanswered(r: Reader, channelId: string): Promise<UnansweredPayload | null> {
  const found = await openChannelFor(channelId, r.userId, r.caps);
  if (!found || !isQuestionChannel(found.channel.systemKey)) return null;
  const { questions, total } = await listOpenQuestions(found.channel.id);
  const shown = await withAbout(questions);
  return { questions: shown, total, people: Object.fromEntries(await getPeople(peopleIn(shown))) };
}

export async function readMembers(r: Reader, channelId: string): Promise<ChatPerson[] | null> {
  const found = await openChannelFor(channelId, r.userId, r.caps);
  if (!found) return null;
  return listChannelPeople(found.channel);
}

export async function readPins(r: Reader, channelId: string): Promise<MessagesByIdPayload | null> {
  const found = await openChannelFor(channelId, r.userId, r.caps);
  if (!found) return null;
  const messages = await listPins(found.channel.id);
  return { messages, people: Object.fromEntries(await getPeople(peopleIn(messages))) };
}
