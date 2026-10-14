import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyRead,
  arrivals,
  baseFrom,
  chatRemovedHint,
  chooseOption,
  contradictedHints,
  emptyReadRequest,
  hideRow,
  isIsoTimestamp,
  isUuid,
  laterIso,
  mergeReadRequests,
  newRowId,
  panelTabs,
  parsePanelOp,
  parseRoomHint,
  pruneOverrides,
  readFrom,
  requestFor,
  retryDelayMs,
  unseenCount,
  unseenOpenPolls,
  viewChat,
  viewPinned,
  voteOn,
  withOverrides,
  CHAT_CURSOR_OVERLAP_MS,
  CHAT_KEEP,
  OUTBOX_MAX_ATTEMPTS,
  type Override,
  type PanelBase,
  type WebinarPanelInitial,
} from "./webinar-panel.ts";
import type { ChatMessage, RoomQuestion, WebinarPoll } from "./webinars.ts";

const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const at = (s: number) => new Date(Date.UTC(2026, 9, 14, 18, 0, s)).toISOString();

function msg(n: number, extra: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: ID(n),
    authorName: "Ana",
    mine: false,
    body: `m${n}`,
    isHost: false,
    approvedAt: at(n),
    removedAt: null,
    pinned: false,
    createdAt: at(n),
    ...extra,
  };
}

function question(n: number, extra: Partial<RoomQuestion> = {}): RoomQuestion {
  return {
    id: ID(100 + n),
    askerName: "Ana",
    mine: false,
    body: `q${n}`,
    status: "open",
    voteCount: 0,
    voted: false,
    spotlighted: false,
    approvedAt: at(n),
    createdAt: at(n),
    ...extra,
  };
}

function initial(messages: ChatMessage[]): WebinarPanelInitial {
  return {
    audienceMode: "open",
    chat: {
      messages,
      pinned: null,
      full: true,
      cursor: messages.at(-1)?.createdAt ?? null,
    },
    questions: [],
    polls: [],
  };
}

const ids = (list: { id: string }[]) => list.map((m) => m.id);

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

test("a full read replaces the feed, so a removed message is gone for good", () => {
  const base = baseFrom(initial([msg(1), msg(2), msg(3)]));
  // The moderator's own copy of the feed still has message 2; the server no
  // longer returns it. It must not come back.
  const next = applyRead(base, {
    audienceMode: "open",
    chat: { messages: [msg(1), msg(3)], pinned: null, full: true, cursor: at(3) },
  });
  assert.deepEqual(ids(next.messages), [ID(1), ID(3)]);
  // …and a later incremental read cannot resurrect it either.
  const later = applyRead(next, {
    audienceMode: "open",
    chat: { messages: [msg(4)], pinned: null, full: false, cursor: at(4) },
  });
  assert.deepEqual(ids(later.messages), [ID(1), ID(3), ID(4)]);
});

test("a row carrying removedAt is dropped on every path", () => {
  const base = baseFrom(initial([msg(1)]));
  const removed = msg(2, { removedAt: at(9) });
  for (const full of [true, false]) {
    const next = applyRead(base, {
      audienceMode: "open",
      chat: { messages: [msg(1), removed], pinned: removed, full, cursor: at(2) },
    });
    assert.deepEqual(ids(next.messages), [ID(1)]);
    assert.equal(next.pinned, null);
  }
});

test("the cursor never moves backwards", () => {
  const base = baseFrom(initial([msg(5)]));
  assert.equal(base.cursor, at(5));
  const empty = applyRead(base, {
    audienceMode: "open",
    chat: { messages: [], pinned: null, full: true, cursor: null },
  });
  assert.equal(empty.cursor, at(5));
  const older = applyRead(base, {
    audienceMode: "open",
    chat: { messages: [msg(1)], pinned: null, full: true, cursor: at(1) },
  });
  assert.equal(older.cursor, at(5));
});

