import test from "node:test";
import assert from "node:assert/strict";
import { applyUpdate, bumpSidebarRow, pendingTwin, quotePreview, sameMessage, toUiMessage, withoutMessage } from "./live-rows.ts";
import { newClientId } from "./util.ts";
import type { LiveRow } from "./use-chat-live";
import type { SidebarData, SidebarItem, UiMessage } from "./types";

const T = "2026-10-15T10:00:00.000Z";

function msg(id: string, over: Partial<UiMessage> = {}): UiMessage {
  return {
    id,
    channelId: "c1",
    senderId: "u1",
    body: `body of ${id}`,
    kind: "message",
    replyTo: null,
    mentions: [],
    mentionEveryone: false,
    attachments: [],
    reactions: {},
    createdAt: T,
    editedAt: null,
    pinnedAt: null,
    ...over,
  };
}

/** An UPDATE as Realtime delivers it: only the columns the change record carried. */
function row(id: string, over: Partial<LiveRow>): LiveRow {
  return { id, channel_id: "c1", sender_id: "u1", kind: "message", reply_to_id: null, created_at: T, ...over };
}

test("applyUpdate: a reaction on a long message arrives without its body (TOAST) and changes nothing else", () => {
  const long = msg("long", { body: "x".repeat(3900), reactions: {} });
  const reply = msg("r", { replyTo: { id: "long", senderId: "u1", preview: "x".repeat(300), deleted: false } });
  const list = [long, reply];
  // No `body` key at all: the shape that crashed `row.body.slice`.
  const next = applyUpdate(list, row("long", { reactions: { "👍": ["u2"] }, edited_at: null, pinned_at: null }));
  assert.equal(next[0].body, long.body);
  assert.deepEqual(next[0].reactions, { "👍": ["u2"] });
  assert.equal(next[1], reply, "the reply quoting it is untouched");
});

test("applyUpdate: a column the record leaves out keeps its value", () => {
  const m = msg("a", { reactions: { "🔥": ["u3"] }, pinnedAt: T, mentions: ["u9"] });
  const next = applyUpdate([m], row("a", { body: "edited", edited_at: T }));
  assert.equal(next[0].body, "edited");
  assert.deepEqual(next[0].reactions, { "🔥": ["u3"] });
  assert.equal(next[0].pinnedAt, T);
  assert.deepEqual(next[0].mentions, ["u9"]);
});

test("applyUpdate: an edit reaches the quotes of a message that isn't loaded", () => {
  const reply = msg("r", { replyTo: { id: "gone-from-window", senderId: "u2", preview: "old words", deleted: false } });
  const next = applyUpdate([reply], row("gone-from-window", { body: "new words", edited_at: T }));
  assert.equal(next[0].replyTo?.preview, "new words");
});

test("applyUpdate: a delete drops the message and blanks every quote of it", () => {
  const a = msg("a");
  const r = msg("r", { replyTo: { id: "a", senderId: "u1", preview: "body of a", deleted: false } });
  const next = applyUpdate([a, r], row("a", { deleted_at: T, body: "" }));
  assert.deepEqual(next.map((m) => m.id), ["r"]);
  assert.deepEqual(next[0].replyTo, { id: "a", senderId: "u1", preview: "", deleted: true });
});

test("applyUpdate and withoutMessage: nothing to do returns the same list", () => {
  const list = [msg("a")];
  assert.equal(withoutMessage(list, "zzz"), list);
  assert.equal(applyUpdate(list, row("zzz", { reactions: {} })), list);
});

test("quotePreview: a file-only message is '[attachment]', not a deleted one", () => {
  assert.equal(quotePreview({ body: "", attachments: [{}] }), "[attachment]");
  assert.equal(quotePreview({ body: "", attachments: [] }), "");
  assert.equal(quotePreview({ body: "hi", attachments: [{}] }), "hi");
});

test("quotePreview: a long spoiler cut at 300 stays a spoiler", () => {
  const preview = quotePreview({ body: `||${"secret ".repeat(60)}||`, attachments: [] });
  assert.ok(preview.length <= 300);
  assert.ok(preview.startsWith("||") && preview.endsWith("||"));
});

test("toUiMessage: a reply to a loaded image is '[attachment]'; to an unloaded one, a placeholder (not 'deleted')", () => {
  const image = msg("img", { body: "", attachments: [{ path: "p", name: "a.png", size: 1, type: "image/png" }] });
  const live = toUiMessage(row("n", { body: "nice", reply_to_id: "img" }), [image]);
  assert.deepEqual(live.replyTo, { id: "img", senderId: "u1", preview: "[attachment]", deleted: false });
  const orphan = toUiMessage(row("n2", { body: "nice", reply_to_id: "elsewhere" }), [image]);
  assert.deepEqual(orphan.replyTo, { id: "elsewhere", senderId: null, preview: "", deleted: false });
});

