import test from "node:test";
import assert from "node:assert/strict";
import {
  byTime,
  dayKey,
  initials,
  layoutMessages,
  localOffset,
  mentionsViewer,
  mergeMessages,
  reconcilePage,
  sameData,
  typingLine,
  type Placeable,
} from "./chat-view.ts";

const ME = "me";
const YOU = "you";

function msg(id: string, senderId: string | null, createdAt: string, extra: Partial<Placeable> = {}): Placeable {
  return { id, senderId, kind: "message", createdAt, replyTo: null, ...extra };
}

test("dayKey uses the viewer's offset", () => {
  // 02:00 UTC is still the previous evening in New York (UTC-4 in October).
  assert.equal(dayKey("2026-10-15T02:00:00Z", 240), "2026-10-14");
  assert.equal(dayKey("2026-10-15T02:00:00Z", 0), "2026-10-15");
  assert.equal(dayKey("nope", 0), "unknown");
});

/** America/New_York's offset at an instant: EDT (240) until 2026-11-01 06:00Z, then EST (300). */
const newYork = (t: number) => (t < Date.parse("2026-11-01T06:00:00Z") ? 240 : 300);

test("dayKey takes each message's own offset across a DST change", () => {
  // 00:30 EDT on Oct 15, read in November: October 15, not the 14th.
  assert.equal(dayKey("2026-10-15T04:30:00Z", newYork), "2026-10-15");
  assert.equal(dayKey("2026-10-15T04:30:00Z", 300), "2026-10-14", "one offset for every message gets it wrong");
  // 23:30 EST on Nov 5.
  assert.equal(dayKey("2026-11-06T04:30:00Z", newYork), "2026-11-05");
  const rows = layoutMessages([msg("1", YOU, "2026-10-15T04:30:00Z"), msg("2", YOU, "2026-10-15T04:35:00Z")], {
    viewerId: ME,
    cursor: null,
    offsetMinutes: newYork,
  });
  assert.deepEqual(rows.map((r) => (r.t === "day" ? r.dayKey : r.key)), ["2026-10-15", "1", "2"]);
  assert.equal(typeof localOffset(Date.now()), "number");
});

test("consecutive messages from one person group under one header", () => {
  const rows = layoutMessages(
    [
      msg("1", YOU, "2026-10-15T10:00:00Z"),
      msg("2", YOU, "2026-10-15T10:01:00Z"),
      msg("3", ME, "2026-10-15T10:02:00Z"),
      msg("4", ME, "2026-10-15T10:20:00Z"),
      msg("5", ME, "2026-10-15T10:21:00Z", { replyTo: { id: "1" } }),
      msg("6", null, "2026-10-15T10:22:00Z", { kind: "system" }),
      msg("7", ME, "2026-10-15T10:22:30Z"),
    ],
    { viewerId: ME, cursor: null, offsetMinutes: 0 },
  );
  assert.deepEqual(
    rows.map((r) => (r.t === "msg" ? `${r.m.id}${r.head ? "H" : ""}` : r.t)),
    ["day", "1H", "2", "3H", "4H", "5H", "6H", "7H"],
  );
});

test("a new day and the new-messages line both start a group", () => {
  const rows = layoutMessages(
    [
      msg("1", YOU, "2026-10-14T23:59:00Z"),
      msg("2", YOU, "2026-10-15T00:01:00Z"),
      msg("3", YOU, "2026-10-15T00:02:00Z"),
    ],
    { viewerId: ME, cursor: "2026-10-15T00:01:30Z", offsetMinutes: 0 },
  );
  assert.deepEqual(
    rows.map((r) => (r.t === "msg" ? `${r.m.id}${r.head ? "H" : ""}` : r.t)),
    ["day", "1H", "day", "2H", "new", "3H"],
  );
});

test("the new line skips your own messages and system lines", () => {
  const rows = layoutMessages(
    [
      msg("1", ME, "2026-10-15T10:00:00Z"),
      msg("2", null, "2026-10-15T10:01:00Z", { kind: "system" }),
      msg("3", YOU, "2026-10-15T10:02:00Z"),
    ],
    { viewerId: ME, cursor: "2026-10-15T09:00:00Z", offsetMinutes: null },
  );
  assert.deepEqual(rows.map((r) => (r.t === "msg" ? r.m.id : r.t)), ["1", "2", "new", "3"]);
});

