import test from "node:test";
import assert from "node:assert/strict";
import * as nodeModule from "node:module";
import { pathToFileURL, fileURLToPath } from "node:url";
import path from "node:path";

// A chat message is sent once, however many times it's retried (0104):
// lib/chat-send.ts against an in-memory chat_messages that enforces
// unique (sender_id, client_id), and then the real sendMessage
// (app/chat/actions.ts) with doubles for everything around the insert — the
// lost-answer retry, the race (on the key, and into slow mode or the rate
// limit), the bells a replay asks for again, two messages meant twice, and a
// database from before 0104. Then the two reads beside it: searchPeople
// building a group's membership for the directory, and fetchDeletedMessages'
// stubs and cursor. Then threads (0110): a reply's Retry, where a reply may
// hang and what it may quote, its bells, "Ask the team" filing the thread's
// one help request, settling a #help question, and "Ask about this".

type Row = Record<string, any>;
const state = {
  messages: [] as Row[],
  /** Before 0104: the column isn't there. */
  columnMissing: false,
  /** The readiness probe fails for some other reason. */
  probeError: null as null | { code: string; message: string },
  /** A lookup that runs before the other request's row commits (the race). */
  hideNextLookup: false,
  /** The rate limiter's answer. */
  rateLimited: false,
  /** What happened, in order: the insert, the bells being asked for, the read cursor. */
  order: [] as string[],
  calls: [] as string[],
  me: "",
  channels: {} as Record<string, Row>,
  afters: [] as (() => Promise<void>)[],
  bells: [] as Row[],
  reads: 0,
  chat: {} as Record<string, (...a: any[]) => any>,
  /** What lib/chat.ts was asked: the reads' arguments. */
  asked: [] as unknown[][],
  /** Threads (0110): lib/chat-threads.ts, lib/chat-help.ts and lib/chat-about.ts doubles. */
  threads: {} as Record<string, any>,
  /** What notifyThreadReply was handed. */
  threadBells: [] as Row[],
  /** What notifyMany was handed (the "Ask the team" bells). */
  notified: [] as Row[],
};
let seq = 0;
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

function from(table: string) {
  let op = "select";
  let cols = "";
  let values: Row = {};
  let limit: number | null = null;
  const eqs: [string, unknown][] = [];
  const run = async (single: boolean) => {
    state.calls.push(`${op} ${table}${cols ? ` ${cols}` : ""}${eqs.length ? ` ${eqs.map(([k]) => k).join(",")}` : ""}`);
    if (table === "chat_reads") {
      state.reads++;
      state.order.push("read cursor");
      return { data: null, error: null };
    }
    assert.equal(table, "chat_messages");
    if (op === "insert") {
      if (state.columnMissing && "client_id" in values) {
        return { data: null, error: { code: "PGRST204", message: "Could not find the 'client_id' column of 'chat_messages' in the schema cache" } };
      }
      if (values.client_id && state.messages.some((m) => m.sender_id === values.sender_id && m.client_id === values.client_id)) {
        return { data: null, error: { code: "23505", message: 'duplicate key value violates unique constraint "chat_messages_sender_id_client_id_key"' } };
      }
      // Now, a millisecond apart: slow mode counts from it.
      const row = { id: uuid(++seq), created_at: new Date(Date.now() + seq).toISOString(), deleted_at: null, client_id: null, kind: "message", ...values };
      state.messages.push(row);
      state.order.push("insert");
      return { data: { id: row.id, created_at: row.created_at }, error: null };
    }
    if (state.columnMissing && (cols.includes("client_id") || eqs.some(([k]) => k === "client_id"))) {
      return { data: null, error: { code: "42703", message: "column chat_messages.client_id does not exist" } };
    }
    if (limit === 0) return state.probeError ? { data: null, error: state.probeError } : { data: [], error: null };
    if (state.hideNextLookup && eqs.some(([k]) => k === "client_id")) {
      state.hideNextLookup = false;
      return { data: null, error: null };
    }
    const hit = state.messages.filter((m) => eqs.every(([k, v]) => m[k] === v)).map((m) => ({ ...m }));
    return { data: single ? (hit[0] ?? null) : hit, error: null };
  };
  const chain: any = {
    select: (c: string) => ((cols = op === "select" ? c : cols), chain),
    insert: (v: Row) => ((op = "insert"), (values = v), chain),
    upsert: () => ((op = "upsert"), chain),
    eq: (k: string, v: unknown) => (eqs.push([k, v]), chain),
    limit: (n: number) => ((limit = n), chain),
    maybeSingle: () => run(true),
    single: () => run(true),
    then: (ok: any, ko: any) => run(false).then(ok, ko),
  };
  return chain;
}
(globalThis as any).__chatSend = { state, db: { from } };