test("toUiMessage: an echo carries the sender's client id when the row has one (0104)", () => {
  assert.equal(toUiMessage(row("n", { body: "hi", client_id: "cid-1" }), []).clientId, "cid-1");
  const before = toUiMessage(row("n", { body: "hi" }), []);
  assert.equal("clientId" in before, false, "a row from before 0104 has none, and the shape says so");
  assert.equal("clientId" in toUiMessage(row("n", { body: "hi", client_id: null }), []), false);
});

test("pendingTwin: our own echo without a client id adopts the oldest bubble still sending the same words", () => {
  const sending = (id: string, body: string, over: Partial<UiMessage> = {}) => msg(id, { body, senderId: "me", pending: true, ...over });
  const list = [msg("old", { body: "ok", senderId: "me" }), sending("p1", "ok"), sending("p2", "ok"), sending("p3", "other")];
  const echo = (over: Partial<LiveRow>) => row("srv", { sender_id: "me", body: "ok", ...over });
  assert.equal(pendingTwin(list, echo({}), "me"), 1);
  // With a client id the merge settles the exact bubble instead (lib/chat-view.ts).
  assert.equal(pendingTwin(list, echo({ client_id: "cid" }), "me"), -1);
  assert.equal(pendingTwin(list, echo({ sender_id: "you" }), "me"), -1, "someone else's message is never ours");
  assert.equal(pendingTwin([msg("f", { body: "ok", senderId: "me", failed: "Offline" })], echo({}), "me"), -1, "a failed bubble isn't guessed at");
});

test("newClientId: a fresh v4 uuid every time, with or without crypto.randomUUID", () => {
  const v4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  const ids = new Set(Array.from({ length: 500 }, () => newClientId()));
  assert.equal(ids.size, 500);
  for (const id of ids) assert.match(id, v4);
  const real = globalThis.crypto;
  Object.defineProperty(globalThis, "crypto", { value: { getRandomValues: real.getRandomValues.bind(real) }, configurable: true });
  try {
    const fallback = new Set(Array.from({ length: 200 }, () => newClientId()));
    assert.equal(fallback.size, 200);
    for (const id of fallback) assert.match(id, v4);
  } finally {
    Object.defineProperty(globalThis, "crypto", { value: real, configurable: true });
  }
});

test("sameMessage: a structurally equal copy is the same; a changed one, or an unsent bubble, isn't", () => {
  const a = msg("a", { reactions: { "👍": ["u2"] } });
  assert.ok(sameMessage(a, JSON.parse(JSON.stringify(a))));
  assert.ok(!sameMessage(a, { ...a, reactions: {} }));
  assert.ok(!sameMessage(a, { ...a, editedAt: T }));
  assert.ok(!sameMessage({ ...a, failed: "Slow mode" }, a));
});

// ---------------------------------------------------------------------------
// bumpSidebarRow: a live INSERT on the sidebar
// ---------------------------------------------------------------------------

const ME = "me";
const OTHER = "other";
const BLOCKED = "blocked";

function sideItem(id: string, over: Partial<SidebarItem> = {}): SidebarItem {
  return {
    id,
    kind: "channel",
    label: id,
    topic: null,
    audience: "everyone",
    posting: "everyone",
    systemKey: null,
    teamId: null,
    cohortId: null,
    otherId: null,
    memberIds: [],
    lastMessageAt: null,
    preview: null,
    unread: 0,
    mentions: 0,
    notify: null,
    position: 0,
    ...over,
  };
}

function sidebar(): SidebarData {
  return {
    channels: [sideItem("wins"), sideItem("staff", { systemKey: "staff", audience: "staff" })],
    conversations: [
      sideItem("dm-old", { kind: "dm", audience: "members", lastMessageAt: "2026-10-15T09:00:00.000Z" }),
      sideItem("dm-quiet", { kind: "dm", audience: "members", notify: "mentions", lastMessageAt: "2026-10-15T09:30:00.000Z" }),
      sideItem("group", { kind: "group", audience: "members", lastMessageAt: "2026-10-15T09:45:00.000Z" }),
    ],
    people: {},
    blocked: [BLOCKED],
  };
}

let seq = 0;
function insert(channelId: string, over: Partial<LiveRow> = {}): LiveRow {
  seq++;
  return {
    id: `m${seq}`,
    channel_id: channelId,
    sender_id: OTHER,
    kind: "message",
    reply_to_id: null,
    body: `hello ${seq}`,
    mentions: [],
    mention_everyone: false,
    created_at: new Date(Date.parse("2026-10-15T10:00:00.000Z") + seq * 1000).toISOString(),
    ...over,
  };
}

