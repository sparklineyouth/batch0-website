import test from "node:test";
import assert from "node:assert/strict";
import {
  byTime,
  dayKey,
  initials,
  layoutMessages,
  mentionsViewer,
  mergeMessages,
  reconcilePage,
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
