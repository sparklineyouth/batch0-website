import test from "node:test";
import assert from "node:assert/strict";
import * as nodeModule from "node:module";
import { pathToFileURL, fileURLToPath } from "node:url";
import path from "node:path";

// Run with `npm test`. The real POST /api/ai/chat with the model, the
// database and the billing doubled: a reply that dies mid-stream must leave a
// server log line and a plain instruction, never the provider's raw error,
// a reply that was saved before something later failed must not be reported
// as lost, and doing what the notice says — sending the question again —
// must not save it twice. Nor may a second send while the first reply is
// still streaming: it used to look exactly like that resend, and got the
// question a second reply. No network, no tokens spent.

const state = {
  failAt: "stream" as "before" | "stream" | "usage" | "none",
  inserted: [] as { role: string; content: string }[],
  logged: [] as unknown[][],
  sentToModel: [] as { role: string; content: string }[],
  modelCalls: 0,
  /** When set, the model holds its reply open until this resolves. */
  hold: null as Promise<void> | null,
};
/** checkRateLimit / clearRateLimit as rate_limit_check counts (0005), per key. */
const limits = new Map<string, number>();
const rateLimit = {
  check: async (a: { kind: string; identifier: string; limit: number }) => {
    const key = `${a.kind}:${a.identifier}`;
    const n = (limits.get(key) ?? 0) + 1;
    limits.set(key, n);
    return { ok: n <= a.limit, count: n, limit: a.limit };
  },
  clear: async (a: { kind: string; identifier: string }) => void limits.delete(`${a.kind}:${a.identifier}`),
};
console.error = (...args: unknown[]) => void state.logged.push(args);

const tables: Record<string, unknown> = {
  profiles: { role: "admin", full_name: "Ada", ai_context: null },
  ai_conversations: { id: "c1", user_id: "u1", title: "Pricing", team_id: null },
  ai_messages: [],
  enrollments: [],
  applications: null,
  team_members: [],
};
const db = {
  auth: { getUser: async () => ({ data: { user: { id: "u1" } }, error: null }) },
  from(table: string) {
    let row: any = null;
    const chain: any = {
      then: (ok: any, no: any) =>
        Promise.resolve()
          .then(() => {
            if (row) {
              state.inserted.push(row);
              return { data: null, error: null };
            }
            return { data: tables[table] ?? null, error: null };
          })
          .then(ok, no),
    };
    for (const m of ["select", "eq", "order", "limit", "single", "maybeSingle", "update"]) chain[m] = () => chain;
    chain.insert = (v: any) => { row = v; return chain; };
    return chain;
  },
};
// The model: two words, then the connection drops.
class FakeAnthropic {
  messages = {
    create: async (req: { messages: { role: string; content: string }[] }) => {
      state.sentToModel = req.messages;
      state.modelCalls++;
      // Overloaded before the first word: nothing streams at all.
      if (state.failAt === "before") throw new Error('529 {"type":"error","error":{"type":"overloaded_error"}}');
      return (async function* () {
        yield { type: "message_start", message: { usage: { input_tokens: 10, output_tokens: 1 } } };
        yield { type: "content_block_delta", delta: { type: "text_delta", text: "Start with" } };
        if (state.hold) await state.hold;
        if (state.failAt === "stream") {
          throw new Error('529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}');
        }
        yield { type: "message_delta", usage: { output_tokens: 2 } };
      })();
    },
  };
}
(globalThis as any).__aiChatTest = { db, state, FakeAnthropic, rateLimit };
const root = fileURLToPath(new URL("../", import.meta.url));
const fake = (source: string) => `data:text/javascript,${encodeURIComponent(source)}`;
(nodeModule as any).registerHooks({
  resolve(specifier: string, context: any, next: any) {
    const g = "const t=globalThis.__aiChatTest;";
    const doubles: Record<string, string> = {
      "@anthropic-ai/sdk": g + "export default t.FakeAnthropic;",
      "@/lib/supabase/server": g + "export const createClient=async()=>t.db;",
      "@/lib/supabase/admin": g + "export const createAdminClient=()=>t.db;",
      "@/lib/env": "export const env={anthropicApiKey:'test-key'};",
      "@/lib/rate-limit": g + "export const checkRateLimit=(a)=>t.rateLimit.check(a);export const clearRateLimit=(a)=>t.rateLimit.clear(a);",
      "@/lib/assignments-server": "export const loadStudentAssignments=async()=>({items:[]});",
      "@/lib/ai/usage":
        g + "export const isOverHardCap=async()=>false;export const applyUsage=async()=>{if(t.state.failAt==='usage')throw Error('usage rollup down');return{chargedCents:0};};",
      "@/lib/roles": "export const getAllRoles=async()=>[{slug:'admin',permissions:['*']}];",
      "@/lib/ai/system-prompt": "export const buildSystemPrompt=()=>'system';export const buildCurriculumContext=()=>'';",
    };
    if (doubles[specifier]) return { url: fake(doubles[specifier]), shortCircuit: true };
    if (specifier.startsWith("@/")) {
      return next(pathToFileURL(path.join(root, specifier.slice(2) + ".ts")).href, context);
    }
    return next(specifier, context);
  },
});
const { POST } = await import("../app/api/ai/chat/route.ts");