test("incremental reads merge by id and keep the newest CHAT_KEEP", () => {
  const base = baseFrom(initial([msg(1), msg(2)]));
  const edited = msg(2, { pinned: true });
  const next = applyRead(base, {
    audienceMode: "open",
    chat: { messages: [edited, msg(3)], pinned: edited, full: false, cursor: at(3) },
  });
  assert.deepEqual(ids(next.messages), [ID(1), ID(2), ID(3)]);
  assert.equal(next.messages[1].pinned, true);

  const many = Array.from({ length: CHAT_KEEP + 10 }, (_, i) => msg(i + 10));
  const big = applyRead(base, {
    audienceMode: "open",
    chat: { messages: many, pinned: null, full: false, cursor: many.at(-1)!.createdAt },
  });
  assert.equal(big.messages.length, CHAT_KEEP);
  assert.equal(big.messages.at(-1)!.id, many.at(-1)!.id, "the newest are kept");
});

test("questions and polls are replaced only when the read carried them", () => {
  const base: PanelBase = { ...baseFrom(initial([])), questions: [question(1)] };
  const chatOnly = applyRead(base, {
    audienceMode: "open",
    chat: { messages: [], pinned: null, full: false, cursor: null },
  });
  assert.equal(chatOnly.questions.length, 1);
  const qa = applyRead(base, { audienceMode: "moderated", questions: [] });
  assert.equal(qa.questions.length, 0);
  assert.equal(qa.audienceMode, "moderated");
});

// ---------------------------------------------------------------------------
// Optimistic overrides
// ---------------------------------------------------------------------------

test("an in-flight removal hides the row through any read until it settles", () => {
  const base = baseFrom(initial([msg(1), msg(2)]));
  let o = new Map<string, Override<ChatMessage>>([
    [ID(2), { settledAt: null, patch: hideRow }],
  ]);
  assert.deepEqual(ids(viewChat(base, o)), [ID(1)]);
  // A read that started before the server wrote the removal still has it.
  o = pruneOverrides(o, 1_000);
  assert.deepEqual(ids(viewChat(base, o)), [ID(1)], "still hidden: not settled");
  // Settled at t=2000; a read that started at 1500 predates it.
  o.set(ID(2), { settledAt: 2_000, patch: hideRow });
  o = pruneOverrides(o, 1_500);
  assert.equal(o.size, 1);
  // A read that started after: the server's answer is the truth now.
  o = pruneOverrides(o, 2_500);
  assert.equal(o.size, 0);
});

test("a forged removal hint undoes itself on the next read", () => {
  // The hint drops the row at once (settled immediately, as hints are)…
  const base = baseFrom(initial([msg(1), msg(2)]));
  let o = new Map<string, Override<ChatMessage>>([
    [ID(2), { settledAt: 1_000, patch: hideRow }],
  ]);
  assert.deepEqual(ids(viewChat(base, o)), [ID(1)]);
  // …and the full read it triggers still returns the row, so it is back.
  const read = applyRead(base, {
    audienceMode: "open",
    chat: { messages: [msg(1), msg(2)], pinned: null, full: true, cursor: at(2) },
  });
  o = pruneOverrides(o, 1_100);
  assert.deepEqual(ids(viewChat(read, o)), [ID(1), ID(2)]);
});

test("a replayed forged removal hint stops being trusted after one read", () => {
  const forged = new Map<string, Override<ChatMessage>>([
    [ID(2), { settledAt: 1_000, patch: hideRow, fromHint: true }],
    // A real removal: the read that follows no longer returns the row.
    [ID(3), { settledAt: 1_000, patch: hideRow, fromHint: true }],
    // The reader's own removal is never second-guessed.
    [ID(4), { settledAt: 1_000, patch: hideRow }],
  ]);
  const returned = new Set([ID(1), ID(2), ID(4)]);
  assert.deepEqual(contradictedHints(forged, 1_100, returned), [ID(2)]);
  assert.deepEqual(
    contradictedHints(forged, 900, returned),
    [],
    "a read that started before the hint says nothing about it",
  );
});

