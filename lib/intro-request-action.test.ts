import test from "node:test";
import assert from "node:assert/strict";
import * as nodeModule from "node:module";
import { pathToFileURL, fileURLToPath } from "node:url";
import path from "node:path";

// Run with `npm test`. The real createIntroRequest
// (app/investor/teams/[id]/actions.ts) against an in-memory intro_requests
// table. Its upsert ignores a duplicate, so of two submits racing each other
// only one files the request — and only that one may ping the admins. Both
// used to, so one intro arrived as two bells for every admin.

type Row = { id: string; investor_id: string; team_id: string; message: string | null; status: string };
const state = {
  rows: [] as Row[],
  notified: [] as { userId: string; title: string }[],
  /** Runs just before an upsert applies: the other submit landing first. */
  beforeUpsert: null as (() => void) | null,
};

const db = {
  from(table: string) {
    const f: Record<string, unknown> = {};
    let op: "select" | "upsert" | "update" = "select";
    let payload: any = null;
    let ignoreDuplicates = false;
    let returning = false;
    let head = false;
    const result = () => {
      if (table === "teams") return { data: { name: "Rocket" }, error: null };
      if (table === "profiles") {
        if (f.role === "admin") return { data: [{ id: "admin-1" }, { id: "admin-2" }], error: null };
        return { data: f.id === "inv" ? { role: "investor", full_name: "Ivy", email: "ivy@fund.test" } : null, error: null };
      }
      assert.equal(table, "intro_requests");
      if (op === "upsert") {
        state.beforeUpsert?.();
        state.beforeUpsert = null;
        const clash = state.rows.find((r) => r.investor_id === payload.investor_id && r.team_id === payload.team_id);
        if (clash && ignoreDuplicates) return { data: returning ? [] : null, error: null };
        const row = { id: `ir${state.rows.length + 1}`, ...payload };
        state.rows.push(row);
        return { data: returning ? [{ id: row.id }] : null, error: null };
      }
      if (op === "update") {
        for (const r of state.rows) if (r.id === f.id && r.status === f.status) Object.assign(r, payload);
        return { data: null, error: null };
      }
      const mine = state.rows.filter((r) => r.investor_id === f.investor_id);
      if (head) return { count: mine.filter((r) => r.status === f.status).length, error: null };
      return { data: mine.find((r) => r.team_id === f.team_id) ?? null, error: null };
    };
    const chain: any = { then: (ok: any, no: any) => Promise.resolve().then(result).then(ok, no) };
    chain.select = (_c?: string, opts?: { head?: boolean }) => {
      if (op === "upsert") returning = true;
      head = !!opts?.head;
      return chain;
    };
    chain.eq = (k: string, v: unknown) => ((f[k] = v), chain);
    chain.maybeSingle = () => chain;
    chain.upsert = (v: any, opts?: { ignoreDuplicates?: boolean }) => {
      op = "upsert";
      payload = v;
      ignoreDuplicates = !!opts?.ignoreDuplicates;
      return chain;
    };
    chain.update = (v: any) => ((op = "update"), (payload = v), chain);
    return chain;
  },
};
const notify = async (n: { userId: string; title: string }) => void state.notified.push(n);
(globalThis as any).__introTest = { db, notify };

const root = fileURLToPath(new URL("../", import.meta.url));
const fake = (source: string) => `data:text/javascript,${encodeURIComponent(source)}`;
(nodeModule as any).registerHooks({
  resolve(specifier: string, context: any, next: any) {
    const g = "const t=globalThis.__introTest;";
    const doubles: Record<string, string> = {
      "next/cache": "export const revalidatePath=()=>{};",
      "next/navigation": "export const unstable_rethrow=()=>{};",
      "@/lib/supabase/admin": g + "export const createAdminClient=()=>t.db;",
      "@/lib/server-guards": "export const assertSelf=async()=>({userId:'inv'});",
      "@/lib/notifications": g + "export const notify=(n)=>t.notify(n);",
    };
    if (doubles[specifier]) return { url: fake(doubles[specifier]), shortCircuit: true };
    if (specifier.startsWith("@/")) {
      return next(pathToFileURL(path.join(root, specifier.slice(2) + ".ts")).href, context);
    }
    return next(specifier, context);
  },
});
const { createIntroRequest } = await import("../app/investor/teams/[id]/actions.ts");

function reset() {
  state.rows = [];
  state.notified = [];
  state.beforeUpsert = null;
}

test("a new request is filed once and every admin hears about it once", async () => {
  reset();
  assert.deepEqual(await createIntroRequest({ teamId: "t1", message: "Keen to meet" }), { ok: true, data: undefined });
  assert.equal(state.rows.length, 1);
  assert.deepEqual(state.notified.map((n) => n.userId), ["admin-1", "admin-2"]);
  assert.match(state.notified[0].title, /Ivy wants an intro to Rocket/);
});

test("the losing half of a double-submit files nothing and pings nobody", async () => {
  reset();
  // Both submits read "no request yet"; the other one's insert lands first.
  state.beforeUpsert = () => {
    state.rows.push({ id: "first", investor_id: "inv", team_id: "t1", message: "Keen to meet", status: "requested" });
  };
  const res = await createIntroRequest({ teamId: "t1", message: "Keen to meet" });
  assert.equal(res.ok, true, "the request is filed, by the other submit");
  assert.equal(state.rows.length, 1);
  assert.equal(state.rows[0].id, "first", "the first row stands as it was");
  assert.deepEqual(state.notified, [], "the submit that filed it pings the admins, not this one");
});

test("rewording a request that's still waiting doesn't ping the admins again", async () => {
  reset();
  state.rows.push({ id: "ir1", investor_id: "inv", team_id: "t1", message: "Hi", status: "requested" });
  assert.equal((await createIntroRequest({ teamId: "t1", message: "Hi again" })).ok, true);
  assert.equal(state.rows[0].message, "Hi again");
  assert.deepEqual(state.notified, []);
});
