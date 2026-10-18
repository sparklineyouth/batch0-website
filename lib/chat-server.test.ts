import test from "node:test";
import assert from "node:assert/strict";
import * as nodeModule from "node:module";
import { pathToFileURL, fileURLToPath } from "node:url";
import path from "node:path";

// The real lib/chat.ts and lib/chat-notify.ts against an in-memory database:
// mention search past the first page of name matches, the sidebar and badge
// under "Only @mentions", "Mark all read" clearing bells in chunks, the
// directory for a group as against a DM, and the body-free stubs "report a
// deleted message" lists.

type Row = Record<string, any>;
const state: {
  tables: Record<string, Row[]>;
  unread: { channel_id: string; unread: number; mentions: number }[];
  log: string[];
  /** The columns each read asked for: "<table>: <columns>". */
  selected: string[];
  inFlight: number;
  peak: number;
  fail: (table: string, op: string, call: number) => string | null;
  calls: number;
} = { tables: {}, unread: [], log: [], selected: [], inFlight: 0, peak: 0, fail: () => null, calls: 0 };

const likeToRegExp = (pattern: string) =>
  new RegExp(`^${pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/%/g, ".*").replace(/_/g, ".")}$`, "is");

/** Just enough of supabase-js over PostgREST for these reads and writes. */
function from(table: string) {
  const filters: ((r: Row) => boolean)[] = [];
  const said: string[] = [];
  const sorts: [string, boolean][] = [];
  let op = "select";
  let patch: Row = {};
  let window: [number, number] | null = null;
  let cap: number | null = null;
  const run = async () => {
    state.inFlight++;
    state.peak = Math.max(state.peak, state.inFlight);
    await new Promise((r) => setTimeout(r, 1));
    state.inFlight--;
    const fault = state.fail(table, op, ++state.calls);
    if (fault) return { data: null, error: { message: fault } };
    state.log.push(`${op} ${table}${said.length ? " " + said.join(" ") : ""}`);
    const rows = state.tables[table] ?? [];
    let hit = rows.filter((r) => filters.every((f) => f(r)));
    if (op === "update") {
      for (const r of hit) Object.assign(r, patch);
      return { data: hit.map((r) => ({ id: r.id })), error: null };
    }
    if (sorts.length) {
      hit = [...hit].sort((a, b) => {
        for (const [c, up] of sorts) if (a[c] !== b[c]) return (String(a[c]) < String(b[c]) ? -1 : 1) * (up ? 1 : -1);
        return 0;
      });
    }
    if (window) hit = hit.slice(window[0], window[1] + 1);
    if (cap !== null) hit = hit.slice(0, cap);
    return { data: hit.map((r) => ({ ...r })), error: null };
  };
  // `a.eq.x,b.eq.y`: the only shape these reads hand .or() (the block lookups).
  const anyOf = (expr: string) => {
    const parts = expr.split(",").map((p) => p.split("."));
    return (r: Row) => parts.some(([c, o, v]) => o === "eq" && r[c] === v);
  };
  const chain: any = {
    select: (cols?: string) => (cols && state.selected.push(`${table}: ${cols}`), chain),
    update: (p: Row) => ((op = "update"), (patch = p), chain),
    eq: (c: string, v: unknown) => (filters.push((r) => r[c] === v), said.push(`${c}=${v}`), chain),
    in: (c: string, vs: unknown[]) => (filters.push((r) => vs.includes(r[c])), said.push(`${c}:${vs.length}`), chain),
    is: (c: string, v: unknown) => (filters.push((r) => (r[c] ?? null) === v), said.push(`${c} is ${v}`), chain),
    ilike: (c: string, p: string) => {
      const re = likeToRegExp(p);
      filters.push((r) => typeof r[c] === "string" && re.test(r[c]));
      said.push(`${c}~${p}`);
      return chain;
    },
    neq: (c: string, v: unknown) => (filters.push((r) => r[c] !== v), said.push(`${c}!=${v}`), chain),
    gte: (c: string, v: string) => (filters.push((r) => r[c] != null && String(r[c]) >= v), said.push(`${c}>=`), chain),
    not: (c: string, o: string, v: unknown) => {
      assert.equal(`${o} ${v}`, "is null");
      filters.push((r) => (r[c] ?? null) !== null);
      said.push(`${c} not null`);
      return chain;
    },
    or: (expr: string) => (filters.push(anyOf(expr)), chain),
    order: (c: string, o?: { ascending?: boolean }) => (sorts.push([c, o?.ascending !== false]), chain),
    range: (a: number, b: number) => ((window = [a, b]), chain),
    limit: (n: number) => ((cap = n), chain),
    then: (ok: any, ko: any) => run().then(ok, ko),
  };
  return chain;
}
const db = {
  from,
  rpc: async (name: string, args: { p_uid: string; p_channel_ids: string[] }) => {
    assert.equal(name, "chat_unread");
    return { data: state.unread.filter((r) => args.p_channel_ids.includes(r.channel_id)), error: null };
  },
};
(globalThis as any).__chatServer = { state, db };

