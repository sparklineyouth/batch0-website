import test from "node:test";
import assert from "node:assert/strict";
import * as nodeModule from "node:module";
import { pathToFileURL, fileURLToPath } from "node:url";
import path from "node:path";

// Run the real purgeChatContentFor (lib/chat-purge.ts) against an in-memory
// database, to pin what account deletion leaves behind in the tables 0101
// carried Chat's history from: the old direct messages (0089) go, except in
// a conversation someone reported, the old way or in Chat.

type Row = Record<string, any>;
const state: {
  tables: Record<string, Row[] | undefined>;
  log: string[];
  removed: string[];
  fail: (table: string, op: string) => string | null;
} = { tables: {}, log: [], removed: [], fail: () => null };

/** Just enough of supabase-js over PostgREST: filters, ranges, update/delete, a missing table's error. */
function from(table: string) {
  const filters: ((r: Row) => boolean)[] = [];
  const said: string[] = [];
  let op = "select";
  let patch: Row = {};
  let window: [number, number] | null = null;
  const run = async () => {
    const rows = state.tables[table];
    if (!rows) return { data: null, error: { code: "PGRST205", message: `Could not find the table 'public.${table}' in the schema cache` } };
    const fault = state.fail(table, op);
    if (fault) return { data: null, error: { message: fault } };
    state.log.push(`${op} ${table}${said.length ? " " + said.join(" ") : ""}`);
    const hit = rows.filter((r) => filters.every((f) => f(r)));
    if (op === "delete") {
      state.tables[table] = rows.filter((r) => !hit.includes(r));
      return { data: hit, error: null };
    }
    if (op === "update") {
      for (const r of hit) Object.assign(r, patch);
      return { data: hit, error: null };
    }
    return { data: (window ? hit.slice(window[0], window[1] + 1) : hit).map((r) => ({ ...r })), error: null };
  };
  const chain: any = {
    select: () => chain,
    update: (p: Row) => ((op = "update"), (patch = p), chain),
    delete: () => ((op = "delete"), chain),
    eq: (c: string, v: unknown) => (filters.push((r) => r[c] === v), said.push(`${c}=${v}`), chain),
    in: (c: string, vs: unknown[]) => (filters.push((r) => vs.includes(r[c])), said.push(`${c}:${vs.length}`), chain),
    is: (c: string, v: unknown) => (filters.push((r) => (r[c] ?? null) === v), chain),
    order: () => chain,
    range: (a: number, b: number) => ((window = [a, b]), chain),
    maybeSingle: async () => {
      const r = await run();
      return { data: r.data?.[0] ?? null, error: r.error };
    },
    then: (ok: any, ko: any) => run().then(ok, ko),
  };
  return chain;
}
(globalThis as any).__chatPurge = { state, db: { from } };

const root = fileURLToPath(new URL("../", import.meta.url));
const fake = (source: string) => `data:text/javascript,${encodeURIComponent(source)}`;
(nodeModule as any).registerHooks({
  resolve(specifier: string, context: any, next: any) {
    const g = "const t=globalThis.__chatPurge;";
    const doubles: Record<string, string> = {
      "server-only": "export {};",
      "@/lib/supabase/admin": g + "export const createAdminClient=()=>t.db;",
      "@/lib/roles": "export const capabilitiesForRole=async()=>({superAdmin:false,permissions:[]});",
      // lib/chat.ts's pageAll, to the letter; the rest of lib/chat isn't under test.
      "@/lib/chat":
        "export const pageAll=async(build,what)=>{const out=[];for(let from=0;;from+=1000){const r=await build(from,from+999);" +
        "if(r.error){const e=new Error(`Couldn't load ${what}: ${r.error.message}`);e.code=r.error.code;throw e;}" +
        "const page=r.data??[];out.push(...page);if(page.length<1000)return out;}};" +
        "export const toAttachments=(raw)=>Array.isArray(raw)?raw:[];" +
        "export const getChatViewer=async()=>({});export const listReadableChannels=async()=>[];",
      "@/lib/chat-files": g + "export const listStagedFiles=async()=>[];export const removeChatFiles=async(ps)=>{t.state.removed.push(...ps)};",
    };
    if (doubles[specifier]) return { url: fake(doubles[specifier]), shortCircuit: true };
    if (specifier.startsWith("@/")) return next(pathToFileURL(path.join(root, specifier.slice(2) + ".ts")).href, context);
    return next(specifier, context);
  },
});
const { purgeChatContentFor } = await import("./chat-purge.ts");

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const X = id(1); // leaving
const S = id(2); // stays
const PLAIN = id(10); // an old DM nobody reported
const OLD_REPORT = id(11); // reported before Chat (dm_reports, carried into chat_reports)
const CHAT_REPORT = id(12); // reported since, in Chat
const TEAM = id(13); // a team channel

