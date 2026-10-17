import test from "node:test";
import assert from "node:assert/strict";
import * as nodeModule from "node:module";
import { pathToFileURL, fileURLToPath } from "node:url";
import path from "node:path";

// Run with `npm test`. The real POST /api/ai/chat with the model, the
// database and the billing doubled: a reply that dies mid-stream must leave a
// server log line and a plain instruction, never the provider's raw error,
// and a reply that was saved before something later failed must not be
// reported as lost. No network, no tokens spent.

const state = {
  failAt: "stream" as "stream" | "usage",
  inserted: [] as { role: string; content: string }[],
  logged: [] as unknown[][],
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
    create: async () =>
      (async function* () {
        yield { type: "message_start", message: { usage: { input_tokens: 10, output_tokens: 1 } } };
        yield { type: "content_block_delta", delta: { type: "text_delta", text: "Start with" } };
        if (state.failAt === "stream") {
          throw new Error('529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}');
        }
        yield { type: "message_delta", usage: { output_tokens: 2 } };
      })(),
  };
}
(globalThis as any).__aiChatTest = { db, state, FakeAnthropic };
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
      "@/lib/rate-limit": "export const checkRateLimit=async()=>({ok:true});",
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

async function ask(): Promise<string> {
  const res = await POST(
    new Request("https://batch0.org/api/ai/chat", {
      method: "POST",
      body: JSON.stringify({ conversationId: "c1", message: "How should I price?" }),
    }),
  );
  assert.equal(res.status, 200);
  return await res.text();
}

test("a reply that dies mid-stream is logged, and the student gets an instruction, not raw JSON", async () => {
  state.failAt = "stream";
  state.inserted = [];
  state.logged = [];
  const text = await ask();
  assert.ok(text.startsWith("Start with"), "what streamed before the failure is kept");
  assert.match(text, /cut off by an error on our side and wasn't saved\. Send your message again\./);
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
