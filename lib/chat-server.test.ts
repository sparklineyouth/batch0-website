import test from "node:test";
import assert from "node:assert/strict";
import * as nodeModule from "node:module";
import { pathToFileURL, fileURLToPath } from "node:url";
import path from "node:path";

// The real lib/chat.ts and lib/chat-notify.ts against an in-memory database:
// mention search past the first page of name matches, the sidebar and badge
// under "Only @mentions", and "Mark all read" clearing bells in chunks.

type Row = Record<string, any>;
const state: {
  tables: Record<string, Row[]>;
  unread: { channel_id: string; unread: number; mentions: number }[];
  log: string[];
  inFlight: number;
  peak: number;
  fail: (table: string, op: string, call: number) => string | null;
  calls: number;
} = { tables: {}, unread: [], log: [], inFlight: 0, peak: 0, fail: () => null, calls: 0 };

const likeToRegExp = (pattern: string) =>
  new RegExp(`^${pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/%/g, ".*").replace(/_/g, ".")}$`, "is");

/** Just enough of supabase-js over PostgREST for these reads and writes. */
function from(table: string) {
  const filters: ((r: Row) => boolean)[] = [];
  const said: string[] = [];
  const sorts: string[] = [];
  let op = "select";
  let patch: Row = {};
  let window: [number, number] | null = null;
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
        for (const c of sorts) if (a[c] !== b[c]) return String(a[c]) < String(b[c]) ? -1 : 1;
        return 0;
      });
    }
    return { data: (window ? hit.slice(window[0], window[1] + 1) : hit).map((r) => ({ ...r })), error: null };
  };
  const chain: any = {
    select: () => chain,
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
    order: (c: string) => (sorts.push(c), chain),
    range: (a: number, b: number) => ((window = [a, b]), chain),
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
