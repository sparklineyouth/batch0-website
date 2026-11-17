import test from "node:test";
import assert from "node:assert/strict";
import * as nodeModule from "node:module";
import { pathToFileURL, fileURLToPath } from "node:url";
import path from "node:path";

// GET /chat/api/thread (0110), the real route and the real readThread
// (app/chat/api/reads.ts) with doubles for the reads beneath them. A thread
// grants nothing: it opens only for someone who reads its channel
// (openChannelFor, asked FIRST, for the signed-in person), only in a text
// channel, and only when the root is a person's feed message IN THAT
// channel — so a root id from another channel, a reply's id or a system
// line's opens nothing, and nothing about the thread is read before the
// channel check says yes. The answer is the routes' one shape: 401 signed
// out, 400 a bad request, 404 "not available" (the same for "doesn't exist"
// and "not yours"), a 200 with ok:false when a read failed, never a 500.

type Row = Record<string, any>;
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ME = uuid(1);
const HELP = uuid(10);
const GENERAL = uuid(11);
const DM = uuid(12);
const ROOT = uuid(20);
const ELSEWHERE = uuid(21);
const REPLY = uuid(22);
const SYSTEM = uuid(23);
const GONE = uuid(24);

const channels: Record<string, Row> = {
  [HELP]: { id: HELP, kind: "channel", systemKey: "help" },
  [GENERAL]: { id: GENERAL, kind: "channel", systemKey: "general" },
  [DM]: { id: DM, kind: "dm", systemKey: null },
};
const messages: Record<string, Row> = {
  [ROOT]: { id: ROOT, channel_id: HELP, sender_id: uuid(2), kind: "message", thread_root_id: null, deleted_at: null },
  [ELSEWHERE]: { id: ELSEWHERE, channel_id: GENERAL, sender_id: uuid(2), kind: "message", thread_root_id: null, deleted_at: null },
  [REPLY]: { id: REPLY, channel_id: HELP, sender_id: uuid(3), kind: "message", thread_root_id: ROOT, deleted_at: null },
  [SYSTEM]: { id: SYSTEM, channel_id: HELP, sender_id: null, kind: "system", thread_root_id: null, deleted_at: null },
  [GONE]: { id: GONE, channel_id: HELP, sender_id: uuid(2), kind: "message", thread_root_id: null, deleted_at: "2026-10-17T10:00:00.000Z" },
};

const state = {
  /** The signed-in person, or null. */
  viewer: null as null | { profile: { id: string }; caps: { permissions: string[]; superAdmin: boolean } },
  /** Channels this viewer reads; openChannelFor answers null for the rest. */
  reads: new Set<string>(),
  ready: true,
  /** Every read beneath the route, in order, with what it was asked. */
  calls: [] as string[],
  /** Throw from this read. */
  fail: null as null | { read: string; error: Error & { code?: string } },
};

const call = (name: string, ...args: unknown[]) => {
  state.calls.push(`${name}(${args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(", ")})`);
  if (state.fail?.read === name) throw state.fail.error;
};

(globalThis as any).__threadRoute = {
  getViewer: async () => state.viewer,
  threadsReady: async () => {
    call("threadsReady");
    return state.ready;
  },
  openChannelFor: async (id: string, userId: string, caps: unknown) => {
    call("openChannelFor", id, userId, caps);
    const channel = channels[id];
    return channel && state.reads.has(id) ? { channel, reported: false, viewer: { userId } } : null;
  },
  getMessageRow: async (id: string) => {
    call("getMessageRow", id);
    return messages[id] ? { ...messages[id] } : null;
  },
  getThreadRow: async (id: string) => {
    call("getThreadRow", id);
    return { rootId: id, question: "open", answerId: null, helpTicketId: null };
  },
  listThreadReplies: async (channelId: string, rootId: string, opts: unknown) => {
    call("listThreadReplies", channelId, rootId, opts);
    return { replies: [{ id: REPLY, channelId, threadRootId: rootId, senderId: uuid(3) }], hasMoreBefore: false };
  },
  getMessages: async (ids: string[]) => {
    call("getMessages", ids.join(","));
    return ids.map((id) => ({ id, channelId: messages[id].channel_id, senderId: messages[id].sender_id }));
  },
  describeThread: async (viewer: { userId: string }, _caps: unknown, channel: Row, root: Row) => {
    call("describeThread", viewer.userId, channel.id, root.id);
    return { rootId: root.id, channelId: channel.id, question: "open", answerId: null };
  },
  getPeople: async () => new Map(),
};

