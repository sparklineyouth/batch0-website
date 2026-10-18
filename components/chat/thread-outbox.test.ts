import test from "node:test";
import assert from "node:assert/strict";
import { createThreadOutbox } from "./thread-outbox.ts";
import { mergeMessages } from "../../lib/chat-view.ts";
import { helpNotice, spokenSince, unansweredLabel } from "./util.ts";
import type { UiMessage } from "./types";

// The thread pane's client pieces (migration 0110) that outlive the pane or
// are only words: the outbox that keeps a thread's unsent and failed replies
// when the pane closes or moves to another thread mid-send; what "Ask the
// team" says back, which never hands one asker another's Support reference;
// and the Unanswered list's spoken labels.

const T = "2026-10-17T10:00:00.000Z";
const ROOT = "r1";
const OTHER = "r2";

function reply(id: string, over: Partial<UiMessage> = {}): UiMessage {
  return {
    id,
    channelId: "c1",
    senderId: "me",
    body: `reply ${id}`,
    kind: "message",
    replyTo: null,
    mentions: [],
    mentionEveryone: false,
    attachments: [],
    reactions: {},
    createdAt: T,
    editedAt: null,
    pinnedAt: null,
    threadRootId: ROOT,
    ...over,
  };
}

/**
 * What ThreadPanel does with a send, against the outbox alone: the pane is
 * "open on" a root or not, and the answer lands wherever the reply is now —
 * on screen (the pane's list, mirrored with keep), or kept for later.
 */
function pane(outbox: ReturnType<typeof createThreadOutbox>) {
  let open: string | null = null;
  let list: UiMessage[] = [];
  const set = (fn: (l: UiMessage[]) => UiMessage[]) => {
    list = fn(list);
    outbox.keep(open!, list);
  };
  return {
    open(rootId: string) {
      open = rootId;
      list = outbox.get(rootId);
    },
    close() {
      open = null;
      list = [];
    },
    apply(rootId: string, fn: (l: UiMessage[]) => UiMessage[]) {
      if (open === rootId) set(fn);
      else outbox.update(rootId, fn);
    },
    get list() {
      return list;
    },
  };
}

test("a thread reply that fails after Back is kept with its Retry, and the feed is told under its root", () => {
  const outbox = createThreadOutbox();
  const seen: ReadonlySet<string>[] = [];
  outbox.subscribe(() => seen.push(outbox.failedRoots()));
  const p = pane(outbox);
  p.open(ROOT);
  const temp = reply("pending-1", { pending: true, retry: { body: "reply", replyToId: null, attachments: [], clientId: "k1", threadRootId: ROOT } });
  p.apply(ROOT, (l) => [...l, temp]);
  assert.deepEqual(outbox.get(ROOT).map((m) => m.id), ["pending-1"], "still sending: kept outside the pane already");
  assert.equal(outbox.failedRoots().size, 0, "sending isn't failing");
  // Back on a phone: the pane unmounts with the reply in flight; then it fails (offline).
  p.close();
  p.apply(ROOT, (l) => l.map((m) => (m.id === "pending-1" ? { ...m, pending: false, failed: "Couldn't reach batch0." } : m)));
  assert.deepEqual(Array.from(outbox.failedRoots()), [ROOT], "the feed can say a reply didn't send");
  assert.equal(seen.length, 1);
  // Opening the thread again: the reply is there, failed, with what it needs to retry.
  p.open(ROOT);
  assert.equal(p.list.length, 1);
  assert.equal(p.list[0].failed, "Couldn't reach batch0.");
  assert.equal(p.list[0].retry?.clientId, "k1", "the same client id, so a Retry is the same reply (0104)");
  // Retry, and it goes: nothing kept, and the feed's warning comes down.
  p.apply(ROOT, (l) => l.filter((m) => m.id !== "pending-1"));
  p.apply(ROOT, (l) => [...l, reply("pending-2", { pending: true })]);
  p.apply(ROOT, (l) => mergeMessages(l.filter((m) => m.id !== "pending-2"), [reply("real-1")]));
  assert.deepEqual(outbox.get(ROOT), []);
  assert.equal(outbox.failedRoots().size, 0);
  assert.equal(seen.length, 2, "told once when it failed, once when it cleared");
});

