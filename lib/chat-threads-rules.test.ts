import test from "node:test";
import assert from "node:assert/strict";
import {
  BELL_QUIET_MS,
  type ChannelKind,
} from "./chat-access.ts";
import {
  THREAD_BELL_FRESH_MS,
  aboutHref,
  adoptThreadState,
  aboutTitle,
  askAboutHref,
  bellFresh,
  bumpThread,
  canDecideQuestion,
  dropThreadReply,
  helpReferenceFor,
  helpRequestPlan,
  helpStatusFor,
  helpWithTeam,
  isAutoQuestion,
  isFollowing,
  isQuestionChannel,
  openQuestionDelta,
  parseAbout,
  questionTransition,
  quoteVerdict,
  showsThread,
  threadBellRecipients,
  threadBellTitle,
  threadLink,
  threadRootVerdict,
  type ThreadBellCandidate,
  type ThreadSummary,
} from "./chat-threads-rules.ts";

// Threads and #help's questions (migration 0110), the pure rules: where a
// reply may hang and what it may quote, which posts are questions, who
// settles one and how it moves, counting replies seen live once, who a reply
// bells, a thread's one help request, and the course item a question links to.

const HELP = "c0000000-0000-4000-8000-000000000001";
const GENERAL = "c0000000-0000-4000-8000-000000000002";
const ROOT = "90000000-0000-4000-8000-000000000001";
const REPLY = "90000000-0000-4000-8000-000000000002";
const ME = "a0000000-0000-4000-8000-000000000001";
const YOU = "a0000000-0000-4000-8000-000000000002";
const NOW = Date.parse("2026-10-17T16:00:00.000Z");

const channel = (id: string, kind: ChannelKind = "channel") => ({ id, kind });
const msg = (over: Partial<{ id: string; channelId: string; threadRootId: string | null; kind: "message" | "system"; deletedAt: string | null }> = {}) => ({
  id: ROOT,
  channelId: HELP,
  threadRootId: null,
  kind: "message" as const,
  deletedAt: null,
  ...over,
});

