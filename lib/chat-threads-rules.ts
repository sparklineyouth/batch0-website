// ---------------------------------------------------------------------------
// batch0 Chat — threads and #help's questions (migration 0110), the rules as
// pure functions. Import-free but for ./chat-access.ts, so a server action,
// the client and `node --test` run the same code. The SQL in 0110 is the
// backstop for the shape (one level, same channel, an answer in its own
// thread); lib/chat-threads-migration-db.test.ts holds it to that.
// ---------------------------------------------------------------------------

import { BELL_QUIET_MS, effectiveNotify, isAfter, type ChannelKind, type NotifyPref, type Verdict } from "./chat-access.ts";

export type QuestionState = "open" | "answered";

/**
 * What a message's row in the feed knows about its thread: how many live
 * replies, the newest one, and — in #help — the question's state. Absent on
 * a message nobody replied to that isn't a question.
 */
export type ThreadSummary = {
  replyCount: number;
  lastReplyAt: string | null;
  question: QuestionState | null;
  answerId: string | null;
  /** The lesson or assignment it's about — only when THIS viewer may open it (lib/chat-about.ts). */
  about?: AboutChip;
};

export type AboutKind = "lesson" | "assignment";

/** A course item a question links to, resolved for one viewer: never stored with its title. */
export type AboutChip = { kind: AboutKind; id: string; title: string; href: string };

/** The channel questions live in: #help (its system key). */
export const QUESTION_CHANNEL_KEY = "help";

/** A page of thread replies. */
export const THREAD_PAGE_SIZE = 50;

/** #help's Unanswered list: the open questions that have waited longest. */
export const UNANSWERED_LIST_MAX = 50;

export function isQuestionChannel(systemKey: string | null | undefined): boolean {
  return systemKey === QUESTION_CHANNEL_KEY;
}

const OK: Verdict = { ok: true };
const no = (reason: string): Verdict => ({ ok: false, reason });

/** A message, reduced to what the thread rules look at. */
export type ThreadableMessage = {
  id: string;
  channelId: string;
  /** The root it replies to, when it's a thread reply itself. */
  threadRootId: string | null;
  kind: "message" | "system";
  deletedAt: string | null;
};

/**
 * May this message take a thread reply? 0110's guard trigger, said in words
 * before the insert: a live person's message, not a reply itself, in the
 * text channel the reply is posted to.
 */
export function threadRootVerdict(channel: { id: string; kind: ChannelKind }, root: ThreadableMessage | null): Verdict {
  if (channel.kind !== "channel") return no("Threads are for channels. Reply in the conversation instead.");
  if (!root || root.channelId !== channel.id || root.deletedAt) return no("The message that started this thread is gone.");
  if (root.kind !== "message") return no("That message can't take replies.");
  if (root.threadRootId) return no("Threads go one level deep: reply in the thread itself.");
  return OK;
}

/**
 * May a reply quote this message here? In a thread: its root or another
 * reply in the same thread. In the channel's feed: a feed message, never a
 * thread reply (that would lift a thread's words into the feed).
 */
export function quoteVerdict(
  channelId: string,
  threadRootId: string | null,
  target: Pick<ThreadableMessage, "id" | "channelId" | "threadRootId" | "deletedAt"> | null,
): Verdict {
  if (!target || target.channelId !== channelId || target.deletedAt) return no("The message you're replying to is gone.");
  if (threadRootId) {
    return target.id === threadRootId || target.threadRootId === threadRootId
      ? OK
      : no("You can only quote a message from this thread here.");
  }
  return target.threadRootId ? no("That message is in a thread. Reply to it there.") : OK;
}

/**
 * Is a new message an open question the moment it's posted? 0110's trigger
 * decides it in SQL; this is the same rule for a screen that just saw the
 * message arrive live: a top-level post in #help from someone outside the
 * team, not a quote, not a system line.
 */
export function isAutoQuestion(m: {
  systemKey: string | null;
  threadRootId: string | null;
  replyToId: string | null;
  kind: "message" | "system";
  senderId: string | null;
  senderStaff: boolean;
}): boolean {
  return (
    isQuestionChannel(m.systemKey) && !m.threadRootId && !m.replyToId && m.kind === "message" && !!m.senderId && !m.senderStaff
  );
}

