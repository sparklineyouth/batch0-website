import test, { mock } from "node:test";
import assert from "node:assert/strict";
import * as nodeModule from "node:module";
import { pathToFileURL, fileURLToPath } from "node:url";
import path from "node:path";

// Run the real moveToCohort (app/admin/students/[id]/actions.ts) against
// doubles, to pin what happens around the database's one-transaction move
// (0103's admin_move_student_cohort, tested for real in
// lib/admin-integrity-migration-db.test.ts): the student is notified and the
// audit row written only after the move committed, never for a refusal, a
// rolled-back write, or a database that doesn't have the function yet. The
// review's reproduction (a roster-only student "moved" into no enrollment
// while the action said ok) can't happen here any more: the action no longer
// writes enrollments at all.

const STUDENT = "00000000-0000-4000-8000-0000000000aa";
const state: {
  calls: string[];
  rpcArgs: any;
  rpc: { data: any; error: any };
  writes: string[];
} = { calls: [], rpcArgs: null, rpc: { data: null, error: null }, writes: [] };

const db = {
  from(table: string) {
    const chain: any = {
      select: () => chain,
      eq: () => chain,
      maybeSingle: async () => {
        if (table === "profiles") {
          return { data: { id: STUDENT, email: "ada@example.com", full_name: "Ada", role: "student" }, error: null };
        }
        if (table === "cohorts") return { data: { id: "winter", name: "Winter" }, error: null };
        throw Error(`Unexpected read of ${table}`);
      },
    };
    for (const m of ["insert", "update", "delete", "upsert"]) {
      chain[m] = () => {
        state.writes.push(`${m}:${table}`);
        return chain;
      };
    }
    return chain;
  },
  async rpc(name: string, args: any) {
    state.calls.push(`rpc:${name}`);
    state.rpcArgs = args;
    return state.rpc;
  },
};
(globalThis as any).__cohortMove = { state, db };

const root = fileURLToPath(new URL("../", import.meta.url));
const fake = (source: string) => `data:text/javascript,${encodeURIComponent(source)}`;
(nodeModule as any).registerHooks({
  resolve(specifier: string, context: any, next: any) {
    const g = "const t=globalThis.__cohortMove;";
    const doubles: Record<string, string> = {
      "next/cache": "export const revalidatePath=()=>{};",
      "@/lib/supabase/admin": g + "export const createAdminClient=()=>t.db;",
      "@/lib/server-guards":
        g + "export const assertAdmin=async()=>({userId:'actor'});export const assertPermission=async(p)=>{t.state.calls.push('assert:'+p);return {userId:'actor'};};",
      "@/lib/roles": "export const capabilitiesForRole=async()=>({superAdmin:false,permissions:[]});",
      "@/lib/audit": g + "export const logAudit=async(e)=>{t.state.calls.push('audit:'+e.action+':'+JSON.stringify(e.payload));};",
      "@/lib/notifications": g + "export const notify=async(n)=>{t.state.calls.push('notify:'+n.title);};",
      "@/lib/email/send": "export const sendEmail=async()=>{throw Error('Unexpected email');};",
      "@/lib/stripe": "export const stripe={};",
      "@/lib/stripe-fulfillment": "export const handleChargeRefunded=async()=>{};",
      "@/lib/chat-purge": "export const purgeChatContentFor=async()=>{};",
      "@/lib/env": "export const env={siteUrl:'https://batch0.test'};",
    };
    if (doubles[specifier]) return { url: fake(doubles[specifier]), shortCircuit: true };
    if (specifier.startsWith("@/")) return next(pathToFileURL(path.join(root, specifier.slice(2) + ".ts")).href, context);
    return next(specifier, context);
  },
});

mock.method(console, "error", () => {});
const { moveToCohort } = await import("../app/admin/students/[id]/actions.ts");

function reset(rpc: { data: any; error: any }) {
  state.calls = [];
  state.rpcArgs = null;
  state.rpc = rpc;
  state.writes = [];
}