// Everything app/chat/actions.ts imports from lib/chat.ts, each forwarded to
// a double the test sets (state.chat); one the send path doesn't touch throws.
const CHAT_EXPORTS = [
  "buildSidebar", "canReach", "canStartConversation", "filterReaders", "findDm", "getChannelForViewer", "getChatViewer",
  "getMessageRow", "getMessages", "getPeople", "getPerson", "isBlockedBetween", "lastSentAt", "listBlockedPeople",
  "listChannelReportParties", "listChannelSenderIds", "listDeletedForReport", "listMembers", "listModeratorIds",
  "countChannelReports", "membershipAllowed", "openChannelFor", "searchChannelPeople", "searchDirectory", "searchMessages",
];
const root = fileURLToPath(new URL("../", import.meta.url));
const fake = (source: string) => `data:text/javascript,${encodeURIComponent(source)}`;
(nodeModule as any).registerHooks({
  resolve(specifier: string, context: any, next: any) {
    const g = "const t=globalThis.__chatSend;";
    const doubles: Record<string, string> = {
      "server-only": "export {};",
      "next/server": g + "export const after=(fn)=>{t.state.afters.push(fn);t.state.order.push('bells asked for');};",
      "next/navigation": "export const unstable_rethrow=()=>{};",
      "@/lib/supabase/admin": g + "export const createAdminClient=()=>t.db;",
      "@/lib/server-guards": g + "export const requireActor=async()=>({userId:t.state.me,caps:null});",
      "@/lib/rate-limit": g + "export const checkRateLimit=async()=>({ok:!t.state.rateLimited});",
      "@/lib/notifications": g + "export const notifyMany=async(rows)=>{t.state.notified.push(...rows);};",
      "@/lib/audit": "export const logAudit=async()=>{};export const logAuditMany=async()=>{};",
      "@/lib/env": "export const env={safeguardingEmail:null};",
      "@/lib/chat": g + CHAT_EXPORTS.map((n) => `export const ${n}=(...a)=>t.state.chat.${n}(...a);`).join(""),
      "@/lib/chat-payload":
        "export const personalLocks=async()=>({muted:false,fined:false});export const buildChannelPayload=async()=>null;export const peopleIn=()=>[];",
      "@/lib/chat-notify":
        g +
        "export const chatLink=(id)=>'/chat?c='+id;export const clearChannelBells=async()=>0;export const clearChannelBellsMany=async()=>0;" +
        "export const notifyNewMessage=async(x)=>{t.state.bells.push(x);};" +
        "export const notifyThreadReply=async(x)=>{t.state.threadBells.push(x);};",
      "@/lib/chat-threads":
        g +
        "export const threadsReady=async()=>!!t.state.threads.ready;" +
        "export const changeQuestion=async(...a)=>t.state.threads.change(...a);" +
        "export const describeThread=async(...a)=>t.state.threads.describe(...a);" +
        "export const ensureThreadRow=async(...a)=>{t.state.threads.ensured.push(a);};" +
        "export const getThreadRow=async(id)=>t.state.threads.rows[id]??null;" +
        "export const setFollowState=async(...a)=>{t.state.threads.follows.push(a);};" +
        "export const setThreadAbout=async(...a)=>{t.state.threads.about.push(a);};" +
        "export const stampThreadSeen=async()=>0;",
      "@/lib/chat-help": g + "export const requestThreadHelp=async(x)=>t.state.threads.help(x);",
      "@/lib/chat-about": g + "export const aboutFor=async(r)=>t.state.threads.aboutFor(r);export const withAbout=async(m)=>m;",
      "@/lib/chat-files":
        "export const verifyChatUploads=async()=>({ok:true,attachments:[]});export const mintChatUploads=async()=>({ok:false,error:'no'});export const removeChannelFiles=async()=>{};",
      "@/app/chat/api/reads":
        g +
        "const no=async()=>{throw Error('not in this test')};export const currentReader=async()=>({userId:t.state.me,caps:null});" +
        "export const readAttention=no,readMembers=no,readMessages=no,readMessagesById=no,readPins=no,readSidebar=no;",
    };
    if (doubles[specifier]) return { url: fake(doubles[specifier]), shortCircuit: true };
    if (specifier.startsWith("@/")) return next(pathToFileURL(path.join(root, specifier.slice(2) + ".ts")).href, context);
    return next(specifier, context);
  },
});

const send = await import("./chat-send.ts");
const { fetchDeletedMessages, flagForTeam, followThread, searchPeople, sendMessage, setQuestion } = await import("../app/chat/actions.ts");

const ME = uuid(9001);
const YOU = uuid(9002);
const GENERAL = uuid(8001);
const HELP = uuid(8002);
const ID = "c1000000-0000-4000-8000-000000000001";

function textChannel(id: string, over: Row = {}): Row {
  return {
    id, kind: "channel", name: "general", topic: null, audience: "everyone", cohortId: null, teamId: null, posting: "everyone",
    slowmodeSeconds: 0, position: 0, systemKey: null, dmKey: null, createdBy: null, archivedAt: null, lastMessageAt: null,
    lastMessagePreview: null, lastSenderId: null, messageCount: 0, createdAt: "2026-10-01T00:00:00.000Z", ...over,
  };
}

/** The message as lib/chat.ts getMessages would read it back. */
const asMessage = (r: Row) => ({
  id: r.id, channelId: r.channel_id, senderId: r.sender_id, body: r.body, kind: r.kind, replyTo: null, mentions: r.mentions ?? [],
  mentionEveryone: !!r.mention_everyone, attachments: [], reactions: {}, createdAt: r.created_at, editedAt: null, pinnedAt: null,
  ...(r.client_id ? { clientId: r.client_id } : {}),
  ...(r.thread_root_id ? { threadRootId: r.thread_root_id } : {}),
});