/**
 * Who settles a question — accepts an answer, marks it answered, reopens it,
 * or says it isn't one: whoever asked, or chat staff (`chat.manage`). A
 * mentor answering is the point; deciding that someone else's question is
 * answered is the asker's call, or the team's.
 */
export function canDecideQuestion(viewer: { userId: string; staff: boolean }, root: { senderId: string | null }): boolean {
  return viewer.staff || (!!root.senderId && root.senderId === viewer.userId);
}

export type QuestionAction = "ask" | "accept" | "mark_answered" | "reopen" | "unmark";

export type QuestionNow = { question: QuestionState | null; answerId: string | null };

/**
 * Where a question goes on an action, or why it can't. `answerId` is for
 * accept only (the caller has already checked it's a live reply in this
 * thread; 0110 checks again). Accepting a different answer on an answered
 * question replaces it. Nothing here is a no-op: an action the state already
 * reflects is refused, so a double click can't log a second transition.
 */
export function questionTransition(
  now: QuestionNow,
  action: QuestionAction,
  answerId: string | null = null,
): { ok: true; next: QuestionNow } | { ok: false; reason: string } {
  switch (action) {
    case "ask":
      return now.question === null
        ? { ok: true, next: { question: "open", answerId: null } }
        : { ok: false, reason: "That's already a question." };
    case "accept":
      if (now.question === null) return { ok: false, reason: "That thread isn't a question." };
      if (!answerId) return { ok: false, reason: "Pick a reply to accept." };
      if (now.answerId === answerId) return { ok: false, reason: "That's already the accepted answer." };
      return { ok: true, next: { question: "answered", answerId } };
    case "mark_answered":
      if (now.question !== "open") {
        return { ok: false, reason: now.question === null ? "That thread isn't a question." : "That question is already answered." };
      }
      return { ok: true, next: { question: "answered", answerId: null } };
    case "reopen":
      return now.question === "answered"
        ? { ok: true, next: { question: "open", answerId: null } }
        : { ok: false, reason: now.question === null ? "That thread isn't a question." : "That question is already open." };
    case "unmark":
      return now.question === null
        ? { ok: false, reason: "That isn't a question." }
        : { ok: true, next: { question: null, answerId: null } };
    default:
      return { ok: false, reason: "Pick what to do with the question." };
  }
}

/**
 * A thread's summary after a reply arrived live. Counted only when the reply
 * is newer than the newest one the summary already has, so the same reply
 * seen twice — its Realtime insert, the send's own answer, a page that
 * already counted it — is counted once. (One that arrives out of order is
 * left to the next resync rather than risk a double count.)
 */
export function bumpThread(summary: ThreadSummary | undefined, reply: { createdAt: string }): ThreadSummary {
  const cur: ThreadSummary = summary ?? { replyCount: 0, lastReplyAt: null, question: null, answerId: null };
  if (cur.lastReplyAt && !isAfter(reply.createdAt, cur.lastReplyAt)) return cur;
  return { ...cur, replyCount: cur.replyCount + 1, lastReplyAt: reply.createdAt };
}

/**
 * A thread's summary after one of its replies was deleted live. The caller
 * calls it once per delete it hadn't seen (its deleted set): 0110 has
 * already reopened the question if that reply was the accepted answer.
 */
export function dropThreadReply(summary: ThreadSummary | undefined, replyId: string): ThreadSummary | undefined {
  if (!summary) return summary;
  const lostAnswer = summary.answerId === replyId;
  return {
    ...summary,
    replyCount: Math.max(0, summary.replyCount - 1),
    ...(lostAnswer ? { question: "open" as const, answerId: null } : {}),
  };
}

/**
 * The feed's summary once the thread was read again after it changed live
 * (0112): the question's state and answer are the server's, as of that
 * read; the reply count and the newest reply stay what this screen counted,
 * since a reply landing while the read was out is in neither the read nor
 * gone from the count (bumpThread, dropThreadReply keep those). `fetched`
 * undefined: the thread has nothing to show any more but its replies.
 */