function seed({ chat = true, dms = true } = {}) {
  state.log = [];
  state.removed = [];
  state.fail = () => null;
  state.tables = { profiles: [{ id: X, role: "student" }, { id: S, role: "student" }] };
  if (dms) {
    state.tables.dm_messages = [
      { id: id(101), conversation_id: PLAIN, sender_id: X, body: "my home address is 12 Private Lane", unsent_at: null },
      { id: id(102), conversation_id: PLAIN, sender_id: X, body: "unsent secret words", unsent_at: "2026-01-02T00:00:00Z" },
      { id: id(103), conversation_id: PLAIN, sender_id: S, body: "a reply", unsent_at: null },
      { id: id(104), conversation_id: OLD_REPORT, sender_id: X, body: "reported the old way", unsent_at: null },
      { id: id(105), conversation_id: OLD_REPORT, sender_id: X, body: "unsent, under a report", unsent_at: "2026-01-02T00:00:00Z" },
      { id: id(106), conversation_id: CHAT_REPORT, sender_id: X, body: "reported in chat", unsent_at: null },
    ];
    state.tables.dm_reports = [{ id: id(201), conversation_id: OLD_REPORT }];
  }
  if (chat) {
    state.tables.chat_channels = [
      { id: PLAIN, kind: "dm" },
      { id: OLD_REPORT, kind: "dm" },
      { id: CHAT_REPORT, kind: "dm" },
      { id: TEAM, kind: "channel" },
    ];
    // The copies 0101 made, under the same ids, and one from the team thread.
    const copy = (n: number, channel: string, sender: string, body: string, deleted = false) => ({
      id: id(n), channel_id: channel, sender_id: sender, body, attachments: [], deleted_at: deleted ? "2026-01-02T00:00:00Z" : null,
    });
    state.tables.chat_messages = [
      copy(101, PLAIN, X, "my home address is 12 Private Lane"),
      copy(102, PLAIN, X, "", true),
      copy(103, PLAIN, S, "a reply"),
      copy(104, OLD_REPORT, X, "reported the old way"),
      copy(105, OLD_REPORT, X, "", true),
      copy(106, CHAT_REPORT, X, "reported in chat"),
      copy(107, TEAM, X, "old team thread words"),
    ];
    state.tables.chat_message_revisions = [
      { id: id(301), message_id: id(102), body: "unsent secret words", attachments: [] },
      { id: id(302), message_id: id(105), body: "unsent, under a report", attachments: [] },
    ];
    state.tables.chat_reports = [
      { id: id(201), channel_id: OLD_REPORT, message_id: null },
      { id: id(202), channel_id: CHAT_REPORT, message_id: id(106) },
    ];
  }
}

const ids = (table: string) => (state.tables[table] ?? []).map((r) => r.id.slice(-3));
const bodies = () => Object.fromEntries((state.tables.chat_messages ?? []).map((r) => [r.id.slice(-3), r.body]));

test("the old direct messages go with the account, except where someone reported the conversation", async () => {
  seed();
  await purgeChatContentFor(X);
  // Their words in the unreported DM, the unsent one included, are gone; the
  // other person's reply stays; both reported conversations stay whole.
  assert.deepEqual(ids("dm_messages"), ["103", "104", "105", "106"]);
  assert.deepEqual(state.log.filter((l) => l.startsWith("delete dm_messages")), [`delete dm_messages sender_id=${X} id:2`]);
  // The Chat copies follow the same rule, the team thread's copy blanked like any channel message.
  assert.deepEqual(bodies(), { "101": "", "102": "", "103": "a reply", "104": "reported the old way", "105": "", "106": "reported in chat", "107": "" });
  assert.deepEqual(ids("chat_message_revisions"), ["302"]);

  // Idempotent: a second run finds nothing more to delete.
  state.log = [];
  await purgeChatContentFor(X);
  assert.deepEqual(ids("dm_messages"), ["103", "104", "105", "106"]);
  assert.equal(state.log.filter((l) => l.startsWith("delete dm_messages")).length, 0);
});

test("a database without the old direct messages purges Chat as before", async () => {
  seed({ dms: false });
  await purgeChatContentFor(X);
  assert.equal(bodies()["101"], "");
  assert.equal(bodies()["106"], "reported in chat");
});

test("before 0101 the old reports alone decide what's evidence", async () => {
  seed({ chat: false });
  await purgeChatContentFor(X);
  assert.deepEqual(ids("dm_messages"), ["103", "104", "105"]);
  assert.ok(!state.log.some((l) => l.includes("chat_reports")), "no Chat to have reports in");
});

test("a report lookup that fails stops the purge before anything is deleted", async () => {
  seed();
  state.fail = (table) => (table === "dm_reports" ? "connection reset" : null);
  await assert.rejects(purgeChatContentFor(X), /old reports: connection reset/);
  assert.deepEqual(ids("dm_messages"), ["101", "102", "103", "104", "105", "106"]);
});

test("a delete that fails throws, so the account isn't deleted yet", async () => {
  seed();
  state.fail = (table, op) => (table === "dm_messages" && op === "delete" ? "statement timeout" : null);
  await assert.rejects(purgeChatContentFor(X), /Couldn't remove their old direct messages: statement timeout/);
});
