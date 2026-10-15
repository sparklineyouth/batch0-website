import test from "node:test";
import assert from "node:assert/strict";
import * as nodeModule from "node:module";
import { pathToFileURL, fileURLToPath } from "node:url";
import path from "node:path";
import { MESSAGE_MAX, MUTED_REASON } from "./chat-access.ts";

// Run the real postToChannel (lib/chat-post.ts) against an in-memory
// chat_channels / chat_messages and doubles for the mute and the bells: a
// long post goes out whole as several messages, only the first pings and
// rings, a muted person can't post through it, and a post that fails partway
// is taken back.

type Row = Record<string, any>;
const state = {
  channels: [] as Row[],
  messages: [] as Row[],
  muted: new Set<string>(),
  staff: new Set<string>(),
  bells: [] as Row[],
  failInsertAt: -1,
  inserts: 0,
};
function reset() {
  state.channels = [{ id: "ch-ann", system_key: "announcements", kind: "channel", name: "announcements", archived_at: null }];
  state.messages = [];
  state.muted = new Set();
  state.staff = new Set();
  state.bells = [];
  state.failInsertAt = -1;
  state.inserts = 0;
}
reset();

const db = {
  from(table: string) {
    let op: "select" | "insert" | "delete" = "select";
    let payload: Row | null = null;
    const filters: [string, string, any][] = [];
    const run = () => {
      if (table === "chat_channels") {
        const row = state.channels.find((c) => filters.every(([, k, v]) => c[k] === v)) ?? null;
        return { data: row, error: null };
      }
      assert.equal(table, "chat_messages");
      if (op === "insert") {
        if (state.inserts++ === state.failInsertAt) return { data: null, error: { message: "insert failed" } };
        const row = { id: `m${state.messages.length + 1}`, created_at: new Date().toISOString(), ...payload };
        state.messages.push(row);
        return { data: row, error: null };
      }
      if (op === "delete") {
        const [, , ids] = filters.find(([f]) => f === "in")!;
        state.messages = state.messages.filter((m) => !ids.includes(m.id));
        return { data: null, error: null };
      }
      throw new Error(`unexpected ${op} on ${table}`);
    };
    const chain: any = {
      select: () => chain,
      insert: (row: Row) => ((op = "insert"), (payload = row), chain),
      delete: () => ((op = "delete"), chain),
      eq: (k: string, v: any) => (filters.push(["eq", k, v]), chain),
      in: (k: string, v: any[]) => (filters.push(["in", k, v]), chain),
      maybeSingle: async () => run(),
      single: async () => run(),
      then: (resolve: any, reject: any) => Promise.resolve().then(run).then(resolve, reject),
    };
    return chain;
  },
};
(globalThis as any).__chatPost = { state, db };

const root = fileURLToPath(new URL("../", import.meta.url));
const fake = (source: string) => `data:text/javascript,${encodeURIComponent(source)}`;
(nodeModule as any).registerHooks({
  resolve(specifier: string, context: any, next: any) {
    const g = "const t=globalThis.__chatPost;";
    const doubles: Record<string, string> = {
      "server-only": "",
      "@/lib/supabase/admin": g + "export const createAdminClient=()=>t.db;",
      "@/lib/chat":
        g +
        "export const isMuted=async(id)=>t.state.muted.has(id);" +
        "export const getPerson=async(id)=>({id,isStaff:t.state.staff.has(id)});",
      "@/lib/chat-notify": g + "export const notifyNewMessage=async(input)=>{t.state.bells.push(input);};",
    };
    if (specifier in doubles) return { url: fake(doubles[specifier]), shortCircuit: true };
    if (specifier.startsWith("@/")) return next(pathToFileURL(path.join(root, specifier.slice(2) + ".ts")).href, context);
    return next(specifier, context);
  },
});
const { postToChannel, postStaffFeed } = await import("./chat-post.ts");