function reset(over: { columnMissing?: boolean } = {}) {
  seq = 0;
  state.messages = [];
  state.columnMissing = !!over.columnMissing;
  state.probeError = null;
  state.hideNextLookup = false;
  state.rateLimited = false;
  state.order = [];
  state.calls = [];
  state.me = ME;
  state.afters = [];
  state.bells = [];
  state.reads = 0;
  state.asked = [];
  state.channels = { [GENERAL]: textChannel(GENERAL, { slowmodeSeconds: 30 }), [HELP]: textChannel(HELP, { name: "help" }) };
  state.chat = {
    getChatViewer: async (userId: string) => ({ userId, staff: false, vetted: true, cohortIds: [], teamIds: [], memberOf: [] }),
    getChannelForViewer: async (id: string) => (state.channels[id] ? { channel: state.channels[id], reported: false } : null),
    lastSentAt: async (cid: string, uid: string) =>
      state.messages.filter((m) => m.channel_id === cid && m.sender_id === uid).map((m) => m.created_at).sort().at(-1) ?? null,
    filterReaders: async () => [],
    getMessageRow: async () => null,
    getMessages: async (ids: string[]) => state.messages.filter((m) => ids.includes(m.id) && !m.deleted_at).map(asMessage),
  };
  state.threadBells = [];
  state.notified = [];
  state.threads = {
    ready: false,
    rows: {},
    ensured: [],
    follows: [],
    about: [],
    changed: [],
    helped: [],
    change: async (...a: unknown[]) => (state.threads.changed.push(a), true),
    describe: async (_v: unknown, _c: unknown, _ch: unknown, root: Row, row: Row | null) => ({
      rootId: root.id, question: row?.question ?? null, answerId: row?.answerId ?? null,
    }),
    help: async (x: Row) => (state.threads.helped.push(x), { ticketId: uuid(6001), reference: "B0-2345-6789", outcome: "created" }),
    aboutFor: async () => null,
  };
  send.resetClientIdState();
}

/** Run what after() was handed, as the response closing would. */
async function runAfters() {
  for (const fn of state.afters.splice(0)) await fn();
}

// ---------------------------------------------------------------------------
// lib/chat-send.ts
// ---------------------------------------------------------------------------

test("insertMessageOnce: a second insert with the same sender and client id hands back the first row", async () => {
  reset();
  const first = await send.insertMessageOnce({ channel_id: HELP, sender_id: ME, body: "here is my update" }, ID);
  assert.ok("inserted" in first);
  const again = await send.insertMessageOnce({ channel_id: HELP, sender_id: ME, body: "here is my update" }, ID);
  assert.ok("duplicate" in again);
  assert.equal(again.duplicate.id, first.inserted.id);
  assert.equal(state.messages.length, 1);
  // Scoped to the author: the same id from someone else is their own message.
  const theirs = await send.insertMessageOnce({ channel_id: HELP, sender_id: YOU, body: "here is my update" }, ID);
  assert.ok("inserted" in theirs);
  assert.equal(state.messages.length, 2);
  // findSentMessage only ever answers for the sender asked about.
  assert.equal((await send.findSentMessage(ME, ID))?.id, first.inserted.id);
  assert.equal((await send.findSentMessage(uuid(9003), ID)), null);
});

test("insertMessageOnce: without a client id every send is a new row, the same words included", async () => {
  reset();
  await send.insertMessageOnce({ channel_id: HELP, sender_id: ME, body: "ok" }, null);
  await send.insertMessageOnce({ channel_id: HELP, sender_id: ME, body: "ok" }, null);
  assert.equal(state.messages.length, 2);
  assert.ok(state.messages.every((m) => m.client_id === null));
});

test("before 0104: sends go in without the column, nothing replays, and the check runs once a minute", async () => {
  reset({ columnMissing: true });
  const a = await send.insertMessageOnce({ channel_id: HELP, sender_id: ME, body: "hi" }, ID);
  const b = await send.insertMessageOnce({ channel_id: HELP, sender_id: ME, body: "hi" }, ID);
  assert.ok("inserted" in a && "inserted" in b, "both go in, as before 0104");
  assert.equal(await send.findSentMessage(ME, ID), null);
  assert.equal(state.calls.filter((c) => c === "select chat_messages client_id").length, 1, "asked once, then remembered");
  assert.ok(state.messages.every((m) => !m.client_id), "no column, no id");
  // A minute on, 0104 has run: the next send asks again and carries the id.
  state.columnMissing = false;
  send.noteClientIdsMissing(Date.now() - 61_000);
  const c = await send.insertMessageOnce({ channel_id: HELP, sender_id: ME, body: "hi" }, ID);
  assert.ok("inserted" in c);
  assert.equal(state.messages.at(-1)!.client_id, ID);
});