export function adoptThreadState(local: ThreadSummary | undefined, fetched: ThreadSummary | undefined): ThreadSummary | undefined {
  const question = fetched?.question ?? null;
  const answerId = fetched?.answerId ?? null;
  if (!local) return fetched ? { ...fetched } : undefined;
  if (local.question === question && local.answerId === answerId) return local;
  return { ...local, question, answerId };
}

/** How #help's Unanswered count moves when a question goes from one summary to the next. */
export function openQuestionDelta(before: ThreadSummary | undefined, after: ThreadSummary | undefined): number {
  return (after?.question === "open" ? 1 : 0) - (before?.question === "open" ? 1 : 0);
}

/** Is a thread summary worth showing under its message? */
export function showsThread(summary: ThreadSummary | null | undefined): boolean {
  return !!summary && (summary.replyCount > 0 || summary.question !== null);
}

export type FollowState = "following" | "muted" | null;

/** A follow row's state, as "is this person following": an explicit unfollow, or no choice at all, is not. */
export function isFollowing(state: FollowState | undefined): boolean {
  return state === "following";
}

/** A reply in a thread you follow. A mention in a thread is a chat_mention, linked to the thread. */
export const THREAD_BELL_TYPE = "chat_thread";

/** The bells a thread link carries: what opening the thread takes down. */
export const THREAD_BELL_TYPES = [THREAD_BELL_TYPE, "chat_mention"] as const;

/** How a bell links to a thread: the channel, with the thread open. One link per thread, so one bell per burst. */
export function threadLink(channelId: string, rootId: string): string {
  return `/chat?c=${channelId}&thread=${rootId}`;
}

/**
 * Thread bells are only for messages posted just now. History carried in or
 * imported later — anything older than this when its bells are asked for —
 * rings nobody (a replayed send is retried within seconds, not hours).
 */
export const THREAD_BELL_FRESH_MS = 30 * 60_000;

export function bellFresh(createdAt: string, nowMs: number): boolean {
  const t = Date.parse(createdAt);
  return Number.isFinite(t) && nowMs - t <= THREAD_BELL_FRESH_MS;
}

export type ThreadBellCandidate = {
  userId: string;
  /** Followed the thread (state 'following'). */
  following: boolean;
  /** @mentioned by this reply (already vetted as a reader). */
  mentioned: boolean;
  /** Can read the channel right now. */
  reader: boolean;
  /** Blocked the sender. */
  blockedSender: boolean;
  /** Their setting for the channel. */
  channelPref: NotifyPref | null;
  /** When they last had this thread open. */
  seenAt: string | null;
  /** An unread bell for this thread already points at it. */
  hasUnreadBell: boolean;
};

/**
 * Who a thread reply bells, and as what. Only followers and the people it
 * @mentions — never a channel's "All messages" subscribers, never everyone:
 * a reply in a busy thread doesn't ring a cohort. Then, per person, the
 * channel rules: someone who can't read the channel any more gets nothing (a
 * follow is not a grant), nor does someone who blocked the sender or muted
 * the channel ("Nothing"). "Only @mentions", the channel default, still lets
 * a followed thread's replies through — following IS asking for them. One
 * bell per burst: none while an unread one for the thread is up, none while
 * they had it open in the last two minutes. `postedAt` (a replayed send's
 * asking again) also skips anyone who has opened the thread since.
 */
export function threadBellRecipients(
  candidates: readonly ThreadBellCandidate[],
  input: { senderId: string; nowMs: number; postedAt?: string },
): { userId: string; mentioned: boolean }[] {
  const out: { userId: string; mentioned: boolean }[] = [];
  const seen = new Set<string>();
  for (const c of candidates) {
    if (!c.userId || c.userId === input.senderId || seen.has(c.userId)) continue;
    seen.add(c.userId);
    if (!c.reader || c.blockedSender) continue;
    if (!c.following && !c.mentioned) continue;
    if (effectiveNotify("channel", c.channelPref) === "none") continue;
    if (c.hasUnreadBell) continue;
    const seenMs = c.seenAt ? Date.parse(c.seenAt) : NaN;
    if (Number.isFinite(seenMs) && input.nowMs - seenMs < BELL_QUIET_MS) continue;
    if (input.postedAt && c.seenAt && isAfter(c.seenAt, input.postedAt)) continue;
    out.push({ userId: c.userId, mentioned: c.mentioned });
  }
  return out;
}

