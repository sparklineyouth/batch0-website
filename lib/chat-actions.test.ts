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
// stubs and cursor.

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
      "@/lib/notifications": "export const notifyMany=async()=>{};",
      "@/lib/audit": "export const logAudit=async()=>{};export const logAuditMany=async()=>{};",
      "@/lib/env": "export const env={safeguardingEmail:null};",
      "@/lib/chat": g + CHAT_EXPORTS.map((n) => `export const ${n}=(...a)=>t.state.chat.${n}(...a);`).join(""),
      "@/lib/chat-payload":
        "export const personalLocks=async()=>({muted:false,fined:false});export const buildChannelPayload=async()=>null;export const peopleIn=()=>[];",
      "@/lib/chat-notify":
        g +
        "export const chatLink=(id)=>'/chat?c='+id;export const clearChannelBells=async()=>0;export const clearChannelBellsMany=async()=>0;" +
        "export const notifyNewMessage=async(x)=>{t.state.bells.push(x);};",
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
const { fetchDeletedMessages, searchPeople, sendMessage } = await import("../app/chat/actions.ts");

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