function post(message = "How should I price?"): Promise<Response> {
  return POST(
    new Request("https://batch0.org/api/ai/chat", {
      method: "POST",
      body: JSON.stringify({ conversationId: "c1", message }),
    }),
  );
}

async function ask(): Promise<string> {
  const res = await post();
  assert.equal(res.status, 200);
  return await res.text();
}

test("a reply that dies mid-stream is logged, and the student gets an instruction, not raw JSON", async () => {
  state.failAt = "stream";
  state.inserted = [];
  state.logged = [];
  const text = await ask();
  assert.ok(text.startsWith("Start with"), "what streamed before the failure is kept");
  assert.equal(
    text,
    "Start with\n\nThe reply was cut off by an error on our side and wasn't saved. Send your message again.",
    "plain text: the bubble shows markdown underscores as they are",
  );
  assert.doesNotMatch(text, /overloaded_error|529/);
  assert.deepEqual(state.inserted.map((r) => r.role), ["user"], "only the question was saved");
  const line = state.logged.find((a) => a[0] === "[ai-chat] stream failed");
  assert.ok(line, "the failure leaves a server log line");
  assert.equal((line[1] as any).saved, false);
  assert.equal((line[1] as any).streamedChars, "Start with".length);
});

test("a failure after the reply was saved is logged but doesn't tell the student it was lost", async () => {
  state.failAt = "usage";
  state.inserted = [];
  state.logged = [];
  const text = await ask();
  assert.equal(text, "Start with");
  assert.deepEqual(state.inserted.map((r) => r.role), ["user", "assistant"]);
  const line = state.logged.find((a) => a[0] === "[ai-chat] stream failed");
  assert.ok(line);
  assert.equal((line[1] as any).saved, true);
});

test("a reply that fails before its first word says so, without claiming it was cut off", async () => {
  state.failAt = "before";
  state.inserted = [];
  state.logged = [];
  const text = await ask();
  assert.equal(text, "That reply failed on our side and wasn't saved. Send your message again.");
  assert.ok(state.logged.find((a) => a[0] === "[ai-chat] stream failed"));
});