test("a check that fails for another reason goes without ids this once, and asks again next time", async () => {
  reset();
  state.probeError = { code: "57014", message: "canceling statement due to statement timeout" };
  assert.equal(await send.clientIdsReady(), false);
  state.probeError = null;
  assert.equal(await send.clientIdsReady(), true, "a blip doesn't turn client ids off for a minute");
  assert.equal(state.calls.filter((c) => c === "select chat_messages client_id").length, 2);
  assert.equal(await send.clientIdsReady(), true);
  assert.equal(state.calls.filter((c) => c === "select chat_messages client_id").length, 2, "ready stays ready");
});

// ---------------------------------------------------------------------------
// sendMessage (app/chat/actions.ts)
// ---------------------------------------------------------------------------

test("a retry after a lost answer returns the original message, even in slow mode, and posts nothing new", async () => {
  reset();
  const first = await sendMessage({ channelId: GENERAL, body: "here is my update", clientId: ID });
  assert.equal(first.ok, true);
  // The answer never reached the phone; Retry sends the same message again,
  // inside #general's 30-second slow mode, which the first send just started.
  const retry = await sendMessage({ channelId: GENERAL, body: "here is my update", clientId: ID });
  assert.equal(retry.ok, true, retry.ok ? "" : retry.error);
  assert.equal(state.messages.length, 1);
  assert.equal(retry.ok && retry.data?.message.id, first.ok && first.data?.message.id);
  assert.equal(retry.ok && retry.data?.message.clientId, ID, "the server copy carries the id the screen matches its bubble by");
  assert.equal(state.reads, 1, "the read cursor moved once");
  // The replay asks for the message's bells again, in case the first request
  // died before ringing them: the same message, and its posting time, so
  // notifyNewMessage's dedupe key and read-cursor check make it nobody's
  // second bell (lib/chat-server.test.ts holds that side).
  await runAfters();
  assert.deepEqual(
    state.bells.map((b) => [b.messageId, b.postedAt ?? null]),
    [[state.messages[0].id, null], [state.messages[0].id, state.messages[0].created_at]],
  );
  // A new message (its own id) is still held to slow mode.
  const next = await sendMessage({ channelId: GENERAL, body: "here is my update", clientId: "c1000000-0000-4000-8000-000000000002" });
  assert.equal(next.ok, false);
  assert.match(next.ok ? "" : next.error, /Slow mode is on/);
});

test("the same message sent twice at once ends on one row, and every ask for bells is for that row", async () => {
  reset();
  await sendMessage({ channelId: HELP, body: "racing", clientId: ID });
  // The second request looked before the first committed, then lost on the key.
  state.hideNextLookup = true;
  const second = await sendMessage({ channelId: HELP, body: "racing", clientId: ID });
  assert.equal(second.ok, true, second.ok ? "" : second.error);
  assert.equal(state.messages.length, 1);
  assert.equal(second.ok && second.data?.message.id, state.messages[0].id);
  assert.equal(state.reads, 1);
  await runAfters();
  assert.ok(state.bells.every((b) => b.messageId === state.messages[0].id), "both asks are for the one message, deduped per person");
});

test("a Retry that looked before the first send committed, then hit slow mode, gets the original back", async () => {
  reset();
  // The first send is in #general (30-second slow mode) and commits while
  // the Retry is between its replay check and slow mode's clock.
  const first = await sendMessage({ channelId: GENERAL, body: "here is my update", clientId: ID });
  assert.equal(first.ok, true);
  state.hideNextLookup = true;
  const retry = await sendMessage({ channelId: GENERAL, body: "here is my update", clientId: ID });
  assert.equal(retry.ok, true, retry.ok ? "" : retry.error);
  assert.equal(retry.ok && retry.data?.message.id, first.ok && first.data?.message.id);
  assert.equal(state.messages.length, 1);
  // Without a client id there's nothing to settle by: slow mode says no, as before.
  const plain = await sendMessage({ channelId: GENERAL, body: "here is my update" });
  assert.equal(plain.ok, false);
  assert.match(plain.ok ? "" : plain.error, /Slow mode is on/);
});

test("the same race into the rate limit: the message is there, so it's that message", async () => {
  reset();
  const first = await sendMessage({ channelId: HELP, body: "racing", clientId: ID });
  state.hideNextLookup = true;
  state.rateLimited = true;
  const retry = await sendMessage({ channelId: HELP, body: "racing", clientId: ID });
  assert.equal(retry.ok, true, retry.ok ? "" : retry.error);
  assert.equal(retry.ok && retry.data?.message.id, first.ok && first.data?.message.id);
  // A new message the limit refuses is still refused, and nothing went in.
  const fresh = await sendMessage({ channelId: HELP, body: "one more", clientId: "c1000000-0000-4000-8000-000000000003" });
  assert.equal(fresh.ok, false);
  assert.match(fresh.ok ? "" : fresh.error, /Slow down/);
  assert.equal(state.messages.length, 1);
});

test("a message's bells are asked for the moment its row exists, before anything else is awaited", async () => {
  reset();
  const res = await sendMessage({ channelId: HELP, body: "hello", clientId: ID });
  assert.equal(res.ok, true);
  // after() runs even if the request fails from here on, so a message that
  // went in is never one nobody hears about.
  assert.deepEqual(state.order, ["insert", "bells asked for", "read cursor"]);
});

