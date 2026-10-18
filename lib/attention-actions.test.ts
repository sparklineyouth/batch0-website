import test from "node:test";
import assert from "node:assert/strict";
import * as nodeModule from "node:module";
import { pathToFileURL, fileURLToPath } from "node:url";
import path from "node:path";
import { capabilitiesFrom } from "./permissions.ts";

// The server actions behind the follow-up drawer (app/admin/progress/actions.ts)
// and the review drawer an attention row opens (loadReviewCell in
// app/admin/assignments/actions.ts), run for real against a scripted
// stand-in for supabase-js: who may write, who may own, what a stale save
// does, and that handed-in work from a student who has since left the
// cohort can still be opened and reviewed.

type Ops = [string, any[]][];
type Reply = { data?: any; error?: any; count?: number | null };
const ME = "00000000-0000-4000-8000-000000000001";
const ALICE = "00000000-0000-4000-8000-000000000002";
const BOB = "00000000-0000-4000-8000-000000000003";
const STUDENT = "00000000-0000-4000-8000-0000000000a1";
const FOLLOWUP = "00000000-0000-4000-8000-0000000000f1";
const ASSIGNMENT = "00000000-0000-4000-8000-0000000000c1";
const VERSION = "2026-10-10T12:00:00.000Z";

const state: {
  perms: string[];
  owners: { id: string; name: string }[];
  thread: any;
  reply: (table: string, ops: Ops) => Reply;
  calls: { table: string; ops: Ops }[];
  audits: any[];
  revalidated: string[];
} = {
  perms: [],
  owners: [],
  thread: null,
  reply: () => ({}),
  calls: [],
  audits: [],
  revalidated: [],
};

const db = {
  from(table: string) {
    const ops: Ops = [];
    const chain: any = new Proxy(
      {},
      {
        get(_t, prop: string) {
          if (prop === "then") {
            return (ok: any, bad: any) => {
              state.calls.push({ table, ops });
              const r = state.reply(table, ops);
              return Promise.resolve({ data: r.data ?? null, error: r.error ?? null, count: r.count ?? null }).then(ok, bad);
            };
          }
          return (...args: any[]) => {
            ops.push([prop, args]);
            return chain;
          };
        },
      },
    );
    return chain;
  },
};
(globalThis as any).__actions = { db, state, capabilitiesFrom };

const root = fileURLToPath(new URL("../", import.meta.url));
const fake = (source: string) => `data:text/javascript,${encodeURIComponent(source)}`;
(nodeModule as any).registerHooks({
  resolve(specifier: string, context: any, next: any) {
    const g = "const t=globalThis.__actions;";
    const doubles: Record<string, string> = {
      "server-only": "export {};",
      "next/cache": g + "export const revalidatePath=(p)=>{t.state.revalidated.push(p);};",
      "next/navigation": "export const unstable_rethrow=()=>{};",
      "@/lib/supabase/admin": g + "export const createAdminClient=()=>t.db;",
      "@/lib/audit": g + "export const logAudit=async(a)=>{t.state.audits.push(a);};",
      "@/lib/server-guards":
        g +
        `const actor=()=>({userId:'${ME}',role:'custom',caps:t.capabilitiesFrom('custom',t.state.perms)});
         const has=(p)=>t.state.perms.includes(p);
         export const assertPermission=async(p)=>{if(!has(p))throw new Error('Forbidden');return actor();};
         export const assertAllPermissions=async(ps)=>{for(const p of ps)if(!has(p))throw new Error('Forbidden');return actor();};`,
      "@/lib/student-followups-server":
        g +
        `export const listFollowUpOwners=async()=>t.state.owners;
         export const getFollowUpThread=async()=>t.state.thread;`,
    };
    if (doubles[specifier]) return { url: fake(doubles[specifier]), shortCircuit: true };
    if (specifier.startsWith("@/")) return next(pathToFileURL(path.join(root, specifier.slice(2) + ".ts")).href, context);
    return next(specifier, context);
  },
});
const { saveFollowUp, closeFollowUp, loadFollowUp } = await import("../app/admin/progress/actions.ts");
const { loadReviewCell } = await import("../app/admin/assignments/actions.ts");