test("sending the question again after a failed reply answers the saved one instead of saving it twice", async () => {
  state.failAt = "usage";
  state.inserted = [];
  state.logged = [];
  // Newest first, as the route reads it: the question, with no reply after it.
  tables.ai_messages = [
    { role: "user", content: "How should I price?", created_at: "2026-10-17T10:01:00Z" },
    { role: "assistant", content: "Earlier answer", created_at: "2026-10-17T10:00:30Z" },
    { role: "user", content: "Earlier question", created_at: "2026-10-17T10:00:00Z" },
  ];
  try {
    await ask();
    assert.deepEqual(state.inserted.map((r) => r.role), ["assistant"], "the question isn't saved again");
    assert.deepEqual(
      state.sentToModel.map((m) => [m.role, m.content]),
      [
        ["user", "Earlier question"],
        ["assistant", "Earlier answer"],
        ["user", "How should I price?"],
      ],
      "the model sees the question once",
    );
    // The same words after a reply that DID save are a new question.
    tables.ai_messages = [
      { role: "assistant", content: "Price on value.", created_at: "2026-10-17T10:02:00Z" },
      { role: "user", content: "How should I price?", created_at: "2026-10-17T10:01:00Z" },
    ];
    state.inserted = [];
    await ask();
    assert.deepEqual(state.inserted.map((r) => r.role), ["user", "assistant"]);
  } finally {
    tables.ai_messages = [];
  }
});

test("a second send while the reply is still streaming is refused, not answered twice", async () => {
  state.failAt = "none";
  state.inserted = [];
  state.logged = [];
  state.modelCalls = 0;
  limits.clear();
  let release!: () => void;
  state.hold = new Promise<void>((r) => (release = r));
  try {
    const first = await post();
    assert.equal(first.status, 200);
    const reading = first.text();
    // The first reply is mid-stream: its question is saved with nothing
    // after it — what a resend after a failure looks like, too.
    tables.ai_messages = [{ role: "user", content: "How should I price?", created_at: "2026-10-17T10:01:00Z" }];
    const second = await post();
    assert.equal(second.status, 409);
    assert.match((await second.json()).error, /still being answered/);
    // A different question to the same conversation waits its turn as well.
    assert.equal((await post("And what about churn?")).status, 409);
    release();
    assert.equal(await reading, "Start with");
    assert.equal(state.modelCalls, 1, "one question, one reply");
    assert.deepEqual(state.inserted.map((r) => r.role), ["user", "assistant"]);
    // Handed back once the reply is saved: the next message goes through.
    tables.ai_messages = [
      { role: "assistant", content: "Start with", created_at: "2026-10-17T10:01:30Z" },
      { role: "user", content: "How should I price?", created_at: "2026-10-17T10:01:00Z" },
    ];
    assert.equal((await post("And what about churn?")).status, 200);
  } finally {
    state.hold = null;
    tables.ai_messages = [];
  }
});

test("a reply that fails hands the conversation back, so sending again works at once", async () => {
  state.failAt = "stream";
  state.inserted = [];
  limits.clear();
  assert.match(await ask(), /Send your message again/);
  tables.ai_messages = [{ role: "user", content: "How should I price?", created_at: "2026-10-17T10:01:00Z" }];
  try {
    state.failAt = "none";
    state.inserted = [];
    assert.equal(await ask(), "Start with");
    assert.deepEqual(state.inserted.map((r) => r.role), ["assistant"], "answered, not saved again");
  } finally {
    tables.ai_messages = [];
  }
});

test("a resend whose question was answered while it waited isn't answered again", async () => {
  // The history the request read first says "unanswered"; by the time it
  // holds the conversation, another tab's reply has been saved.
  state.failAt = "none";
  state.inserted = [];
  state.modelCalls = 0;
  limits.clear();
  const unanswered = [{ role: "user", content: "How should I price?", created_at: "2026-10-17T10:01:00Z" }];
  const answered = [{ role: "assistant", content: "Price on value.", created_at: "2026-10-17T10:01:30Z" }, ...unanswered];
  let reads = 0;
  Object.defineProperty(tables, "ai_messages", {
    configurable: true,
    get: () => (reads++ === 0 ? unanswered : answered),
  });
  try {
    const res = await post();
    assert.equal(res.status, 409);
    assert.match((await res.json()).error, /just answered/);
    assert.equal(state.modelCalls, 0);
    assert.deepEqual(state.inserted, []);
    assert.ok(!limits.has("ai-chat-reply:c1"), "and the conversation is handed back");
  } finally {
    Object.defineProperty(tables, "ai_messages", { configurable: true, writable: true, value: [] });
  }
});