const AUTHOR = "00000000-0000-4000-8000-0000000000a1";
const long = Array.from({ length: 40 }, (_, i) => `Paragraph ${i}. ` + "Details follow here. ".repeat(12).trim()).join("\n\n");

test("a long announcement goes out whole, in order; only its first message pings and rings", async () => {
  reset();
  assert.ok(long.length > 2 * MESSAGE_MAX);
  const res = await postToChannel(
    { systemKey: "announcements" },
    { senderId: AUTHOR, body: long, mentionEveryone: true, excludeBells: ["s1"] },
  );
  assert.ok(res.ok);
  assert.ok(state.messages.length >= 3);
  assert.deepEqual(res.messageIds, state.messages.map((m) => m.id));
  assert.equal(res.messageId, state.messages[0].id);
  for (const m of state.messages) {
    assert.ok(m.body.length <= MESSAGE_MAX);
    assert.equal(m.channel_id, "ch-ann");
    assert.equal(m.sender_id, AUTHOR);
    assert.equal(m.kind, "message");
  }
  assert.equal(state.messages.map((m) => m.body).join("\n\n"), long, "nothing cut, nothing added");
  assert.deepEqual(state.messages.map((m) => m.mention_everyone), state.messages.map((_, n) => n === 0));
  assert.equal(state.bells.length, 1);
  assert.equal(state.bells[0].messageId, state.messages[0].id);
  assert.equal(state.bells[0].mentionEveryone, true);
  assert.deepEqual(state.bells[0].excludeBells, ["s1"]);
});

test("a muted person can't post through it, @everyone or not", async () => {
  reset();
  state.muted.add(AUTHOR);
  const res = await postToChannel(
    { systemKey: "announcements" },
    { senderId: AUTHOR, body: "**Title**\n\nanything at all", mentionEveryone: true },
  );
  assert.deepEqual(res, { ok: false, reason: MUTED_REASON });
  assert.equal(state.messages.length, 0);
  assert.equal(state.bells.length, 0);
});

test("a mute row left on someone who now runs chat doesn't hold, as in the composer", async () => {
  reset();
  state.muted.add(AUTHOR);
  state.staff.add(AUTHOR);
  const res = await postToChannel({ systemKey: "announcements" }, { senderId: AUTHOR, body: "hello" });
  assert.ok(res.ok);
  assert.equal(state.messages.length, 1);
});

test("batch0's own system lines have no sender to mute", async () => {
  reset();
  state.channels.push({ id: "ch-staff", system_key: "staff", kind: "channel", name: "staff", archived_at: null });
  await postStaffFeed("Enrolled: **Ada** in Fall 2026 · https://batch0.test/admin/students/x");
  assert.equal(state.messages.length, 1);
  assert.equal(state.messages[0].kind, "system");
  assert.equal(state.messages[0].sender_id, null);
  assert.equal(state.bells.length, 0);
});

test("a post that fails partway is taken back, so the channel never shows half of it", async () => {
  reset();
  state.failInsertAt = 2;
  const res = await postToChannel({ systemKey: "announcements" }, { senderId: AUTHOR, body: long, mentionEveryone: true });
  assert.deepEqual(res, { ok: false, reason: "insert failed" });
  assert.equal(state.messages.length, 0);
  assert.equal(state.bells.length, 0);
});

test("a blank body, a missing or archived channel are reported, not raised", async () => {
  reset();
  assert.deepEqual(await postToChannel({ systemKey: "announcements" }, { senderId: null, body: "  " }), {
    ok: false,
    reason: "Nothing to post.",
  });
  assert.deepEqual(await postToChannel({ systemKey: "nope" }, { senderId: null, body: "x" }), {
    ok: false,
    reason: "That channel doesn't exist.",
  });
  state.channels[0].archived_at = "2026-01-01T00:00:00Z";
  assert.deepEqual(await postToChannel({ systemKey: "announcements" }, { senderId: null, body: "x" }), {
    ok: false,
    reason: "That channel is archived.",
  });
  assert.equal(state.messages.length, 0);
});