const root = fileURLToPath(new URL("../", import.meta.url));
const fake = (source: string) => `data:text/javascript,${encodeURIComponent(source)}`;
const g = "const t=globalThis.__threadRoute;";
const fwd = (...names: string[]) => g + names.map((n) => `export const ${n}=(...a)=>t.${n}(...a);`).join("");
const unused = (...names: string[]) => names.map((n) => `export const ${n}=()=>{throw new Error('${n}: not this route');};`).join("");
(nodeModule as any).registerHooks({
  resolve(specifier: string, context: any, next: any) {
    const doubles: Record<string, string> = {
      "server-only": "export {};",
      "@/lib/auth": fwd("getViewer"),
      "@/lib/chat":
        fwd("openChannelFor", "getMessageRow", "listThreadReplies", "getMessages", "getPeople") +
        unused("buildSidebar", "countAttention", "getChatViewer", "listChannelPeople", "listMessages", "listPins"),
      "@/lib/chat-threads": fwd("threadsReady", "getThreadRow", "describeThread"),
      "@/lib/chat-questions": unused("listOpenQuestions", "openQuestionCount"),
      // The course item is resolved per viewer (lib/chat-about.ts): not this test's.
      "@/lib/chat-about": "export const withAbout=async(m)=>m;",
      "@/lib/chat-payload": "export const peopleIn=()=>[];",
    };
    if (doubles[specifier]) return { url: fake(doubles[specifier]), shortCircuit: true };
    if (specifier === "next/server") return next("next/server.js", context);
    if (specifier.startsWith("@/")) return next(pathToFileURL(path.join(root, specifier.slice(2) + ".ts")).href, context);
    // The route's own imports ("../respond", "../reads") name no extension.
    if (specifier.startsWith(".") && !path.extname(specifier) && context.parentURL?.includes("/app/chat/api/")) {
      return next(new URL(`${specifier}.ts`, context.parentURL).href, context);
    }
    return next(specifier, context);
  },
});

const { GET } = await import("../app/chat/api/thread/route.ts");
const { NextRequest } = await import("next/server.js");

const CAPS = { permissions: ["student.dashboard"], superAdmin: false };

function reset() {
  state.viewer = { profile: { id: ME }, caps: CAPS };
  state.reads = new Set([HELP, GENERAL, DM]);
  state.ready = true;
  state.calls = [];
  state.fail = null;
}

async function get(query: string) {
  const res = await GET(new NextRequest(`http://localhost/chat/api/thread?${query}`));
  return { status: res.status, cache: res.headers.get("cache-control"), body: (await res.json()) as Row };
}

const asked = (name: string) => state.calls.filter((c) => c.startsWith(`${name}(`));