const quiet = <T,>(run: () => Promise<T>): Promise<T> => {
  // runAction logs every refusal; keep the output to the assertions.
  const original = console.error;
  console.error = () => {};
  return run().finally(() => {
    console.error = original;
  });
};
const writes = () => state.calls.filter((c) => c.ops.some(([m]) => m === "insert" || m === "update" || m === "delete"));
const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date());

function reset(perms: string[] = ["people.view", "people.manage"]) {
  state.perms = perms;
  state.owners = [
    { id: ME, name: "Me" },
    { id: BOB, name: "Bob" },
  ];
  state.thread = { ready: true, failed: false, active: null, history: [] };
  state.calls = [];
  state.audits = [];
  state.revalidated = [];
  state.reply = (table, ops) => {
    if (table === "profiles") return { data: { id: STUDENT, full_name: "Ada", email: "ada@example.com" } };
    if (table === "student_followups" && ops.some(([m]) => m === "insert")) return { data: { id: FOLLOWUP } };
    if (table === "student_followups" && ops.some(([m]) => m === "update")) {
      const at = ops.find(([m, a]) => m === "eq" && a[0] === "updated_at")?.[1][1];
      return { data: at === VERSION ? [{ id: FOLLOWUP, student_id: STUDENT }] : [] };
    }
    return {};
  };
}

const save = (over: Record<string, unknown> = {}) =>
  quiet(() =>
    saveFollowUp({
      studentId: STUDENT,
      followUpId: null,
      expectedUpdatedAt: null,
      ownerId: ME,
      nextCheckOn: today(),
      note: "No weekly update for weeks 3 and 4. Emailed Tuesday.",
      ...over,
    } as any),
  );

test("people.view alone can read a follow-up but not start, change or close one — and nothing is written", async () => {
  reset(["people.view"]);
  assert.deepEqual(await save(), { ok: false, error: "Forbidden" });
  assert.deepEqual(
    await quiet(() => closeFollowUp({ followUpId: FOLLOWUP, expectedUpdatedAt: VERSION })),
    { ok: false, error: "Forbidden" },
  );
  assert.deepEqual(writes(), []);
  assert.equal(state.audits.length, 0);
  const read = await quiet(() => loadFollowUp(STUDENT));
  assert.equal(read.ok, true);
  assert.equal(read.ok && read.data!.canEdit, false);
});

test("an owner must be someone who can update and close it", async () => {
  reset();
  const r = await save({ ownerId: ALICE });
  assert.deepEqual(r, { ok: false, error: "That person can't own follow-ups." });
  assert.deepEqual(writes(), []);
});

test("starting one writes it, audits who and when but not the note, and refreshes the Overview", async () => {
  reset();
  const r = await save({ ownerId: BOB });
  assert.deepEqual(r, { ok: true, data: { id: FOLLOWUP } });
  const insert = writes()[0].ops.find(([m]) => m === "insert")![1][0];
  assert.equal(insert.owner_id, BOB);
  assert.equal(insert.created_by, ME);
  assert.equal(state.audits[0].action, "student.followup_started");
  assert.ok(!JSON.stringify(state.audits[0]).includes("Emailed Tuesday"), "the note stays out of the audit log");
  assert.deepEqual(state.revalidated.sort(), ["/admin", "/admin/progress"]);
});

test("a second open follow-up is refused, naming who already has it", async () => {
  reset();
  const base = state.reply;
  state.reply = (table, ops) => {
    if (table === "student_followups" && ops.some(([m]) => m === "insert")) return { error: { code: "23505", message: "duplicate key" } };
    if (table === "student_followups" && ops.some(([m, a]) => m === "eq" && a[0] === "status")) return { data: { owner_id: BOB } };
    return base(table, ops);
  };
  const r = await save();
  assert.equal(r.ok, false);
  assert.match(!r.ok ? r.error : "", /^Bob already has an open follow-up/);
});