const root = fileURLToPath(new URL("../", import.meta.url));
const fake = (source: string) => `data:text/javascript,${encodeURIComponent(source)}`;
(nodeModule as any).registerHooks({
  resolve(specifier: string, context: any, next: any) {
    const g = "const t=globalThis.__chatServer;";
    const doubles: Record<string, string> = {
      "server-only": "export {};",
      "@/lib/supabase/admin": g + "export const createAdminClient=()=>t.db;",
      "@/lib/roles":
        "export const getAllRoles=async()=>[{slug:'student',label:'Student',color:null,permissions:[]},{slug:'admin',label:'Admin',color:'red',permissions:['*']}];",
      "@/lib/notifications": "export const notifyMany=async()=>{};",
    };
    if (doubles[specifier]) return { url: fake(doubles[specifier]), shortCircuit: true };
    if (specifier.startsWith("@/")) return next(pathToFileURL(path.join(root, specifier.slice(2) + ".ts")).href, context);
    return next(specifier, context);
  },
});
const chat = await import("./chat.ts");
const { clearChannelBellsMany, CHAT_BELL_TYPES } = await import("./chat-notify.ts");

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ME = id(1);

function reset(tables: Record<string, Row[]>) {
  state.tables = tables;
  state.unread = [];
  state.log = [];
  state.selected = [];
  state.peak = 0;
  state.calls = 0;
  state.fail = () => null;
}

const channelRow = (n: number, kind: string, extra: Row = {}): Row => ({
  id: id(n), kind, name: null, topic: null, audience: "members", cohort_id: null, team_id: null, posting: "everyone",
  slowmode_seconds: 0, position: 0, system_key: null, dm_key: null, created_by: ME, archived_at: null,
  last_message_at: "2026-10-15T12:00:00.000Z", last_message_preview: "hi", last_sender_id: id(2), message_count: 3,
  created_at: "2026-10-01T00:00:00.000Z", ...extra,
});

test("mention search finds a name that starts with the query behind hundreds that only contain it", async () => {
  const CH = channelRow(500, "channel", { name: "fall-2026" });
  const profiles: Row[] = [];
  const members: Row[] = [];
  // 300 readers named "Amara …", all of them alphabetically before "Maya".
  for (let i = 0; i < 300; i++) profiles.push({ id: id(1000 + i), full_name: `Amara ${String(i).padStart(4, "0")}`, role: "student" });
  profiles.push({ id: id(2000), full_name: "Maya Chen", role: "student" });
  profiles.push({ id: id(2001), full_name: "Zed Mayfield", role: "student" });
  profiles.push({ id: id(2002), full_name: "Mara Elsewhere", role: "student" }); // starts with it, can't read the channel
  for (const p of profiles) if (p.full_name !== "Mara Elsewhere") members.push({ channel_id: CH.id, user_id: p.id });
  reset({ profiles, chat_members: members });

  const found = await chat.searchChannelPeople(chat.toChannel(CH), "ma");
  assert.deepEqual(
    found.map((p) => p.name),
    ["Maya Chen", "Zed Mayfield", "Amara 0000", "Amara 0001", "Amara 0002", "Amara 0003", "Amara 0004", "Amara 0005"],
    "starts with it, then a word that does, then the rest; never someone who can't read it",
  );
  assert.deepEqual(
    state.log.filter((l) => l.startsWith("select profiles full_name~")),
    ["select profiles full_name~ma%", "select profiles full_name~% ma%", "select profiles full_name~%ma%"],
  );

  reset({ profiles, chat_members: members });
  assert.deepEqual((await chat.searchChannelPeople(chat.toChannel(CH), "mayf")).map((p) => p.name), ["Zed Mayfield"]);
  reset({ profiles, chat_members: members });
  assert.equal((await chat.searchChannelPeople(chat.toChannel(CH), "amara")).length, 8, "eight at most");
});