test("an own send shows until a read that started after it confirms", () => {
  const base = baseFrom(initial([msg(1)]));
  const mine = msg(2, { mine: true, authorName: "You" });
  let o = new Map<string, Override<ChatMessage>>([
    [mine.id, { settledAt: 2_000, insert: mine }],
  ]);
  assert.deepEqual(ids(viewChat(base, o)), [ID(1), ID(2)]);
  // A full read that predates the insert's commit replaces the feed without
  // it — the override keeps it on screen.
  const stale = applyRead(base, {
    audienceMode: "open",
    chat: { messages: [msg(1)], pinned: null, full: true, cursor: at(1) },
  });
  o = pruneOverrides(o, 1_900);
  assert.deepEqual(ids(viewChat(stale, o)), [ID(1), ID(2)]);
  // An incremental read that returned it confirms it.
  o = pruneOverrides(o, 2_100, new Set([mine.id]));
  assert.equal(o.size, 0);
  // An incremental read that did not return it says nothing about it.
  const keep = new Map(o).set(mine.id, { settledAt: 2_000, insert: mine });
  assert.equal(pruneOverrides(keep, 2_100, new Set([ID(9)])).size, 1);
});

test("withOverrides never duplicates a row the server already returned", () => {
  const row = msg(1);
  const out = withOverrides([row], new Map([[row.id, { settledAt: 1, insert: row }]]));
  assert.equal(out.length, 1);
});

test("an optimistic pin wins the strip; an unpin or a hide clears it", () => {
  const pinned = msg(1, { pinned: true });
  const base = { ...baseFrom(initial([pinned, msg(2)])), pinned };
  const pinTwo = new Map<string, Override<ChatMessage>>([
    [ID(2), { settledAt: null, patch: (m) => ({ ...m, pinned: true }) }],
    [ID(1), { settledAt: null, patch: (m) => ({ ...m, pinned: false }) }],
  ]);
  const feed = viewChat(base, pinTwo);
  assert.equal(viewPinned(base, feed, pinTwo)?.id, ID(2));

  const unpin = new Map<string, Override<ChatMessage>>([
    [ID(1), { settledAt: null, patch: (m) => ({ ...m, pinned: false }) }],
  ]);
  assert.equal(viewPinned(base, viewChat(base, unpin), unpin), null);

  const hide = new Map<string, Override<ChatMessage>>([
    [ID(1), { settledAt: null, patch: hideRow }],
  ]);
  assert.equal(viewPinned(base, viewChat(base, hide), hide), null);
  assert.equal(viewPinned(base, viewChat(base, new Map()), new Map())?.id, ID(1));
});

test("an upvote is relative to the server's answer and cannot double-count", () => {
  const q = question(1, { voteCount: 3 });
  assert.deepEqual(
    [voteOn(true)(q).voteCount, voteOn(true)(q).voted],
    [4, true],
  );
  const already = question(1, { voteCount: 4, voted: true });
  assert.equal(voteOn(true)(already).voteCount, 4, "server already counted it");
  assert.equal(voteOn(false)(already).voteCount, 3);
  assert.equal(voteOn(false)(question(1)).voteCount, 0, "never negative");
});

test("changing a poll vote moves it in the tally", () => {
  const poll: WebinarPoll = {
    id: ID(50),
    eventId: ID(60),
    question: "?",
    options: ["a", "b"],
    open: true,
    resultsVisible: true,
    tally: [2, 1],
    myChoice: 0,
    createdAt: at(1),
  };
  assert.deepEqual(chooseOption(1)(poll).tally, [1, 2]);
  assert.deepEqual(chooseOption(0)(poll).tally, [2, 1], "same choice is a no-op");
  assert.deepEqual(chooseOption(1)({ ...poll, myChoice: null }).tally, [2, 2]);
});

// ---------------------------------------------------------------------------
// Hints
// ---------------------------------------------------------------------------