test("opening another thread mid-send: the answer lands on its own thread, not the one now open", () => {
  const outbox = createThreadOutbox();
  const p = pane(outbox);
  p.open(ROOT);
  p.apply(ROOT, (l) => [...l, reply("pending-1", { pending: true })]);
  p.open(OTHER);
  assert.deepEqual(p.list, [], "the other thread has nothing of ROOT's");
  // ROOT's send succeeds while OTHER is open.
  p.apply(ROOT, (l) => mergeMessages(l.filter((m) => m.id !== "pending-1"), [reply("real-1")]));
  assert.deepEqual(p.list, []);
  assert.deepEqual(outbox.get(ROOT), [], "sent: nothing left to keep (the next page brings the real one)");
  // A failure the same way stays on ROOT.
  p.apply(ROOT, (l) => [...l, reply("pending-2", { failed: "Couldn't send. Try again." })]);
  assert.deepEqual(outbox.get(OTHER), []);
  assert.deepEqual(outbox.get(ROOT).map((m) => m.id), ["pending-2"]);
  // Discarding it in the thread lets it go.
  p.open(ROOT);
  p.apply(ROOT, (l) => l.filter((m) => m.id !== "pending-2"));
  assert.deepEqual(outbox.get(ROOT), []);
  assert.equal(outbox.failedRoots().size, 0);
});

test("the outbox keeps only what hasn't gone: a page of sent replies is never held on to", () => {
  const outbox = createThreadOutbox();
  outbox.keep(ROOT, [reply("a"), reply("b"), reply("pending-1", { failed: "x" })]);
  assert.deepEqual(outbox.get(ROOT).map((m) => m.id), ["pending-1"]);
  const before = outbox.failedRoots();
  outbox.keep(ROOT, [reply("a"), reply("pending-1", { failed: "x" }), reply("c")]);
  assert.equal(outbox.failedRoots(), before, "the same Set while nothing changed, so React doesn't re-render the feed");
  // get() is a copy: the pane can't change what's kept behind the outbox's back.
  outbox.get(ROOT).pop();
  assert.equal(outbox.get(ROOT).length, 1);
});

test("Ask the team's answer: the reference only for whoever filed it (or the team); a second asker is told the team heard them", () => {
  assert.equal(helpNotice(null), "Sent to the batch0 team. Someone will take a look.");
  assert.equal(helpNotice({ reference: null, outcome: null }), "Sent to the batch0 team. Someone will take a look.");
  assert.match(helpNotice({ reference: "B0-1", outcome: "created", yours: true }), /as a help request \(B0-1\)/);
  // Someone else's request: no reference (the server sends none), and no "you've been added to it".
  const second = helpNotice({ reference: null, outcome: "linked", yours: false });
  assert.equal(second, "This thread already has a help request with the team. They've been told you asked too.");
  assert.doesNotMatch(second, /added|B0-/);
  assert.equal(helpNotice({ reference: "B0-1", outcome: "linked", yours: true }), "Your help request (B0-1) is still with the team. They've been told you asked again.");
  // Waiting on the asker or resolved, now back with the team.
  assert.equal(helpNotice({ reference: "B0-1", outcome: "reopened", yours: true }), "Your help request (B0-1) is back with the team. They'll pick it up again.");
  assert.equal(helpNotice({ reference: null, outcome: "reopened", yours: false }), "This thread's help request is back with the team. They'll pick it up again.");
});

test("the Unanswered list's labels are spoken words: never 'just now ago', '5m' or 'Oct 3 ago'", () => {
  const now = Date.parse("2026-10-17T12:00:00.000Z");
  const ago = (ms: number) => new Date(now - ms).toISOString();
  assert.equal(spokenSince(ago(10_000), now), "just now");
  assert.equal(spokenSince(ago(60_000), now), "1 minute ago");
  assert.equal(spokenSince(ago(5 * 60_000), now), "5 minutes ago");
  assert.equal(spokenSince(ago(3_600_000), now), "1 hour ago");
  assert.equal(spokenSince(ago(3 * 86_400_000), now), "3 days ago");
  assert.match(spokenSince(ago(14 * 86_400_000), now), /^on \S/);
  assert.equal(spokenSince("not a date", now), "");
  assert.equal(unansweredLabel("Maya", ago(10_000), 0, now), "Maya asked just now, no replies yet. Open thread");
  assert.equal(unansweredLabel("Maya", ago(5 * 60_000), 1, now), "Maya asked 5 minutes ago, 1 reply. Open thread");
  assert.match(unansweredLabel("Maya", ago(14 * 86_400_000), 3, now), /^Maya asked on \S+.*, 3 replies\. Open thread$/);
  assert.doesNotMatch(unansweredLabel("Maya", ago(14 * 86_400_000), 3, now), / ago,/);
});