test("two messages meant twice, word for word, are two messages", async () => {
  reset();
  const a = await sendMessage({ channelId: HELP, body: "ok", clientId: "c1000000-0000-4000-8000-0000000000a1" });
  const b = await sendMessage({ channelId: HELP, body: "ok", clientId: "c1000000-0000-4000-8000-0000000000a2" });
  assert.ok(a.ok && b.ok);
  assert.equal(state.messages.length, 2);
  assert.notEqual(a.ok && a.data?.message.id, b.ok && b.data?.message.id);
});

test("a resend only ever returns the message where it was sent, while it's there", async () => {
  reset();
  await sendMessage({ channelId: HELP, body: "in help", clientId: ID });
  const elsewhere = await sendMessage({ channelId: GENERAL, body: "in help", clientId: ID });
  assert.equal(elsewhere.ok, false);
  assert.match(elsewhere.ok ? "" : elsewhere.error, /already sent in another conversation/);
  // Deleted since (by its sender in another tab, or a moderator): said so,
  // never posted again.
  state.messages[0].deleted_at = "2026-10-17T10:05:00.000Z";
  const gone = await sendMessage({ channelId: HELP, body: "in help", clientId: ID });
  assert.equal(gone.ok, false);
  assert.match(gone.ok ? "" : gone.error, /deleted since/);
  // Lost access to the channel meanwhile: the same answer as any channel you can't read.
  state.messages[0].deleted_at = null;
  delete state.channels[HELP];
  const locked = await sendMessage({ channelId: HELP, body: "in help", clientId: ID });
  assert.equal(locked.ok, false);
  assert.equal(state.messages.length, 1);
});

test("before 0104 a send still works, with or without a client id", async () => {
  reset({ columnMissing: true });
  const res = await sendMessage({ channelId: HELP, body: "hello", clientId: ID });
  assert.equal(res.ok, true, res.ok ? "" : res.error);
  const plain = await sendMessage({ channelId: HELP, body: "hello again" });
  assert.equal(plain.ok, true);
  assert.equal(state.messages.length, 2);
  assert.ok(state.messages.every((m) => !m.client_id));
  // A malformed id is no id at all, never an error.
  const odd = await sendMessage({ channelId: HELP, body: "third", clientId: "not-a-uuid" });
  assert.equal(odd.ok, true);
});

// ---------------------------------------------------------------------------
// searchPeople and fetchDeletedMessages
// ---------------------------------------------------------------------------

const GROUP = uuid(8100);
const STRANGERS = uuid(8101);
const STAFFER = uuid(9100);
const MENTOR = uuid(9101);

function directoryDoubles() {
  state.channels[GROUP] = textChannel(GROUP, { kind: "group", audience: "members", name: null });
  state.channels[STRANGERS] = textChannel(STRANGERS, { kind: "group", audience: "members", name: null });
  state.chat.getChatViewer = async (userId: string) => ({ userId, staff: false, vetted: true, cohortIds: [], teamIds: [], memberOf: [GROUP] });
  state.chat.listMembers = async (ids: string[]) => new Map(ids.map((cid) => [cid, cid === GROUP ? [ME, STAFFER] : [YOU, STAFFER]]));
  state.chat.searchDirectory = async (...a: unknown[]) => (state.asked.push(a), { people: [], withheld: false });
}

test("searchPeople: a DM search, a new group's picks, and an existing group's members as the directory's group", async () => {
  reset();
  directoryDoubles();
  await searchPeople("sam");
  assert.equal(state.asked.at(-1)![3], null, "no group: the DM rule");
  await searchPeople("sam", { withIds: [STAFFER, STAFFER.toUpperCase(), "nonsense", MENTOR] });
  assert.deepEqual(state.asked.at(-1)![3], [STAFFER, MENTOR], "picks, once each, real ids only");
  await searchPeople("sam", { channelId: GROUP, withIds: [MENTOR] });
  assert.deepEqual(state.asked.at(-1)![3], [ME, STAFFER, MENTOR], "the group's members, then the picks");
  assert.equal(String(state.asked.at(-1)![0]), "sam");
});