test("#staff: its feed lines count as unread on the server, so the new line goes before the first unread one", () => {
  const feed = [
    msg("1", null, "2026-10-15T10:00:00Z", { kind: "system" }),
    msg("2", null, "2026-10-15T10:01:00Z", { kind: "system" }),
    msg("3", null, "2026-10-15T10:02:00Z", { kind: "system" }),
  ];
  const cursor = "2026-10-15T10:00:30Z";
  const ids = (rows: ReturnType<typeof layoutMessages>) => rows.map((r) => (r.t === "msg" ? r.m.id : r.t));
  // The reviewer's case: '2 unread' in the sidebar, and a divider to match.
  assert.deepEqual(ids(layoutMessages(feed, { viewerId: ME, cursor, offsetMinutes: null, systemKey: "staff" })), ["1", "new", "2", "3"]);
  // Anywhere else a system line is never unread (pins, joins, renames).
  assert.deepEqual(ids(layoutMessages(feed, { viewerId: ME, cursor, offsetMinutes: null, systemKey: "general" })), ["1", "2", "3"]);
  assert.deepEqual(ids(layoutMessages(feed, { viewerId: ME, cursor, offsetMinutes: null })), ["1", "2", "3"]);
  // A feed line read already stays above it; your own message never gets one.
  const mixed = [...feed.slice(0, 1), msg("4", ME, "2026-10-15T10:01:30Z"), ...feed.slice(2)];
  assert.deepEqual(ids(layoutMessages(mixed, { viewerId: ME, cursor, offsetMinutes: null, systemKey: "staff" })), ["1", "4", "new", "3"]);
});

test("no cursor, no new line; no offset, no day dividers", () => {
  const rows = layoutMessages([msg("1", YOU, "2026-10-15T10:00:00Z")], { viewerId: ME, cursor: null, offsetMinutes: null });
  assert.deepEqual(rows.map((r) => r.t), ["msg"]);
});

test("byTime orders by time, then id, pending last", () => {
  const list = [
    { id: "b", createdAt: "2026-10-15T10:00:00Z" },
    { id: "p", createdAt: "2026-10-15T09:00:00Z", pending: true },
    { id: "a", createdAt: "2026-10-15T10:00:00Z" },
    { id: "z", createdAt: "2026-10-15T08:00:00Z" },
  ].sort(byTime);
  assert.deepEqual(list.map((m) => m.id), ["z", "a", "b", "p"]);
});

test("mergeMessages adds, replaces and keeps identity when nothing changes", () => {
  const a = { id: "a", createdAt: "2026-10-15T10:00:00Z", v: 1 };
  const b = { id: "b", createdAt: "2026-10-15T10:01:00Z", v: 1 };
  const list = [a, b];
  assert.equal(mergeMessages(list, []), list);
  assert.equal(mergeMessages(list, [a]), list);
  const b2 = { ...b, v: 2 };
  const c = { id: "c", createdAt: "2026-10-15T09:00:00Z", v: 1 };
  assert.deepEqual(mergeMessages(list, [b2, c]), [c, a, b2]);
});

test("reconcilePage drops what the server no longer has, keeps live and pending ones", () => {
  const old = { id: "old", createdAt: "2026-10-15T08:00:00Z" };
  const gone = { id: "gone", createdAt: "2026-10-15T10:00:00Z" };
  const kept = { id: "kept", createdAt: "2026-10-15T10:01:00Z" };
  const live = { id: "live", createdAt: "2026-10-15T10:05:00Z" };
  const pending = { id: "tmp", createdAt: "2026-10-15T10:06:00Z", pending: true };
  const list = [old, gone, kept, live, pending];
  const page = [kept];
  // Complete page: "old" was inside it, so it's gone too.
  assert.deepEqual(
    reconcilePage(list, page, { asOf: "2026-10-15T10:04:00Z", complete: true }).map((m) => m.id),
    ["kept", "live", "tmp"],
  );
  // Cut at the limit: anything older than the page's oldest message is
  // outside what the server looked at, so it stays.
  assert.deepEqual(
    reconcilePage(list, [kept], { asOf: "2026-10-15T10:04:00Z", complete: false }).map((m) => m.id),
    ["old", "gone", "kept", "live", "tmp"],
  );
  const same = [kept, live];
  assert.equal(reconcilePage(same, [kept], { asOf: "2026-10-15T10:04:00Z", complete: true }), same);
});

test("reconcilePage keeps a failed send (its text and Retry) like a pending one", () => {
  const a = { id: "a", createdAt: "2026-10-15T09:59:00Z" };
  const failed = { id: "pending-1", createdAt: "2026-10-15T10:00:00Z", failed: "Slow down" };
  for (const complete of [true, false]) {
    assert.deepEqual(
      reconcilePage([a, failed], [a], { asOf: "2026-10-15T10:00:17Z", complete }).map((m) => m.id),
      ["a", "pending-1"],
    );
  }
});

test("a resync that changes nothing returns the same array of the same objects", () => {
  type M = { id: string; createdAt: string; body: string; reactions: Record<string, string[]>; replyTo: { id: string; preview: string; deleted: boolean } | null };
  const a: M = { id: "a", createdAt: "2026-10-15T10:00:00Z", body: "hi", reactions: { "👍": ["u1"] }, replyTo: null };
  const b: M = { id: "b", createdAt: "2026-10-15T10:01:00Z", body: "yo", reactions: {}, replyTo: { id: "a", preview: "hi", deleted: false } };
  const list = [a, b];
  const copies = structuredClone(list);
  assert.equal(reconcilePage(list, copies, { asOf: "2026-10-15T10:05:00Z", complete: true }), list);
  assert.equal(mergeMessages(list, copies), list);
  // One real change: a new array, with the untouched message still the same object.
  const next = mergeMessages(list, [{ ...copies[1], reactions: { "🔥": ["u2"] } }]);
  assert.notEqual(next, list);
  assert.equal(next[0], a);
  assert.deepEqual(next[1].reactions, { "🔥": ["u2"] });
});