test("a reply hangs off a live feed message in its own text channel, one level deep", () => {
  assert.deepEqual(threadRootVerdict(channel(HELP), msg()), { ok: true });
  // Another channel's message is "gone" from here: the same answer as one that doesn't exist.
  assert.equal(threadRootVerdict(channel(HELP), msg({ channelId: GENERAL })).ok, false);
  assert.equal(threadRootVerdict(channel(HELP), null).ok, false);
  assert.equal(threadRootVerdict(channel(HELP), msg({ deletedAt: "2026-10-17T10:00:00Z" })).ok, false);
  const nested = threadRootVerdict(channel(HELP), msg({ id: REPLY, threadRootId: ROOT }));
  assert.equal(nested.ok, false);
  assert.match(nested.ok ? "" : nested.reason, /one level deep/);
  assert.match((threadRootVerdict(channel(HELP), msg({ kind: "system" })) as { reason: string }).reason, /can't take replies/);
  // DMs and groups have no threads.
  for (const kind of ["dm", "group"] as const) assert.equal(threadRootVerdict(channel(HELP, kind), msg()).ok, false);
});

test("a quote stays where it's written: a thread quotes its own messages, the feed its own", () => {
  const reply = msg({ id: REPLY, threadRootId: ROOT });
  const feed = msg({ id: "90000000-0000-4000-8000-000000000003" });
  assert.equal(quoteVerdict(HELP, ROOT, msg()).ok, true, "the root itself");
  assert.equal(quoteVerdict(HELP, ROOT, reply).ok, true, "another reply in the thread");
  assert.equal(quoteVerdict(HELP, ROOT, feed).ok, false, "a feed message, from inside a thread");
  assert.equal(quoteVerdict(HELP, ROOT, msg({ id: REPLY, threadRootId: "90000000-0000-4000-8000-0000000000ff" })).ok, false, "another thread's reply");
  assert.equal(quoteVerdict(HELP, null, feed).ok, true);
  assert.match((quoteVerdict(HELP, null, reply) as { reason: string }).reason, /in a thread/, "the feed never lifts a thread's words");
  assert.equal(quoteVerdict(HELP, null, msg({ channelId: GENERAL })).ok, false);
  assert.equal(quoteVerdict(HELP, null, msg({ deletedAt: "2026-10-17T10:00:00Z" })).ok, false);
});

test("#help: a top-level post from outside the team is an open question; the team's, quotes and other channels aren't", () => {
  const base = { systemKey: "help", threadRootId: null, replyToId: null, kind: "message" as const, senderId: ME, senderStaff: false };
  assert.equal(isQuestionChannel("help"), true);
  assert.equal(isQuestionChannel("general"), false);
  assert.equal(isAutoQuestion(base), true);
  assert.equal(isAutoQuestion({ ...base, senderStaff: true }), false);
  assert.equal(isAutoQuestion({ ...base, replyToId: ROOT }), false);
  assert.equal(isAutoQuestion({ ...base, threadRootId: ROOT }), false);
  assert.equal(isAutoQuestion({ ...base, kind: "system" }), false);
  assert.equal(isAutoQuestion({ ...base, senderId: null }), false);
  assert.equal(isAutoQuestion({ ...base, systemKey: "general" }), false);
});

test("only the asker or chat staff settle a question", () => {
  assert.equal(canDecideQuestion({ userId: ME, staff: false }, { senderId: ME }), true);
  assert.equal(canDecideQuestion({ userId: YOU, staff: false }, { senderId: ME }), false, "a mentor answering doesn't decide it's answered");
  assert.equal(canDecideQuestion({ userId: YOU, staff: true }, { senderId: ME }), true);
  assert.equal(canDecideQuestion({ userId: YOU, staff: false }, { senderId: null }), false, "a deleted account's question: the team's");
});

test("question transitions: each one moves the state; one the state already reflects is refused", () => {
  const open = { question: "open" as const, answerId: null };
  const answered = { question: "answered" as const, answerId: REPLY };
  const none = { question: null, answerId: null };
  assert.deepEqual(questionTransition(none, "ask"), { ok: true, next: open });
  assert.equal(questionTransition(open, "ask").ok, false);
  assert.deepEqual(questionTransition(open, "accept", REPLY), { ok: true, next: answered });
  assert.equal(questionTransition(open, "accept").ok, false, "accepting needs a reply");
  assert.equal(questionTransition(answered, "accept", REPLY).ok, false, "already the answer");
  const other = "90000000-0000-4000-8000-000000000009";
  assert.deepEqual(questionTransition(answered, "accept", other), { ok: true, next: { question: "answered", answerId: other } });
  assert.equal(questionTransition(none, "accept", REPLY).ok, false);
  assert.deepEqual(questionTransition(open, "mark_answered"), { ok: true, next: { question: "answered", answerId: null } });
  assert.equal(questionTransition(answered, "mark_answered").ok, false);
  assert.deepEqual(questionTransition(answered, "reopen"), { ok: true, next: open }, "reopening drops the accepted answer");
  assert.equal(questionTransition(open, "reopen").ok, false);
  assert.deepEqual(questionTransition(answered, "unmark"), { ok: true, next: none });
  assert.equal(questionTransition(none, "unmark").ok, false);
  assert.equal(questionTransition(open, "bogus" as never).ok, false);
});

test("a reply seen twice — its live insert, the send's own answer, a page that counted it — is counted once", () => {
  const page: ThreadSummary = { replyCount: 2, lastReplyAt: "2026-10-17T10:05:00.000Z", question: "open", answerId: null };
  const reply = { createdAt: "2026-10-17T10:06:00.000Z" };
  const once = bumpThread(page, reply);
  assert.deepEqual([once.replyCount, once.lastReplyAt], [3, reply.createdAt]);
  assert.equal(bumpThread(once, reply), once, "the echo after the answer changes nothing");
  assert.equal(bumpThread(page, { createdAt: "2026-10-17T10:04:00.000Z" }), page, "one the page already holds isn't counted again");
  // A first reply on a message with no thread yet.
  assert.deepEqual(bumpThread(undefined, reply), { replyCount: 1, lastReplyAt: reply.createdAt, question: null, answerId: null });
  // A delete takes one off; the accepted answer's reopens the question (0110 did it in SQL too).
  const answered = { ...once, question: "answered" as const, answerId: REPLY };
  assert.deepEqual(dropThreadReply(answered, REPLY), { ...answered, replyCount: 2, question: "open", answerId: null });
  assert.deepEqual(dropThreadReply({ ...page, replyCount: 0 }, REPLY)?.replyCount, 0, "never below zero");
  assert.equal(dropThreadReply(undefined, REPLY), undefined);
  assert.equal(showsThread(undefined), false);
  assert.equal(showsThread({ replyCount: 0, lastReplyAt: null, question: null, answerId: null }), false);
  assert.equal(showsThread({ replyCount: 0, lastReplyAt: null, question: "open", answerId: null }), true, "an unanswered question shows, replies or not");
});

test("a thread read again after it changed live (0112) takes the server's question, and keeps the replies this screen counted", () => {
  const local: ThreadSummary = { replyCount: 3, lastReplyAt: "2026-10-17T10:06:00.000Z", question: "open", answerId: null };
  // The read went out before the third reply was counted: the count stays the screen's.
  const fetched: ThreadSummary = { replyCount: 2, lastReplyAt: "2026-10-17T10:05:00.000Z", question: "answered", answerId: REPLY };
  assert.deepEqual(adoptThreadState(local, fetched), { ...local, question: "answered", answerId: REPLY });
  assert.equal(adoptThreadState(local, { ...local }), local, "nothing changed: the same summary back");
  // Unmarked, no replies left to show: the server sends no summary at all.
  assert.deepEqual(adoptThreadState(local, undefined), { ...local, question: null, answerId: null });
  assert.equal(adoptThreadState(undefined, undefined), undefined);
  assert.deepEqual(adoptThreadState(undefined, fetched), fetched, "a root the screen had no summary for takes the server's");
  // #help's Unanswered count, by what the question was and is.
  assert.equal(openQuestionDelta(local, fetched), -1);
  assert.equal(openQuestionDelta(fetched, local), 1);
  assert.equal(openQuestionDelta(undefined, local), 1, "made a question");
  assert.equal(openQuestionDelta(local, undefined), -1, "said not to be one");
  assert.equal(openQuestionDelta(local, { ...local, answerId: null }), 0);
});

const cand = (userId: string, over: Partial<ThreadBellCandidate> = {}): ThreadBellCandidate => ({
  userId,
  following: true,
  mentioned: false,
  reader: true,
  blockedSender: false,
  channelPref: null,
  seenAt: null,
  hasUnreadBell: false,
  ...over,
});

test("thread bells: followers and mentions only, each still a reader, no block, the channel not muted, one per burst", () => {
  const bells = threadBellRecipients(
    [
      cand("follower"),
      cand("unfollowed", { following: false }),
      cand("mentioned", { following: false, mentioned: true }),
      cand("both", { mentioned: true }),
      cand("left-the-team", { reader: false }),
      cand("blocked-them", { blockedSender: true, mentioned: true }),
      cand("muted-channel", { channelPref: "none", mentioned: true }),
      // "Only @mentions" is the channel default: a followed thread still rings.
      cand("mentions-only", { channelPref: "mentions" }),
      cand("all", { channelPref: "all" }),
      cand("bell-up", { hasUnreadBell: true }),
      cand("looking", { seenAt: new Date(NOW - 30_000).toISOString() }),
      cand("looked-earlier", { seenAt: new Date(NOW - BELL_QUIET_MS - 1_000).toISOString() }),
      cand(ME),
      cand("follower"),
    ],
    { senderId: ME, nowMs: NOW },
  );
  assert.deepEqual(bells, [
    { userId: "follower", mentioned: false },
    { userId: "mentioned", mentioned: true },
    { userId: "both", mentioned: true },
    { userId: "mentions-only", mentioned: false },
    { userId: "all", mentioned: false },
    { userId: "looked-earlier", mentioned: false },
  ]);
  // A replayed send: whoever opened the thread since it was posted has seen it.
  const posted = new Date(NOW - 10 * 60_000).toISOString();
  const replay = threadBellRecipients(
    [cand("opened-since", { seenAt: new Date(NOW - 5 * 60_000).toISOString() }), cand("not-since", { seenAt: new Date(NOW - 20 * 60_000).toISOString() })],
    { senderId: ME, nowMs: NOW, postedAt: posted },
  );
  assert.deepEqual(replay.map((b) => b.userId), ["not-since"]);
});

test("thread bells ring only for fresh replies (never for history carried in), say who and where, never the words", () => {
  assert.equal(bellFresh(new Date(NOW - 60_000).toISOString(), NOW), true);
  assert.equal(bellFresh(new Date(NOW - THREAD_BELL_FRESH_MS - 1).toISOString(), NOW), false);
  assert.equal(bellFresh("not a time", NOW), false);
  assert.equal(threadBellTitle({ sender: "Maya", channelName: "help", mentioned: false }), "Maya replied in a thread in #help");
  assert.equal(threadBellTitle({ sender: "Maya", channelName: "help", mentioned: true }), "Maya mentioned you in a thread in #help");
  assert.equal(threadLink(HELP, ROOT), `/chat?c=${HELP}&thread=${ROOT}`);
  assert.equal(isFollowing("following"), true);
  assert.equal(isFollowing("muted"), false);
  assert.equal(isFollowing(null), false, "having had it open is no follow");
});

test("Ask the team: one request per thread — link one in the queue, put a waiting or handled one back, a new one only after it closed", () => {
  assert.equal(helpRequestPlan(null), "create");
  assert.equal(helpRequestPlan({ status: "open" }), "link");
  // The team replied and is waiting on the asker: someone asking again in the
  // thread is that follow-up, so it goes back in the queue rather than
  // sitting out of it until the 7-day auto-resolve.
  assert.equal(helpRequestPlan({ status: "waiting_on_requester" }), "reopen");
  assert.equal(helpRequestPlan({ status: "resolved" }), "reopen");
  assert.equal(helpRequestPlan({ status: "closed" }), "create");
  assert.equal(helpStatusFor("open"), "open");
  assert.equal(helpStatusFor("waiting_on_requester"), "waiting");
  assert.equal(helpStatusFor("resolved"), "handled");
  assert.equal(helpStatusFor("closed"), "handled");
  // Only an open request is in Support's "Needs reply" queue (needs_reply).
  assert.deepEqual(
    (["open", "waiting_on_requester", "resolved", "closed"] as const).filter(helpWithTeam),
    ["open"],
  );
});

test("a help request's reference is for the person who filed it and the team, nobody else in the thread", () => {
  const ticket = { reference: "B0-ABCD-1234", userId: "asker" };
  assert.equal(helpReferenceFor(ticket, { userId: "asker", team: false }), "B0-ABCD-1234");
  assert.equal(helpReferenceFor(ticket, { userId: "staff", team: true }), "B0-ABCD-1234");
  assert.equal(helpReferenceFor(ticket, { userId: "second-asker", team: false }), null);
  assert.equal(helpReferenceFor({ reference: "B0-X", userId: null }, { userId: "second-asker", team: false }), null);
});

test("Ask about this: an id and a kind, nothing else; the chip opens the item's own page", () => {
  const L = "10000000-0000-4000-8000-0000000000AB";
  assert.deepEqual(parseAbout(`lesson:${L}`), { kind: "lesson", id: L.toLowerCase() });
  assert.deepEqual(parseAbout(` Assignment:${L} `), { kind: "assignment", id: L.toLowerCase() });
  for (const bad of [`lesson:${L}?x=1`, "lesson:", "submission:" + L, `lesson:${L}:extra`, 42, null, "lesson:../../etc/passwd"]) {
    assert.equal(parseAbout(bad), null, String(bad));
  }
  assert.equal(aboutHref("lesson", L), `/dashboard/course/${L}`);
  assert.equal(aboutHref("assignment", L), `/dashboard/assignments/${L}`);
  assert.equal(askAboutHref("lesson", L), `/chat?ask=lesson:${L}`);
  assert.equal(aboutTitle("  Week 2:\n Customer   interviews "), "Week 2: Customer interviews");
  assert.equal(aboutTitle(""), "Untitled");
  assert.equal(Array.from(aboutTitle("x".repeat(200))).length, 80);
});