const opts = { viewerId: ME, reading: false, personName: (id: string) => (id === ME ? "Me" : null) };
const find = (s: SidebarData, id: string) => [...s.channels, ...s.conversations].find((i) => i.id === id)!;

/** What ChatApp's onInsert does with the answer: refetch the sidebar only when the row isn't in it. */
function feed(start: SidebarData, rows: LiveRow[], reading = false) {
  let s = start;
  let sidebarGets = 0;
  for (const row of rows) {
    const out = bumpSidebarRow(s, row, { ...opts, reading });
    if (out.missing) sidebarGets++;
    s = out.sidebar;
  }
  return { s, sidebarGets };
}

test("bumpSidebarRow: N live messages in a channel that's in the sidebar refetch it 0 times", () => {
  const rows = Array.from({ length: 5 }, () => insert("wins"));
  const { s, sidebarGets } = feed(sidebar(), rows);
  assert.equal(sidebarGets, 0);
  assert.equal(find(s, "wins").unread, 5);
  assert.equal(find(s, "wins").mentions, 0, "a channel's number is its mentions");
  assert.equal(find(s, "wins").lastMessageAt, rows[4].created_at);
  // Read right now: recency moves, nothing to count.
  const read = feed(sidebar(), [insert("wins")], true);
  assert.equal(read.sidebarGets, 0);
  assert.equal(find(read.s, "wins").unread, 0);
});

test("bumpSidebarRow: a conversation not in the sidebar asks for a refetch, and changes nothing", () => {
  const s = sidebar();
  const out = bumpSidebarRow(s, insert("closed-dm"), opts);
  assert.equal(out.missing, true);
  assert.equal(out.sidebar, s);
});

test("bumpSidebarRow: what counts mirrors chat_unread — your own, a blocked sender's and (outside #staff) system lines don't", () => {
  const { s } = feed(sidebar(), [
    insert("wins", { sender_id: ME }),
    insert("wins", { sender_id: BLOCKED }),
    insert("wins", { kind: "system", sender_id: null }),
  ]);
  assert.equal(find(s, "wins").unread, 0);
  assert.equal(find(s, "wins").mentions, 0);
});

test("bumpSidebarRow: #staff's feed lines count, and move its recency (countsAsMessage)", () => {
  const line = insert("staff", { kind: "system", sender_id: null, body: "New application: Maya Chen" });
  const { s } = feed(sidebar(), [line, insert("staff", { kind: "system", sender_id: null })]);
  assert.equal(find(s, "staff").unread, 2);
  assert.equal(find(s, "staff").lastMessageAt !== null, true);
  const general = feed(sidebar(), [insert("wins", { kind: "system", sender_id: null })]).s;
  assert.equal(find(general, "wins").lastMessageAt, null, "a system line elsewhere isn't the newest message");
});

test("bumpSidebarRow: the number on a row follows sidebarMentions (DM: unread; 'Only @mentions': mentions)", () => {
  const plain = feed(sidebar(), [insert("dm-old"), insert("dm-quiet"), insert("group"), insert("wins")]).s;
  assert.deepEqual([find(plain, "dm-old").mentions, find(plain, "dm-quiet").mentions, find(plain, "group").mentions], [1, 0, 1]);
  assert.deepEqual([find(plain, "dm-quiet").unread, find(plain, "wins").mentions], [1, 0]);
  const pinged = feed(sidebar(), [
    insert("dm-quiet", { mentions: [ME] }),
    insert("wins", { mentions: [ME] }),
    insert("group", { mention_everyone: true }),
  ]).s;
  assert.deepEqual([find(pinged, "dm-quiet").mentions, find(pinged, "wins").mentions, find(pinged, "group").mentions], [1, 1, 1]);
});

test("bumpSidebarRow: a DM's preview and its place in the list follow the new message", () => {
  const { s } = feed(sidebar(), [insert("dm-old", { body: "", attachments: [{}] })]);
  assert.equal(s.conversations[0].id, "dm-old");
  assert.equal(find(s, "dm-old").preview, "[attachment]");
  const MAYA = "22222222-2222-4222-8222-222222222222";
  const named = bumpSidebarRow(sidebar(), insert("dm-old", { body: `hi <@${MAYA}>` }), {
    ...opts,
    personName: (id) => (id === MAYA ? "Maya Chen" : null),
  }).sidebar;
  assert.equal(find(named, "dm-old").preview, "hi @Maya Chen");
});