test("hints are parsed defensively — the room topic is shared by everyone", () => {
  assert.deepEqual(parseRoomHint({ t: "react", emoji: "👏" }), {
    kind: "react",
    emoji: "👏",
  });
  assert.equal(parseRoomHint({ t: "react", emoji: "<img>" }), null);
  assert.deepEqual(parseRoomHint({ t: "bump", what: "chat", cursor: at(1) }), {
    kind: "bump",
    part: "chat",
    cursor: at(1),
    removed: null,
  });
  assert.deepEqual(parseRoomHint(chatRemovedHint(ID(7))), {
    kind: "bump",
    part: "chat",
    cursor: null,
    removed: ID(7),
  });
  // Garbage in a field degrades to "re-read", never to anything drawn.
  assert.deepEqual(
    parseRoomHint({ t: "bump", what: "chat", cursor: "drop table", removed: "x" }),
    { kind: "bump", part: "chat", cursor: null, removed: null },
  );
  assert.deepEqual(parseRoomHint({ t: "bump", what: "qa", removed: ID(1) }), {
    kind: "bump",
    part: "qa",
    cursor: null,
    removed: null,
  });
  for (const bad of [null, "bump", 7, {}, { t: "bump", what: "dm" }, { t: "stage-change" }]) {
    assert.equal(parseRoomHint(bad), null, JSON.stringify(bad));
  }
});

test("a burst of hints becomes one read of exactly the parts that changed", () => {
  let req = emptyReadRequest();
  req = requestFor(req, { kind: "bump", part: "chat", cursor: at(1), removed: null });
  assert.deepEqual([...req.parts], ["chat"]);
  assert.equal(req.fullChat, false, "a new row needs only the incremental read");
  req = requestFor(req, { kind: "bump", part: "qa", cursor: null, removed: null });
  assert.equal(req.fullChat, false);
  const removal = requestFor(emptyReadRequest(), {
    kind: "bump",
    part: "chat",
    cursor: null,
    removed: ID(1),
  });
  assert.equal(removal.fullChat, true, "a removal is confirmed by a full read");
  const both = mergeReadRequests(req, removal);
  assert.deepEqual([...both.parts].sort(), ["chat", "qa"]);
  assert.equal(both.fullChat, true);
});

// ---------------------------------------------------------------------------
// Small rules
// ---------------------------------------------------------------------------

test("timestamps and ids", () => {
  assert.equal(laterIso(null, at(1)), at(1));
  assert.equal(laterIso(at(2), at(1)), at(2));
  // Same millisecond, Postgres microseconds decide.
  assert.equal(
    laterIso("2026-10-14T18:00:00.123456+00:00", "2026-10-14T18:00:00.1234+00:00"),
    "2026-10-14T18:00:00.123456+00:00",
  );
  assert.equal(Date.parse(at(10)) - Date.parse(readFrom(at(10))), CHAT_CURSOR_OVERLAP_MS);
  assert.ok(isIsoTimestamp("2026-10-14T18:00:00.12+00:00"));
  assert.ok(!isIsoTimestamp("yesterday"));
  assert.ok(!isIsoTimestamp(`2026-10-14T18:00:00${"0".repeat(40)}`));
  const id = newRowId();
  assert.ok(isUuid(id), id);
  assert.notEqual(newRowId(), id);
  assert.ok(!isUuid("1 or 1=1"));
});

test("retries back off and honour the server's hint", () => {
  assert.deepEqual([1, 2, 3, 4, 5].map((a) => retryDelayMs(a)), [1000, 2000, 4000, 8000, 8000]);
  assert.ok(OUTBOX_MAX_ATTEMPTS * 3000 > 20_000, "rides out a rate-limit window");
  assert.equal(retryDelayMs(1, 3000), 3000);
  assert.equal(retryDelayMs(1, 60_000), 15_000);
});