/** A thread bell's title: who, and where. Never the words. */
export function threadBellTitle(input: { sender: string; channelName: string | null; mentioned: boolean }): string {
  const where = `#${input.channelName ?? "channel"}`;
  return input.mentioned ? `${input.sender} mentioned you in a thread in ${where}` : `${input.sender} replied in a thread in ${where}`;
}

// ---------------------------------------------------------------------------
// "Ask the team": one help request per thread, in Support
// ---------------------------------------------------------------------------

/** A Support ticket's status (lib/support-access.ts TICKET_STATUSES), as far as a help request cares. */
export type HelpTicketStatus = "open" | "waiting_on_requester" | "resolved" | "closed";

export type HelpStatus = "open" | "waiting" | "handled";

/**
 * What the thread says about its help request: in the team's queue (open),
 * answered by the team and waiting on the person who asked (Support's
 * `waiting_on_requester`, the default after a staff reply), or handled.
 */
export function helpStatusFor(status: HelpTicketStatus): HelpStatus {
  if (status === "resolved" || status === "closed") return "handled";
  return status === "waiting_on_requester" ? "waiting" : "open";
}

/**
 * Is the request in the team's queue — Support's "Needs reply", the one
 * status with `needs_reply` set (lib/support-access.ts needsReplyForStatus)?
 * Only then is it a Support row on the Overview; a question whose request is
 * waiting on the asker, or handled, still needs its own row.
 */
export function helpWithTeam(status: HelpTicketStatus): boolean {
  return status === "open";
}

/**
 * What "Ask the team" does with a thread's existing request: none, or a
 * closed one (final: someone with something new opens a new request, the
 * Support rule) → a new ticket; one in the team's queue → the same ticket,
 * with a note that someone asked again; one waiting on the asker, or
 * resolved → that ticket, back in the queue (as a requester's follow-up puts
 * it, lib/support-access.ts statusAfterRequesterReply), so someone asking
 * again is seen and the history stays in one place.
 */
export function helpRequestPlan(existing: { status: HelpTicketStatus } | null): "create" | "link" | "reopen" {
  if (!existing || existing.status === "closed") return "create";
  return helpWithTeam(existing.status) ? "link" : "reopen";
}

/**
 * A help request's reference, for one viewer: the person who filed it and
 * the team (support.view) see it; anyone else in the thread doesn't — it's
 * someone else's Support request, and a reference to a page that 404s for
 * them (lib/chat-threads.ts helpInfoFor, and "Ask the team"'s answer).
 */
export function helpReferenceFor(
  ticket: { reference: string; userId: string | null },
  viewer: { userId: string; team: boolean },
): string | null {
  return viewer.team || (!!ticket.userId && ticket.userId === viewer.userId) ? ticket.reference : null;
}

// ---------------------------------------------------------------------------
// "Ask about this": a lesson or assignment a question links to
// ---------------------------------------------------------------------------

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** "lesson:<uuid>" / "assignment:<uuid>" → the item, or null for anything else. */
export function parseAbout(raw: unknown): { kind: AboutKind; id: string } | null {
  if (typeof raw !== "string") return null;
  const m = /^(lesson|assignment):([0-9a-f-]{36})$/i.exec(raw.trim());
  if (!m || !UUID.test(m[2])) return null;
  return { kind: m[1].toLowerCase() as AboutKind, id: m[2].toLowerCase() };
}

export function aboutParam(kind: AboutKind, id: string): string {
  return `${kind}:${id}`;
}

/** Where the chip opens: the item's own page, which checks access again. */
export function aboutHref(kind: AboutKind, id: string): string {
  return kind === "lesson" ? `/dashboard/course/${id}` : `/dashboard/assignments/${id}`;
}

/** The link a lesson or assignment page puts under "Ask about this". */
export function askAboutHref(kind: AboutKind, id: string): string {
  return `/chat?ask=${aboutParam(kind, id)}`;
}

/** A title short enough for a chip. */
export function aboutTitle(title: string | null | undefined): string {
  const t = (title ?? "").replace(/\s+/g, " ").trim();
  const chars = Array.from(t);
  return chars.length <= 80 ? t || "Untitled" : `${chars.slice(0, 79).join("").trimEnd()}…`;
}