test("a DM or group on 'Only @mentions' shows no pill and no badge until someone mentions you", async () => {
  const QUIET = channelRow(600, "group");
  const PINGED = channelRow(601, "group");
  const DM = channelRow(602, "dm", { dm_key: `${ME}:${id(2)}` });
  const CHATTY = channelRow(603, "group");
  const groups = [QUIET, PINGED, CHATTY];
  reset({
    chat_channels: [...groups, DM],
    chat_members: groups.flatMap((g) => [ME, id(2), id(3)].map((u) => ({ channel_id: g.id, user_id: u }))),
    chat_reads: [
      { channel_id: QUIET.id, user_id: ME, last_read_at: "epoch", seen_at: null, notify: "mentions", hidden_at: null },
      { channel_id: PINGED.id, user_id: ME, last_read_at: "epoch", seen_at: null, notify: "mentions", hidden_at: null },
    ],
    chat_blocks: [],
    profiles: [
      { id: ME, full_name: "Me", role: "student" },
      { id: id(2), full_name: "Ann", role: "student" },
      { id: id(3), full_name: "Bo", role: "student" },
    ],
  });
  state.unread = [
    { channel_id: QUIET.id, unread: 3, mentions: 0 },
    { channel_id: PINGED.id, unread: 3, mentions: 1 },
    { channel_id: DM.id, unread: 2, mentions: 0 },
    { channel_id: CHATTY.id, unread: 4, mentions: 0 },
  ];
  const viewer = { userId: ME, staff: false, vetted: false, cohortIds: [], teamIds: [], memberOf: [...groups, DM].map((c) => c.id) };

  const sidebar = await chat.buildSidebar(viewer);
  const row = (c: Row) => sidebar.conversations.find((i) => i.id === c.id)!;
  assert.deepEqual([row(QUIET).unread, row(QUIET).mentions, row(QUIET).notify], [3, 0, "mentions"], "bold, no pill");
  assert.deepEqual([row(PINGED).unread, row(PINGED).mentions], [3, 1]);
  assert.deepEqual([row(DM).unread, row(DM).mentions], [2, 2], "the default: every message is to you");
  assert.deepEqual([row(CHATTY).unread, row(CHATTY).mentions], [4, 4]);
  assert.equal(await chat.countAttention(viewer), 3, "PINGED, the DM and CHATTY; not QUIET");
});