test("a committed move is audited and announced, in that order, after the database call", async () => {
  reset({
    data: {
      ok: true,
      from_cohort_id: "fall",
      to_cohort_id: "winter",
      application_id: null,
      enrollment: "moved",
      scholarship_application_ids: [],
    },
    error: null,
  });
  const res = await moveToCohort(STUDENT, "winter", "fall");
  assert.deepEqual(res, { ok: true, data: { restored: false } });
  assert.deepEqual(state.rpcArgs, { p_user_id: STUDENT, p_to_cohort_id: "winter", p_from_cohort_id: "fall" });
  assert.deepEqual(
    state.calls.map((c) => c.split(":").slice(0, 2).join(":")),
    ["assert:people.manage", "rpc:admin_move_student_cohort", "audit:user.moved_to_cohort", "notify:Moved to Winter"],
  );
  const audit = JSON.parse(state.calls[2].slice("audit:user.moved_to_cohort:".length));
  assert.equal(audit.from_cohort_id, "fall");
  assert.equal(audit.enrollment, "moved");
  // The action itself writes nothing: no delete-then-insert to half-finish.
  assert.deepEqual(state.writes, []);
});

test("a restore in place is reported as one, and the student isn't told they moved", async () => {
  reset({
    data: {
      ok: true,
      from_cohort_id: "winter",
      to_cohort_id: "winter",
      application_id: "app-1",
      enrollment: "restored",
      scholarship_application_ids: [],
    },
    error: null,
  });
  const res = await moveToCohort(STUDENT, "winter");
  assert.deepEqual(res, { ok: true, data: { restored: true } });
  assert.ok(state.calls.includes("notify:You're back in Winter"));
  assert.ok(!state.calls.some((c) => c.startsWith("notify:Moved")));
  const audit = JSON.parse(
    state.calls.find((c) => c.startsWith("audit:"))!.slice("audit:user.moved_to_cohort:".length),
  );
  assert.equal(audit.enrollment, "restored");
  assert.deepEqual(state.writes, []);
});

test("a refusal says why and tells nobody", async () => {
  reset({ data: { ok: false, code: "application_exists", status: "draft" }, error: null });
  const res = await moveToCohort(STUDENT, "winter");
  assert.equal(res.ok, false);
  assert.match((res as any).error, /a draft application for Winter/);
  assert.ok(!state.calls.some((c) => c.startsWith("audit:") || c.startsWith("notify:")));
});

test("a write that failed inside the move (a full cohort) reports that nothing changed", async () => {
  reset({ data: null, error: { code: "P0001", message: "This cohort is full." } });
  const res = await moveToCohort(STUDENT, "winter");
  assert.equal(res.ok, false);
  assert.equal((res as any).error, "Couldn't move them to Winter, so nothing was changed: This cohort is full.");
  assert.ok(!state.calls.some((c) => c.startsWith("audit:") || c.startsWith("notify:")));
});

test("before 0103 runs, the move is refused plainly instead of falling back to the old writes", async () => {
  reset({
    data: null,
    error: { code: "PGRST202", message: "Could not find the function public.admin_move_student_cohort(p_from_cohort_id, p_to_cohort_id, p_user_id) in the schema cache" },
  });
  const res = await moveToCohort(STUDENT, "winter");
  assert.equal(res.ok, false);
  assert.match((res as any).error, /needs database migration 0103/);
  assert.deepEqual(state.writes, []);
  assert.ok(!state.calls.some((c) => c.startsWith("notify:")));
});

test("an unrecognised answer is never taken for success", async () => {
  reset({ data: { moved: true }, error: null });
  const res = await moveToCohort(STUDENT, "winter");
  assert.equal(res.ok, false);
  assert.ok(!state.calls.some((c) => c.startsWith("notify:")));
});

test("picking no cohort is refused before anything runs", async () => {
  reset({ data: null, error: null });
  assert.deepEqual(await moveToCohort(STUDENT, ""), { ok: false, error: "Pick a cohort." });
  assert.ok(!state.calls.some((c) => c.startsWith("rpc:")));
});
