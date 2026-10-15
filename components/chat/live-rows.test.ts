import test from "node:test";
import assert from "node:assert/strict";
import { applyUpdate, quotePreview, sameMessage, toUiMessage, withoutMessage } from "./live-rows.ts";
import type { LiveRow } from "./use-chat-live";
import type { UiMessage } from "./types";

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

test("sameMessage: a structurally equal copy is the same; a changed one, or an unsent bubble, isn't", () => {
  const a = msg("a", { reactions: { "👍": ["u2"] } });
  assert.ok(sameMessage(a, JSON.parse(JSON.stringify(a))));
  assert.ok(!sameMessage(a, { ...a, reactions: {} }));
  assert.ok(!sameMessage(a, { ...a, editedAt: T }));
  assert.ok(!sameMessage({ ...a, failed: "Slow mode" }, a));
});