test("mark all read clears bells a hundred links at a time, one request after another", async () => {
  const channels = Array.from({ length: 250 }, (_, i) => id(3000 + i));
  const bell = (n: number, user: string, channel: string, type = "chat_dm", read_at: string | null = null) => ({
    id: id(n), user_id: user, link: `/chat?c=${channel}`, type, read_at,
  });
  const notifications = [
    ...channels.map((c, i) => bell(10_000 + i, ME, c)),
    bell(20_000, ME, channels[0], "chat_mention"),
    bell(20_001, ME, channels[0], "announcement"), // not a chat bell
    bell(20_002, id(2), channels[0]), // someone else's
    bell(20_003, ME, id(9999)), // a channel not being marked
  ];
  reset({ notifications });

  assert.equal(await clearChannelBellsMany(ME, [...channels, channels[3]]), 251);
  assert.deepEqual(state.log, [
    `update notifications user_id=${ME} link:100 type:${CHAT_BELL_TYPES.length} read_at is null`,
    `update notifications user_id=${ME} link:100 type:${CHAT_BELL_TYPES.length} read_at is null`,
    `update notifications user_id=${ME} link:50 type:${CHAT_BELL_TYPES.length} read_at is null`,
  ]);
  assert.equal(state.peak, 1, "never more than one in flight");
  const left = notifications.filter((n) => n.read_at === null).map((n) => n.id);
  assert.deepEqual(left, [id(20_001), id(20_002), id(20_003)]);

  // A failure throws rather than reading as "nothing to clear".
  reset({ notifications: channels.map((c, i) => bell(10_000 + i, ME, c)) });
  state.fail = (_table, _op, call) => (call === 2 ? "upstream timeout" : null);
  await assert.rejects(clearChannelBellsMany(ME, channels), /Couldn't clear chat bells: upstream timeout/);
  assert.equal(await clearChannelBellsMany(ME, []), 0);
});

// ---------------------------------------------------------------------------
// The directory: a DM's pair, or a group's whole membership
// ---------------------------------------------------------------------------

const STUDENT_A = id(4001);
const STUDENT_B = id(4002);
const MENTOR = id(4003);
const STAFFER = id(4004);
const INVESTOR = id(4005);

function directory() {
  reset({
    profiles: [
      { id: STUDENT_A, full_name: "Ava Patel", role: "student" },
      { id: STUDENT_B, full_name: "Ben Ortiz", role: "student" },
      { id: MENTOR, full_name: "Sam Rivera", role: "mentor" },
      { id: STAFFER, full_name: "Rish Admin", role: "admin" },
      { id: INVESTOR, full_name: "Ivy Investor", role: "investor" },
    ],
    enrollments: [
      { id: id(5001), user_id: STUDENT_A, cohort_id: id(6001) },
      { id: id(5002), user_id: STUDENT_B, cohort_id: id(6001) },
    ],
    applications: [],
    chat_blocks: [],
  });
}
const vettedViewer = (userId: string, staff = false) => ({ userId, staff, vetted: true, cohortIds: [], teamIds: [], memberOf: [] });
const names = (people: { name: string }[]) => people.map((p) => p.name).sort();

test("a DM's directory keeps the strict pair: no mentor for a student, no student for a mentor", async () => {
  directory();
  assert.deepEqual(names(await chat.searchDirectory("", vettedViewer(STUDENT_A))), ["Ben Ortiz", "Rish Admin"]);
  directory();
  assert.deepEqual(names(await chat.searchDirectory("", vettedViewer(MENTOR))), ["Ivy Investor", "Rish Admin"]);
  // A group with nobody else in it yet is asked the same question.
  directory();
  assert.deepEqual(names(await chat.searchDirectory("", vettedViewer(STUDENT_A), 20, [])), ["Ben Ortiz", "Rish Admin"]);
});

test("a group's directory asks about the whole group: with staff in it, a student finds the mentor it may hold", async () => {
  directory();
  // The reviewer's case: staff picked (or in the group), so the mentor is offered.
  assert.deepEqual(
    names(await chat.searchDirectory("", vettedViewer(STUDENT_A), 20, [STAFFER])),
    ["Ben Ortiz", "Ivy Investor", "Rish Admin", "Sam Rivera"],
  );
  directory();
  assert.deepEqual(names(await chat.searchDirectory("sam", vettedViewer(STUDENT_A), 20, [STAFFER, STUDENT_B])), ["Sam Rivera"]);
  // Another student instead of staff: still no adult outside the team.
  directory();
  assert.deepEqual(names(await chat.searchDirectory("", vettedViewer(STUDENT_A), 20, [STUDENT_B])), ["Ben Ortiz", "Rish Admin"]);
  // The mirror: a mentor building a group with staff in it finds students.
  directory();
  assert.deepEqual(
    names(await chat.searchDirectory("", vettedViewer(MENTOR), 20, [STAFFER])),
    ["Ava Patel", "Ben Ortiz", "Ivy Investor", "Rish Admin"],
  );
  // A mentor already in the group, no staff: the student can't be offered.
  directory();
  assert.deepEqual(names(await chat.searchDirectory("", vettedViewer(STUDENT_A), 20, [MENTOR])), ["Rish Admin"]);
  // Staff reach everyone, group or not.
  directory();
  assert.equal((await chat.searchDirectory("", vettedViewer(STAFFER, true))).length, 4);
});

// ---------------------------------------------------------------------------
// "Report a deleted message": stubs, never words
// ---------------------------------------------------------------------------

test("a text channel's deleted messages come back as stubs: who and when, never what — and never your own", async () => {
  const CH = channelRow(700, "channel", { name: "general", audience: "everyone" });
  const now = Date.now();
  const at = (minutesAgo: number) => new Date(now - minutesAgo * 60_000).toISOString();
  const message = (n: number, over: Row) => ({
    id: id(n), channel_id: CH.id, sender_id: id(2), kind: "message", body: "", attachments: [], created_at: at(10), deleted_at: at(5), ...over,
  });
  reset({
    chat_messages: [
      message(7001, { created_at: at(30) }),
      message(7002, { created_at: at(20), sender_id: id(3) }),
      message(7003, { deleted_at: null, body: "still here" }),
      message(7004, { sender_id: ME }), // the viewer's own
      message(7005, { kind: "system", sender_id: null }),
      message(7006, { sender_id: null }), // a deleted account's: nothing left to review
      message(7007, { created_at: at(60 * 24 * 15) }), // older than two weeks
      message(7008, { channel_id: id(701) }), // another channel
    ],
  });
  const stubs = await chat.listDeletedForReport(chat.toChannel(CH), ME);
  assert.deepEqual(stubs.map((m) => m.id), [id(7002), id(7001)], "newest first");
  for (const stub of stubs) assert.deepEqual(Object.keys(stub).sort(), ["createdAt", "id", "senderId"], "no body, no files, no deleted_by");
  assert.deepEqual(
    state.selected.filter((x) => x.startsWith("chat_messages")),
    ["chat_messages: id, sender_id, created_at"],
    "the read itself never asks for the words, the files or who deleted it",
  );
  // A DM or group has none: its report hands the whole conversation over.
  assert.deepEqual(await chat.listDeletedForReport(chat.toChannel(channelRow(702, "group")), ME), []);
});