test("a save against a version someone else changed writes nothing and says so", async () => {
  reset();
  const stale = await save({ followUpId: FOLLOWUP, expectedUpdatedAt: "2026-10-09T08:00:00.000Z" });
  assert.equal(stale.ok, false);
  assert.match(!stale.ok ? stale.error : "", /Someone else changed or closed this follow-up/);
  assert.equal(state.audits.length, 0);
  const update = state.calls.find((c) => c.ops.some(([m]) => m === "update"))!.ops;
  // The lock is in the write itself, not a read before it.
  assert.ok(update.some(([m, a]) => m === "eq" && a[0] === "updated_at" && a[1] === "2026-10-09T08:00:00.000Z"));
  assert.ok(update.some(([m, a]) => m === "eq" && a[0] === "status" && a[1] === "open"));

  reset();
  assert.deepEqual(await save({ followUpId: FOLLOWUP, expectedUpdatedAt: VERSION }), { ok: true, data: { id: FOLLOWUP } });
  assert.equal(state.audits[0].action, "student.followup_updated");
});

test("closing is locked to the version it was opened at too", async () => {
  reset();
  const r = await quiet(() => closeFollowUp({ followUpId: FOLLOWUP, expectedUpdatedAt: "2026-10-09T08:00:00.000Z" }));
  assert.equal(r.ok, false);
  reset();
  assert.deepEqual(await quiet(() => closeFollowUp({ followUpId: FOLLOWUP, expectedUpdatedAt: VERSION, closingNote: "Handed in." })), {
    ok: true,
    data: undefined,
  });
  const update = writes()[0].ops.find(([m]) => m === "update")![1][0];
  assert.equal(update.status, "closed");
  assert.equal(update.closed_by, ME);
});

test("the drawer says 'couldn't load' for a failed read, and 'not set up' only when 0107 is missing", async () => {
  reset();
  state.thread = { ready: false, failed: true, active: null, history: [] };
  const failed = await quiet(() => loadFollowUp(STUDENT));
  assert.equal(failed.ok, false);
  assert.match(!failed.ok ? failed.error : "", /Couldn't load this follow-up/);
  state.thread = { ready: false, failed: false, active: null, history: [] };
  const missing = await quiet(() => loadFollowUp(STUDENT));
  assert.equal(missing.ok && missing.data!.ready, false);
});

// ---------------------------------------------------------------------------
// The review drawer an attention row opens
// ---------------------------------------------------------------------------

function reviewDb(opts: { enrolled: boolean; submitted: boolean }) {
  state.reply = (table) => {
    if (table === "course_assignments") {
      return { data: { id: ASSIGNMENT, cohort_id: "c1", title: "Weekly update", week: 2, opens_at: null, due_at: "2026-10-10T03:59:00.000Z" } };
    }
    if (table === "enrollments") return { data: opts.enrolled ? { enrolled_at: "2026-09-01T00:00:00.000Z" } : null };
    if (table === "profiles") return { data: { id: STUDENT, full_name: "Ada", email: "ada@example.com" } };
    if (table === "course_assignment_submissions") {
      return { data: opts.submitted ? { id: "s1", status: "submitted", late: false, body: "Week 2 notes", link_url: null, submitted_at: "2026-10-09T20:00:00.000Z" } : null };
    }
    return {};
  };
}

test("handed-in work from a student who has since left the cohort still opens for review", async () => {
  reset(["assignments.manage"]);
  reviewDb({ enrolled: false, submitted: true });
  const r = await quiet(() => loadReviewCell({ assignmentId: ASSIGNMENT, userId: STUDENT }));
  assert.equal(r.ok, true);
  assert.equal(r.ok && r.data!.enrolled, false);
  assert.equal(r.ok && r.data!.status, "submitted");
  assert.equal(r.ok && r.data!.submission?.id, "s1");

  // Nothing handed in and not in the cohort: there's nothing to open.
  reviewDb({ enrolled: false, submitted: false });
  const none = await quiet(() => loadReviewCell({ assignmentId: ASSIGNMENT, userId: STUDENT }));
  assert.deepEqual(none, { ok: false, error: "That student isn't in this cohort." });

  reviewDb({ enrolled: true, submitted: true });
  const enrolled = await quiet(() => loadReviewCell({ assignmentId: ASSIGNMENT, userId: STUDENT }));
  assert.equal(enrolled.ok && enrolled.data!.enrolled, true);
});

test("the review drawer still needs assignments.manage", async () => {
  reset(["mentor.panel"]);
  reviewDb({ enrolled: true, submitted: true });
  assert.deepEqual(await quiet(() => loadReviewCell({ assignmentId: ASSIGNMENT, userId: STUDENT })), { ok: false, error: "Forbidden" });
});