test("sameData compares plain data by value", () => {
  assert.equal(sameData({ a: [1, { b: "x" }], c: null }, { c: null, a: [1, { b: "x" }] }), true);
  assert.equal(sameData({ a: [1, 2] }, { a: [2, 1] }), false);
  assert.equal(sameData({ a: 1 }, { a: 1, b: undefined }), false);
  assert.equal(sameData([], {}), false);
  assert.equal(sameData(null, {}), false);
});

test("a page read before a live delete doesn't bring the message, or its words in a quote, back", () => {
  const m1 = { id: "m1", createdAt: "2026-10-15T10:00:00Z", body: "hi", replyTo: null };
  // On screen after Realtime removed m2 and blanked m3's quote of it.
  const m3 = { id: "m3", createdAt: "2026-10-15T10:02:00Z", body: "reply", replyTo: { id: "m2", senderId: null, preview: "", deleted: true } };
  const page = [
    m1,
    { id: "m2", createdAt: "2026-10-15T10:01:00Z", body: "abusive text", replyTo: null },
    { ...m3, replyTo: { id: "m2", senderId: null, preview: "abusive text", deleted: false } },
  ];
  const deleted = new Set(["m2"]);
  const screen = [m1, m3];
  assert.equal(reconcilePage(screen, page, { asOf: "2026-10-15T10:05:00Z", complete: true, deleted }), screen);
  // An older page or a hydrate: same rule, and a quote of it arriving fresh is blank.
  const older = mergeMessages([m1], page.slice(1), { deleted });
  assert.deepEqual(
    older.map((m) => `${m.id}:${m.replyTo ? m.replyTo.preview || "(deleted)" : ""}`),
    ["m1:", "m3:(deleted)"],
  );
});

test("an edit seen live beats a page read before it", () => {
  type M = { id: string; createdAt: string; body: string; editedAt: string | null };
  const live: M = { id: "a", createdAt: "2026-10-15T10:00:00Z", body: "fixed", editedAt: "2026-10-15T10:03:00Z" };
  const stale: M = { id: "a", createdAt: "2026-10-15T10:00:00Z", body: "typo", editedAt: null };
  assert.equal(mergeMessages([live], [stale])[0], live);
  assert.equal(mergeMessages([live], [{ ...stale, editedAt: "2026-10-15T10:02:00Z" }])[0], live);
  const newer = { ...stale, body: "fixed again", editedAt: "2026-10-15T10:04:00Z" };
  assert.equal(mergeMessages([live], [newer])[0], newer);
});

test("reconcilePage pages by (created_at, id): a twin of the page's oldest row just outside it stays", () => {
  const t = "2026-10-15T10:00:00Z";
  const x1 = { id: "x1", createdAt: t };
  const x2 = { id: "x2", createdAt: t };
  const newer = { id: "n", createdAt: "2026-10-15T10:01:00Z" };
  // The server cut at its limit between x1 and x2 (ordered created_at desc, id desc).
  assert.deepEqual(
    reconcilePage([x1, x2, newer], [x2, newer], { asOf: "2026-10-15T10:05:00Z", complete: false }).map((m) => m.id),
    ["x1", "x2", "n"],
  );
  // A complete page that lacks it means it's gone.
  assert.deepEqual(
    reconcilePage([x1, x2, newer], [x2, newer], { asOf: "2026-10-15T10:05:00Z", complete: true }).map((m) => m.id),
    ["x2", "n"],
  );
});

test("typingLine", () => {
  assert.equal(typingLine([]), "");
  assert.equal(typingLine(["Maya"]), "Maya is typing…");
  assert.equal(typingLine(["Maya", "Dev"]), "Maya and Dev are typing…");
  assert.equal(typingLine(["A", "B", "C"]), "A, B and C are typing…");
  assert.equal(typingLine(["A", "B", "C", "D"]), "Several people are typing…");
});

test("initials", () => {
  assert.equal(initials("Maya Chen"), "MC");
  assert.equal(initials("dev"), "D");
  assert.equal(initials("Ana María de la Cruz"), "AC");
  assert.equal(initials("  "), "?");
  assert.equal(initials("Émile Zola"), "ÉZ");
});

test("mentionsViewer", () => {
  assert.equal(mentionsViewer({ mentions: [ME], mentionEveryone: false, senderId: YOU }, ME), true);
  assert.equal(mentionsViewer({ mentions: [], mentionEveryone: true, senderId: YOU }, ME), true);
  assert.equal(mentionsViewer({ mentions: [ME], mentionEveryone: true, senderId: ME }, ME), false);
  assert.equal(mentionsViewer({ mentions: [], mentionEveryone: false, senderId: YOU }, ME), false);
});