test("searchPeople: a group the viewer isn't in lends its members to nobody's search", async () => {
  reset();
  directoryDoubles();
  await assert.rejects(searchPeople("sam", { channelId: STRANGERS }), /isn't available/);
  await assert.rejects(searchPeople("sam", { channelId: HELP }), /isn't available/, "a text channel isn't a group");
  assert.equal(state.asked.length, 0);
});

test("fetchDeletedMessages: stubs for a channel the viewer reads, with names; nothing for one they don't", async () => {
  reset();
  const stub = { id: uuid(7001), senderId: YOU, createdAt: "2026-10-17T09:00:00.000Z", deletedAt: "2026-10-17T09:05:00.000Z" };
  state.chat.openChannelFor = async (id: string) => (state.channels[id] ? { channel: state.channels[id], reported: false, viewer: {} } : null);
  state.chat.listDeletedForReport = async (...a: unknown[]) => (state.asked.push(a), { messages: [stub], hasMore: true });
  state.chat.getPeople = async (ids: string[]) => new Map(ids.map((i) => [i, { id: i, name: "You There" }]));
  const res = await fetchDeletedMessages(HELP);
  assert.deepEqual(res.messages, [stub]);
  assert.equal(res.hasMore, true, "a pile of deletes pages on rather than ending the list");
  assert.deepEqual(res.people, { [YOU]: { id: YOU, name: "You There" } });
  assert.equal(state.asked[0][1], ME, "never the viewer's own: they're asked who's looking");
  assert.deepEqual(state.asked[0][2], { before: null });
  // The next page starts after the last stub shown; a cursor that isn't one is no cursor.
  await fetchDeletedMessages(HELP, { deletedAt: stub.deletedAt, id: stub.id.toUpperCase() });
  assert.deepEqual(state.asked[1][2], { before: { deletedAt: stub.deletedAt, id: stub.id } });
  await fetchDeletedMessages(HELP, { deletedAt: stub.deletedAt, id: "nope" } as never);
  assert.deepEqual(state.asked[2][2], { before: null });
  await assert.rejects(fetchDeletedMessages(uuid(8999)), /isn't available/);
});

// ---------------------------------------------------------------------------
// Threads and #help's questions (0110)
// ---------------------------------------------------------------------------

const ROOT = uuid(7101);
const ELSEWHERE = uuid(7102);
const REPLY = uuid(7103);
const OTHER_REPLY = uuid(7104);

/** #help holds a question (ROOT, by YOU) with one reply; #general a message of its own. */
function threadDoubles() {
  state.threads.ready = true;
  state.channels[HELP].systemKey = "help";
  const row = (id: string, channel: string, sender: string, body: string, root: string | null = null, over: Row = {}) => ({
    id, channel_id: channel, sender_id: sender, body, kind: "message", created_at: "2026-10-17T09:00:00.000Z",
    deleted_at: null, client_id: null, thread_root_id: root, ...over,
  });
  state.messages.push(
    row(ROOT, HELP, YOU, "How do I find interviewees?"),
    row(ELSEWHERE, GENERAL, YOU, "Anyone around?"),
    row(REPLY, HELP, STAFFER, "Start with clubs", ROOT),
    row(OTHER_REPLY, GENERAL, STAFFER, "Here", ELSEWHERE),
  );
  state.chat.getMessageRow = async (id: string) => state.messages.find((m) => m.id === id) ?? null;
  state.chat.listModeratorIds = async () => [STAFFER];
  state.chat.getPerson = async (id: string) => ({ id, name: "Ava Patel" });
}

const NEW_ID = (n: number) => `d1000000-0000-4000-8000-00000000${String(n).padStart(4, "0")}`;

test("a thread reply is sent once: a Retry after a lost answer is the same reply, and asks its thread's bells again, never the channel's", async () => {
  reset();
  threadDoubles();
  const before = state.messages.length;
  const first = await sendMessage({ channelId: HELP, body: "Try the robotics club", clientId: ID, threadRootId: ROOT });
  assert.equal(first.ok, true, first.ok ? "" : first.error);
  assert.equal(first.ok && first.data?.message.threadRootId, ROOT);
  const retry = await sendMessage({ channelId: HELP, body: "Try the robotics club", clientId: ID, threadRootId: ROOT });
  assert.equal(retry.ok, true, retry.ok ? "" : retry.error);
  assert.equal(retry.ok && retry.data?.message.id, first.ok && first.data?.message.id);
  assert.equal(state.messages.length, before + 1, "one reply, however often it's retried");
  await runAfters();
  const reply = state.messages.at(-1)!;
  assert.equal(state.bells.length, 0, "a thread reply rings no channel bells (no 'All messages' cohort)");
  assert.deepEqual(
    state.threadBells.map((b) => [b.rootId, b.messageId, b.postedAt ?? null]),
    [[ROOT, reply.id, null], [ROOT, reply.id, reply.created_at]],
  );
  assert.equal(state.reads, 0, "a reply isn't in the feed, so it moves no channel read cursor");
  // The same id claimed for the feed, or for another thread: refused, nothing new posted.
  const asFeed = await sendMessage({ channelId: HELP, body: "Try the robotics club", clientId: ID });
  assert.equal(asFeed.ok, false);
  assert.match(asFeed.ok ? "" : asFeed.error, /already sent in another conversation/);
  assert.equal(state.messages.length, before + 1);
  // Two replies meant twice, word for word, are two replies.
  const again = await sendMessage({ channelId: HELP, body: "Try the robotics club", clientId: NEW_ID(1), threadRootId: ROOT });
  assert.equal(again.ok, true);
  assert.equal(state.messages.length, before + 2);
});

test("where a reply may hang: a live feed message in its own channel, one level deep; what it may quote; never @everyone", async () => {
  reset();
  threadDoubles();
  const refused = async (input: Parameters<typeof sendMessage>[0], why: RegExp) => {
    const res = await sendMessage(input);
    assert.equal(res.ok, false, `expected a refusal for ${JSON.stringify(input)}`);
    assert.match(res.ok ? "" : res.error, why);
  };
  const n = state.messages.length;
  await refused({ channelId: HELP, body: "x", threadRootId: ELSEWHERE }, /started this thread is gone/);
  await refused({ channelId: HELP, body: "x", threadRootId: REPLY }, /one level deep/);
  await refused({ channelId: HELP, body: "x", threadRootId: "not-a-uuid" }, /gone/);
  state.messages.find((m) => m.id === ROOT)!.deleted_at = "2026-10-17T09:30:00.000Z";
  await refused({ channelId: HELP, body: "x", threadRootId: ROOT }, /gone/);
  state.messages.find((m) => m.id === ROOT)!.deleted_at = null;
  state.messages.push({ id: uuid(7105), channel_id: HELP, sender_id: null, body: "Rish pinned a message.", kind: "system", created_at: "2026-10-17T09:01:00.000Z", deleted_at: null, thread_root_id: null });
  await refused({ channelId: HELP, body: "x", threadRootId: uuid(7105) }, /can't take replies/);
  // Quotes: inside a thread, the thread; in the feed, the feed.
  state.messages.push({ id: uuid(7106), channel_id: HELP, sender_id: YOU, body: "another feed message", kind: "message", created_at: "2026-10-17T09:02:00.000Z", deleted_at: null, thread_root_id: null });
  await refused({ channelId: HELP, body: "x", threadRootId: ROOT, replyToId: uuid(7106) }, /only quote a message from this thread/);
  await refused({ channelId: HELP, body: "x", replyToId: REPLY }, /in a thread\. Reply to it there/);
  assert.equal(state.messages.length, n + 2, "nothing was posted (the two rows are the fixtures added above)");
  const quoted = await sendMessage({ channelId: HELP, body: "agreed", threadRootId: ROOT, replyToId: REPLY });
  assert.equal(quoted.ok, true, quoted.ok ? "" : quoted.error);
  // A reply never pings everyone, even from the team.
  state.chat.getChatViewer = async (userId: string) => ({ userId, staff: true, vetted: true, cohortIds: [], teamIds: [], memberOf: [] });
  const loud = await sendMessage({ channelId: HELP, body: "@everyone read this", threadRootId: ROOT });
  assert.equal(loud.ok, true, loud.ok ? "" : loud.error);
  assert.equal(state.messages.at(-1)!.mention_everyone, false);
  // Before 0110 there are no threads to reply in.
  state.threads.ready = false;
  await refused({ channelId: HELP, body: "x", threadRootId: ROOT }, /aren't switched on yet/);
});

test("Ask the team files the thread's one help request (the reply's root, not the reply), and the team still gets the bell", async () => {
  reset();
  threadDoubles();
  const res = await flagForTeam(REPLY, "  stuck   on the outreach   message ");
  assert.equal(res.ok, true, res.ok ? "" : res.error);
  assert.deepEqual(res.ok && res.data, { reference: "B0-2345-6789", outcome: "created" });
  assert.equal(state.threads.helped.length, 1);
  const asked = state.threads.helped[0];
  assert.deepEqual([asked.rootId, asked.messageId, asked.askerId, asked.note], [ROOT, REPLY, ME, "stuck on the outreach message"]);
  assert.deepEqual(
    state.notified.map((b) => [b.userId, b.type, b.link]),
    [[STAFFER, "chat_flagged", `/chat?c=${HELP}&m=${REPLY}`]],
    "the bell opens the reply, in its thread",
  );
  // The thread's request already exists: the same ticket, joined.
  state.threads.help = async (x: Row) => (state.threads.helped.push(x), { ticketId: uuid(6001), reference: "B0-2345-6789", outcome: "linked" });
  const again = await flagForTeam(ROOT, "");
  assert.deepEqual(again.ok && again.data, { reference: "B0-2345-6789", outcome: "linked" });
  assert.equal(state.threads.helped.at(-1)!.rootId, ROOT, "a feed message is its own thread's root");
  // A ticket that couldn't be filed doesn't silence the team: the bell goes, and the screen isn't told of a request.
  state.notified = [];
  state.threads.help = async () => {
    throw new Error("support is down");
  };
  const down = await flagForTeam(ROOT, "help");
  assert.equal(down.ok, true);
  assert.deepEqual(down.ok && down.data, { reference: null, outcome: null });
  assert.equal(state.notified.length, 1);
  // Before 0110: the bell alone, as it was.
  state.threads.ready = false;
  const helped = state.threads.helped.length;
  const old = await flagForTeam(ROOT, "help");
  assert.equal(old.ok, true);
  assert.equal(state.threads.helped.length, helped);
});

test("settling a #help question: only its asker or the team, an answer from its own thread, never over someone else's change", async () => {
  reset();
  threadDoubles();
  state.threads.rows[ROOT] = { question: "open", answerId: null };
  const open = { question: "open" as const, answerId: null };
  // ME neither asked it nor runs chat.
  const stranger = await setQuestion({ rootId: ROOT, action: "mark_answered", expect: open });
  assert.equal(stranger.ok, false);
  assert.match(stranger.ok ? "" : stranger.error, /Only the person who asked, or the batch0 team/);
  // The asker accepts a reply — from another thread first, which isn't one.
  state.me = YOU;
  const wrong = await setQuestion({ rootId: ROOT, action: "accept", answerId: OTHER_REPLY, expect: open });
  assert.equal(wrong.ok, false);
  assert.match(wrong.ok ? "" : wrong.error, /That reply is gone/);
  const accepted = await setQuestion({ rootId: ROOT, action: "accept", answerId: REPLY, expect: open });
  assert.equal(accepted.ok, true, accepted.ok ? "" : accepted.error);
  assert.deepEqual(state.threads.changed.at(-1), [ROOT, open, { question: "answered", answerId: REPLY }, YOU]);
  // Someone reopened it meanwhile: the screen's picture is stale, nothing moves.
  state.threads.rows[ROOT] = { question: "open", answerId: null };
  const changes = state.threads.changed.length;
  const stale = await setQuestion({ rootId: ROOT, action: "reopen", expect: { question: "answered", answerId: REPLY } });
  assert.equal(stale.ok, false);
  assert.match(stale.ok ? "" : stale.error, /changed this question just now/);
  // …or it moved between the read and the write (the conditional update lost).
  state.threads.change = async () => false;
  const raced = await setQuestion({ rootId: ROOT, action: "mark_answered", expect: open });
  assert.equal(raced.ok, false);
  assert.match(raced.ok ? "" : raced.error, /changed this question just now/);
  assert.equal(state.threads.changed.length, changes);
  // A transition the state already reflects is refused, not logged twice.
  state.threads.change = async (...a: unknown[]) => (state.threads.changed.push(a), true);
  const twice = await setQuestion({ rootId: ROOT, action: "reopen", expect: open });
  assert.equal(twice.ok, false);
  assert.match(twice.ok ? "" : twice.error, /already open/);
  // The team may settle anyone's question; outside #help there are none.
  state.me = ME;
  state.chat.getChatViewer = async (userId: string) => ({ userId, staff: true, vetted: true, cohortIds: [], teamIds: [], memberOf: [] });
  const staff = await setQuestion({ rootId: ROOT, action: "unmark", expect: open });
  assert.equal(staff.ok, true, staff.ok ? "" : staff.error);
  const general = await setQuestion({ rootId: ELSEWHERE, action: "ask" });
  assert.equal(general.ok, false);
  assert.match(general.ok ? "" : general.error, /Questions live in #help/);
});

test("Follow and unfollow a thread; a reply or a DM is no thread to follow", async () => {
  reset();
  threadDoubles();
  assert.equal((await followThread(ROOT, false)).ok, true);
  assert.equal((await followThread(ROOT, true)).ok, true);
  assert.deepEqual(state.threads.follows.map((f: unknown[]) => [f[0], f[1], f[2]]), [[ROOT, ME, "muted"], [ROOT, ME, "following"]]);
  const reply = await followThread(REPLY, true);
  assert.equal(reply.ok, false);
  state.channels[uuid(8200)] = textChannel(uuid(8200), { kind: "dm", audience: "members", name: null });
  state.messages.push({ id: uuid(7200), channel_id: uuid(8200), sender_id: YOU, body: "hi", kind: "message", created_at: "2026-10-17T09:00:00.000Z", deleted_at: null, thread_root_id: null });
  const dm = await followThread(uuid(7200), true);
  assert.equal(dm.ok, false);
  assert.equal(state.threads.follows.length, 2);
});

test("Ask about this: linked only to an item the sender can open, on a new top-level message; before 0110 the message goes without it", async () => {
  reset();
  threadDoubles();
  const LESSON = uuid(5001);
  const n = state.messages.length;
  const cannot = await sendMessage({ channelId: HELP, body: "What does slide 4 mean?", clientId: NEW_ID(2), about: `lesson:${LESSON}` });
  assert.equal(cannot.ok, false);
  assert.match(cannot.ok ? "" : cannot.error, /only link a lesson or assignment you can open/);
  const junk = await sendMessage({ channelId: HELP, body: "What does slide 4 mean?", clientId: NEW_ID(3), about: "lesson:../../etc" });
  assert.equal(junk.ok, false);
  assert.equal(state.messages.length, n, "nothing posted when the link is refused");
  state.threads.aboutFor = async (r: Row) => ({ kind: r.kind, id: r.id, title: "Week 2 · Customer interviews", href: `/dashboard/course/${r.id}` });
  const ok = await sendMessage({ channelId: HELP, body: "What does slide 4 mean?", clientId: NEW_ID(4), about: `lesson:${LESSON}` });
  assert.equal(ok.ok, true, ok.ok ? "" : ok.error);
  assert.deepEqual(state.threads.about, [[state.messages.at(-1)!.id, HELP, { kind: "lesson", id: LESSON }]]);
  // A reply in a thread carries no link of its own.
  await sendMessage({ channelId: HELP, body: "same question", threadRootId: ROOT, about: `lesson:${LESSON}` });
  assert.equal(state.threads.about.length, 1);
  // Before 0110 the link has nowhere to go: the message is sent without it.
  state.threads.ready = false;
  const old = await sendMessage({ channelId: HELP, body: "still asking", about: `lesson:${LESSON}` });
  assert.equal(old.ok, true);
  assert.equal(state.threads.about.length, 1);
});