test("unread counts skip your own items and what you've seen", () => {
  const items = [
    { id: "a", mine: false },
    { id: "b", mine: true },
    { id: "c", mine: false },
  ];
  assert.equal(unseenCount(items, new Set()), 2);
  assert.equal(unseenCount(items, new Set(["a"])), 1);
  assert.equal(
    unseenOpenPolls(
      [
        { id: "p", open: true },
        { id: "q", open: false },
        { id: "r", open: true },
      ],
      new Set(["p"]),
    ),
    1,
  );
});

test("chat is a tab only where the audience may see itself; People is hosts-only", () => {
  assert.deepEqual(panelTabs("viewer", true), ["chat", "qa", "polls"]);
  assert.deepEqual(panelTabs("viewer", false), ["qa", "polls"]);
  assert.deepEqual(panelTabs("speaker", false), ["qa", "polls", "people"]);
  assert.deepEqual(panelTabs("staff", true), ["chat", "qa", "polls", "people"]);
});

test("the '1 new' pill counts rows never drawn, not a removal or a restore", () => {
  const shown = new Set([ID(1), ID(2), ID(3)]);
  // The newest is removed: the last row is now an older, seen one.
  assert.deepEqual(arrivals([msg(1), msg(2)], shown), []);
  // A forged hint hid ID(3) and the next read brought it back.
  assert.deepEqual(arrivals([msg(1), msg(2), msg(3)], shown), []);
  // A real arrival, and one that committed late (older than the newest).
  assert.deepEqual(
    arrivals([msg(1), msg(2), msg(3), msg(4)], shown).map((m) => m.id),
    [ID(4)],
  );
  assert.deepEqual(
    arrivals([msg(0), msg(1), msg(2), msg(3)], shown).map((m) => m.id),
    [ID(0)],
  );
});

test("a write body is parsed to one known op, or refused", () => {
  const id = ID(7);
  assert.deepEqual(parsePanelOp({ event: ID(1), op: "chat.send", id, body: "hi" }), {
    op: "chat.send",
    id,
    body: "hi",
  });
  assert.deepEqual(parsePanelOp({ op: "chat.moderate", id, action: "remove" }), {
    op: "chat.moderate",
    id,
    action: "remove",
  });
  assert.deepEqual(parsePanelOp({ op: "qa.status", id, status: "answered" }), {
    op: "qa.status",
    id,
    status: "answered",
  });
  assert.deepEqual(parsePanelOp({ op: "poll.vote", id, choice: 1 }), {
    op: "poll.vote",
    id,
    choice: 1,
  });
  assert.deepEqual(
    parsePanelOp({
      op: "poll.create",
      question: "Ship it?",
      options: ["Yes", "No"],
      resultsVisible: true,
      open: false,
      extra: "ignored",
    }),
    { op: "poll.create", question: "Ship it?", options: ["Yes", "No"], resultsVisible: true, open: false },
  );
  // Nothing the caller adds rides along: who is asking is the session's.
  const sent = parsePanelOp({ op: "chat.delete", id, authorId: ID(9) });
  assert.deepEqual(sent, { op: "chat.delete", id });

  for (const bad of [
    null,
    "chat.send",
    {},
    { op: "chat.send", id: "not-a-uuid", body: "hi" },
    { op: "chat.send", id, body: 7 },
    { op: "chat.send", id, body: "x".repeat(4001) },
    { op: "chat.moderate", id, action: "delete" },
    { op: "qa.vote", id, on: "yes" },
    { op: "qa.status", id, status: "closed" },
    { op: "poll.vote", id, choice: 1.5 },
    { op: "poll.vote", id, choice: -1 },
    { op: "poll.create", question: "Q", options: "A,B", resultsVisible: true, open: true },
    { op: "poll.create", question: "Q", options: ["A", 2], resultsVisible: true, open: true },
    { op: "poll.create", question: "Q", options: Array(21).fill("A"), resultsVisible: true, open: true },
    { op: "poll.create", question: "Q", options: ["A", "B"], open: true },
    { op: "poll.open", id },
    { op: "drop.tables", id },
  ]) {
    assert.equal(parsePanelOp(bad), null, JSON.stringify(bad));
  }
});