test("a reader of the channel gets the thread: the channel checked first, for the signed-in person, then the root in it", async () => {
  reset();
  const r = await get(`c=${HELP}&root=${ROOT}`);
  assert.equal(r.status, 200);
  assert.equal(r.cache, "no-store");
  assert.equal(r.body.ok, true);
  assert.equal(r.body.data.root.id, ROOT);
  assert.deepEqual(r.body.data.replies.map((m: Row) => m.id), [REPLY]);
  assert.equal(r.body.data.info.rootId, ROOT);
  assert.equal(typeof r.body.data.asOf, "string");
  // The channel rule, asked for exactly who's signed in, before anything about the thread.
  assert.deepEqual(asked("openChannelFor"), [`openChannelFor(${HELP}, ${ME}, ${JSON.stringify(CAPS)})`]);
  const first = state.calls.findIndex((c) => c.startsWith("openChannelFor("));
  const thread = state.calls.findIndex((c) => /^(getMessageRow|getThreadRow|listThreadReplies|getMessages|describeThread)\(/.test(c));
  assert.ok(first !== -1 && first < thread, state.calls.join(" → "));
  // The replies are read from the channel the check cleared, for the root it found there.
  assert.deepEqual(asked("listThreadReplies"), [`listThreadReplies(${HELP}, ${ROOT}, {})`]);
  assert.deepEqual(asked("describeThread"), [`describeThread(${ME}, ${HELP}, ${ROOT})`]);
});

test("someone who can't read the channel gets 'not available', and nothing about the thread is read", async () => {
  reset();
  state.reads = new Set([GENERAL]);
  const r = await get(`c=${HELP}&root=${ROOT}`);
  assert.equal(r.status, 404);
  assert.equal(r.body.ok, false);
  assert.match(r.body.error, /isn't available/);
  assert.deepEqual(state.calls, ["threadsReady()", `openChannelFor(${HELP}, ${ME}, ${JSON.stringify(CAPS)})`]);
  // The same answer for a channel that doesn't exist at all.
  reset();
  const none = await get(`c=${uuid(99)}&root=${ROOT}`);
  assert.deepEqual([none.status, none.body.error], [r.status, r.body.error]);
});

test("a root from another channel opens nothing, even for someone who reads both", async () => {
  reset();
  // ELSEWHERE is a #general message: asked for under #help, it isn't #help's thread.
  const r = await get(`c=${HELP}&root=${ELSEWHERE}`);
  assert.equal(r.status, 404);
  assert.deepEqual(asked("listThreadReplies"), []);
  assert.deepEqual(asked("describeThread"), []);
  assert.deepEqual(asked("getMessages"), []);
  // Under its own channel it opens.
  reset();
  assert.equal((await get(`c=${GENERAL}&root=${ELSEWHERE}`)).status, 200);
  // And a reader of #help only can't reach #general's thread through #help.
  reset();
  state.reads = new Set([HELP]);
  assert.equal((await get(`c=${HELP}&root=${ELSEWHERE}`)).status, 404);
  assert.deepEqual(asked("listThreadReplies"), []);
});

test("only a person's feed message has a thread: a reply, a system line, a missing message, a DM — 404", async () => {
  for (const [query, why] of [
    [`c=${HELP}&root=${REPLY}`, "a reply can't be a root (one level)"],
    [`c=${HELP}&root=${SYSTEM}`, "a system line takes no replies"],
    [`c=${HELP}&root=${uuid(98)}`, "no such message"],
    [`c=${DM}&root=${ROOT}`, "DMs and groups have no threads"],
  ]) {
    reset();
    const r = await get(query);
    assert.equal(r.status, 404, why);
    assert.deepEqual(asked("listThreadReplies"), [], why);
    assert.deepEqual(asked("describeThread"), [], why);
  }
  // A DM is refused on the channel's kind alone, before its root is looked up.
  reset();
  await get(`c=${DM}&root=${ROOT}`);
  assert.deepEqual(asked("getMessageRow"), []);
});

test("a deleted root still opens its thread (its replies stay), without its words", async () => {
  reset();
  const r = await get(`c=${HELP}&root=${GONE}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.data.root, null);
  assert.deepEqual(r.body.data.replies.map((m: Row) => m.id), [REPLY]);
  assert.deepEqual(asked("getMessages"), [], "the deleted root's row isn't read for the screen");
});

test("signed out, a bad request, or before 0110: refused before any channel is looked at", async () => {
  reset();
  state.viewer = null;
  assert.equal((await get(`c=${HELP}&root=${ROOT}`)).status, 401);
  assert.deepEqual(asked("openChannelFor"), []);
  for (const query of [`root=${ROOT}`, `c=${HELP}`, `c=not-a-uuid&root=${ROOT}`, `c=${HELP}&root=${ROOT}&before=yesterday`]) {
    reset();
    assert.equal((await get(query)).status, 400, query);
    assert.deepEqual(state.calls, [], query);
  }
  reset();
  state.ready = false;
  assert.equal((await get(`c=${HELP}&root=${ROOT}`)).status, 404);
  assert.deepEqual(asked("openChannelFor"), []);
});

test("an older page names its cursor; a failed read is a retryable 200, never a 500", async () => {
  reset();
  const before = "2026-10-17T10:05:00.000Z";
  assert.equal((await get(`c=${HELP}&root=${ROOT}&before=${before}&beforeId=${REPLY}`)).status, 200);
  assert.deepEqual(asked("listThreadReplies"), [`listThreadReplies(${HELP}, ${ROOT}, ${JSON.stringify({ before, beforeId: REPLY })})`]);
  reset();
  state.fail = { read: "listThreadReplies", error: new Error("connection reset") };
  const original = console.error;
  console.error = () => {};
  try {
    const r = await get(`c=${HELP}&root=${ROOT}`);
    assert.deepEqual([r.status, r.body.ok], [200, false]);
    assert.match(r.body.error, /Couldn't load/);
    reset();
    state.fail = { read: "getMessageRow", error: Object.assign(new Error('relation "public.chat_threads" does not exist'), { code: "42P01" }) };
    const early = await get(`c=${HELP}&root=${ROOT}`);
    assert.deepEqual([early.status, early.body.error], [200, "Chat isn't set up yet."]);
  } finally {
    console.error = original;
  }
});
