import test from "node:test";
import assert from "node:assert/strict";
import * as nodeModule from "node:module";
import { pathToFileURL, fileURLToPath } from "node:url";
import path from "node:path";
import { readFileSync } from "node:fs";

// The real reads behind two attention sources — loadFeedbackQueue
// (lib/assignments-server.ts) and the follow-up reads
// (lib/student-followups-server.ts) — against a scripted stand-in for
// supabase-js. What they must get right is the difference between "not set
// up" (0093/0107 not applied: say nothing) and "couldn't load" (a timeout, a
// 5xx, a names read that errored: say so). lib/attention-server.test.ts
// covers what the providers do with each.

type Reply = { data?: any; error?: any; count?: number | null };
type Ops = [string, any[]][];
const script: { reply: (table: string, ops: Ops) => Reply; calls: { table: string; ops: Ops }[] } = {
  reply: () => ({ data: [], error: null, count: 0 }),
  calls: [],
};

/** Every builder method records itself and returns the chain; awaiting it asks `script`. */
const db = {
  from(table: string) {
    const ops: Ops = [];
    const chain: any = new Proxy(
      {},
      {
        get(_t, prop: string) {
          if (prop === "then") {
            return (ok: any, bad: any) => {
              script.calls.push({ table, ops });
              const r = script.reply(table, ops);
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
(globalThis as any).__reads = { db };

const root = fileURLToPath(new URL("../", import.meta.url));
const fake = (source: string) => `data:text/javascript,${encodeURIComponent(source)}`;
(nodeModule as any).registerHooks({
  resolve(specifier: string, context: any, next: any) {
    const doubles: Record<string, string> = {
      "server-only": "export {};",
      "@/lib/supabase/admin": "export const createAdminClient=()=>globalThis.__reads.db;",
      "@/lib/roles": "export const getAllRoles=async()=>[{slug:'admin',permissions:['*']}];",
    };
    if (doubles[specifier]) return { url: fake(doubles[specifier]), shortCircuit: true };
    if (specifier.startsWith("@/")) return next(pathToFileURL(path.join(root, specifier.slice(2) + ".ts")).href, context);
    return next(specifier, context);
  },
});
const { listDueFollowUps, listActiveFollowUps, getFollowUpThread, listFollowUpOwners, getFollowUpOwner } = await import(
  "./student-followups-server.ts"
);
const { loadFeedbackQueue, loadCohortBoard } = await import("./assignments-server.ts");

const MISSING = { code: "PGRST205", message: "Could not find the table 'public.student_followups' in the schema cache" };
const TIMEOUT = { code: "57014", message: "canceling statement due to statement timeout" };
const BAD_GATEWAY = { code: "", message: "Bad gateway" };
const STUDENT = "00000000-0000-4000-8000-0000000000a1";
const OWNER = "00000000-0000-4000-8000-0000000000b2";

const row = {
  id: "f1",
  student_id: STUDENT,
  owner_id: OWNER,
  next_check_on: "2026-10-15",
  note: "Missed weeks 3 and 4; emailed Tuesday.",
  status: "open",
  closing_note: null,
  created_by: OWNER,
  updated_by: OWNER,
  closed_by: null,
  closed_at: null,
  created_at: "2026-10-01T12:00:00.000Z",
  updated_at: "2026-10-01T12:00:00.000Z",
};
const people = [
  { id: STUDENT, full_name: "Ada Lovelace", email: "ada@example.com" },
  { id: OWNER, full_name: "Sam Rivera", email: "sam@example.com" },
];

function quiet<T>(run: () => Promise<T>): Promise<T> {
  // The reads log real failures; keep the test output to the assertions.
  const original = console.error;
  console.error = () => {};
  return run().finally(() => {
    console.error = original;
  });
}

test("due follow-ups: a missing table is 'not set up', anything else is 'failed'", async () => {
  script.reply = (t) => (t === "student_followups" ? { error: MISSING } : {});
  assert.deepEqual(await quiet(() => listDueFollowUps({ today: "2026-10-17", limit: 8 })), {
    ready: false,
    failed: false,
    total: 0,
    rows: [],
  });
  for (const error of [TIMEOUT, BAD_GATEWAY]) {
    script.reply = (t) => (t === "student_followups" ? { error } : {});
    const r = await quiet(() => listDueFollowUps({ today: "2026-10-17", limit: 8 }));
    assert.deepEqual(r, { ready: false, failed: true, total: 0, rows: [] }, error.message);
  }
});

test("due follow-ups: a failed names read fails the read, rather than calling a live student 'Deleted account'", async () => {
  script.reply = (t) => (t === "student_followups" ? { data: [row], count: 1 } : { error: TIMEOUT });
  const r = await quiet(() => listDueFollowUps({ today: "2026-10-17", limit: 8 }));
  assert.equal(r.ready, false);
  assert.equal(r.failed, true);
  assert.deepEqual(r.rows, []);
});

test("due follow-ups: read fine, names resolved, the count is the table's", async () => {
  script.calls = [];
  script.reply = (t) => (t === "student_followups" ? { data: [row], count: 3 } : { data: people });
  const r = await listDueFollowUps({ today: "2026-10-17", limit: 8 });
  assert.equal(r.ready, true);
  assert.equal(r.failed, false);
  assert.equal(r.total, 3);
  assert.deepEqual(
    r.rows.map((v) => [v.studentName, v.ownerName, v.nextCheckOn]),
    [["Ada Lovelace", "Sam Rivera", "2026-10-15"]],
  );
  const q = script.calls.find((c) => c.table === "student_followups")!.ops;
  assert.deepEqual(q.find(([m]) => m === "lte"), ["lte", ["next_check_on", "2026-10-17"]]);
  assert.deepEqual(q.find(([m]) => m === "eq"), ["eq", ["status", "open"]]);
});

test("the roster column and the drawer tell the two failures apart the same way", async () => {
  script.reply = () => ({ error: MISSING });
  assert.deepEqual(
    await quiet(async () => {
      const r = await listActiveFollowUps([]);
      return { ready: r.ready, failed: r.failed };
    }),
    { ready: false, failed: false },
  );
  script.reply = () => ({ error: TIMEOUT });
  const active = await quiet(() => listActiveFollowUps([STUDENT]));
  assert.equal(active.ready, false);
  assert.equal(active.failed, true);
  const thread = await quiet(() => getFollowUpThread(STUDENT));
  assert.deepEqual(
    { ready: thread.ready, failed: thread.failed, active: thread.active, history: thread.history },
    { ready: false, failed: true, active: null, history: [] },
  );
});

test("the owner list throws when it can't be read, instead of saying nobody can own a follow-up", async () => {
  script.reply = () => ({ error: TIMEOUT });
  await assert.rejects(() => quiet(() => listFollowUpOwners()), /Couldn't load who can own follow-ups/);
  script.reply = () => ({ data: people });
  assert.deepEqual(
    (await listFollowUpOwners()).map((o: { name: string }) => o.name),
    ["Ada Lovelace", "Sam Rivera"],
  );
});

test("the owner list pages past a thousand people, in a stable order, rather than stopping short", async () => {
  // It used to stop at 300: whoever sorted after that was missing from the
  // drawer, and a save naming them was refused.
  const everyone = Array.from({ length: 1234 }, (_, i) => ({
    id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
    full_name: `Staff ${String(i).padStart(4, "0")}`,
    email: null,
  }));
  script.calls = [];
  script.reply = (t, ops) => {
    if (t !== "profiles") return {};
    const [from, to] = ops.find(([m]) => m === "range")![1];
    return { data: everyone.slice(from, to + 1) };
  };
  const owners = await listFollowUpOwners();
  assert.equal(owners.length, 1234);
  assert.equal(owners.at(-1)!.name, "Staff 1233");
  const reads = script.calls.filter((c) => c.table === "profiles");
  assert.deepEqual(reads.map((c) => c.ops.find(([m]) => m === "range")![1]), [[0, 999], [1000, 1999]]);
  for (const r of reads) {
    assert.deepEqual(r.ops.filter(([m]) => m === "order").map(([, a]) => a[0]), ["full_name", "id"], "a tiebreak for paging");
  }
});

test("a save's owner is checked by id: one row, the same role rule, and a failed read throws", async () => {
  script.calls = [];
  script.reply = (t) => (t === "profiles" ? { data: { id: OWNER, full_name: "Sam Rivera", email: "sam@example.com", role: "admin" } } : {});
  assert.deepEqual(await getFollowUpOwner(OWNER), { id: OWNER, name: "Sam Rivera" });
  assert.deepEqual(script.calls[0].ops.find(([m]) => m === "eq"), ["eq", ["id", OWNER]]);
  // A role that can't change follow-ups (the doubles' only owner role is admin).
  script.reply = (t) => (t === "profiles" ? { data: { id: STUDENT, full_name: "Ada", email: null, role: "student" } } : {});
  assert.equal(await getFollowUpOwner(STUDENT), null);
  script.reply = () => ({ data: null });
  assert.equal(await getFollowUpOwner(OWNER), null);
  script.reply = () => ({ error: TIMEOUT });
  await assert.rejects(() => quiet(() => getFollowUpOwner(OWNER)), /Couldn't check who can own follow-ups/);
});

test("cohort board: 'not set up' only for a missing table; any read that fails is 'failed', never an answer", async () => {
  const assignment = { id: "a1", status: "published", opens_at: null, due_at: "2026-10-10T03:59:00.000Z", audience: "cohort" };
  const ok = (t: string): Reply =>
    t === "course_assignments"
      ? { data: [assignment] }
      : t === "enrollments"
        ? { data: [{ user_id: STUDENT, enrolled_at: "2026-09-01T00:00:00.000Z", profile: people[0] }] }
        : { data: [] };
  script.reply = (t) => (t === "course_assignments" ? { error: { code: "42P01", message: 'relation "course_assignments" does not exist' } } : ok(t));
  const missing = await quiet(() => loadCohortBoard(db as any, "c1"));
  assert.deepEqual({ ready: missing.ready, failed: missing.failed }, { ready: false, failed: false });
  // Each read, failing on its own. A failed enrollments read used to come
  // back as a board with nobody in it; a failed submissions read, as
  // everyone missing everything.
  for (const broken of ["course_assignments", "enrollments", "course_assignment_targets", "course_assignment_submissions"]) {
    script.reply = (t) => (t === broken ? { error: TIMEOUT } : ok(t));
    const r = await quiet(() => loadCohortBoard(db as any, "c1"));
    assert.deepEqual({ ready: r.ready, failed: r.failed, rows: r.rows }, { ready: false, failed: true, rows: [] }, broken);
  }
  script.reply = ok;
  const fine = await loadCohortBoard(db as any, "c1");
  assert.deepEqual({ ready: fine.ready, failed: fine.failed, students: fine.students.length }, { ready: true, failed: false, students: 1 });
});

test("a team's Readiness card says 'couldn't load' for a failed board, and the page catches a throw", () => {
  const page = readFileSync(path.join(root, "app/admin/teams/[id]/page.tsx"), "utf8");
  assert.match(page, /loadCohortBoard\(admin, team\.cohort_id\)\.catch\(/);
  assert.match(page, /boardFailed=\{!!board\?\.failed\}/);
  const card = readFileSync(path.join(root, "app/admin/teams/[id]/team-readiness.tsx"), "utf8");
  assert.match(card, /boardFailed \? \(/);
  assert.match(card, /Couldn&apos;t load assignment progress/);
});

test("/admin/assignments: a failed board costs the matrix and the list, not the waiting list or the review drawer", () => {
  const page = readFileSync(path.join(root, "app/admin/assignments/page.tsx"), "utf8");
  // "Not set up" (0093 missing) is the only state that hides the page body.
  assert.match(page, /\{!board\.ready && !board\.failed \? \(\s*<p[^>]*>\s*Assignments aren&apos;t set up yet\./);
  assert.doesNotMatch(page, /\{!board\.ready \? \(/, "no section is gated on ready alone any more");
  // The waiting list sits outside any board gate: its own read, its own failed state.
  const body = page.slice(page.indexOf("{!board.ready && !board.failed ? ("));
  assert.ok(body.indexOf("waiting.failed ?") < body.indexOf("<CompletionMatrix"), "the waiting list renders before, and apart from, the matrix");
  // The matrix is rendered whatever happened, told it failed, so its drawer
  // still opens on ?review=; the assignment list goes.
  assert.match(page, /initialCell=\{initialCell\}\s*failed=\{board\.failed\}/);
  assert.match(page, /\{!board\.failed && \(\s*<section className="mt-10">\s*<h2[^>]*>\s*All assignments/);
  // A throw from the board read becomes the same failed state, not a 500.
  assert.match(page, /loadCohortBoard\(admin, cohort\.id, now\)\.catch\(/);
  assert.match(page, /ready: false, failed: true,/);

  const matrix = readFileSync(path.join(root, "app/admin/assignments/completion-matrix.tsx"), "utf8");
  assert.match(matrix, /failed \? \(\s*<p role="status"[^>]*>\s*Couldn&apos;t load this cohort&apos;s assignments just now\./);
  assert.match(matrix, /\{failed \? null : columns\.length === 0/, "no table and no 'Nobody enrolled yet' for a failed read");
  // The drawer is outside both: a deep link still opens it.
  const drawer = matrix.indexOf("<Drawer open={!!cell}");
  assert.ok(drawer > matrix.indexOf("{failed ? null : columns.length === 0"));
  assert.match(matrix, /if \(initialCell\) setCell\(initialCell\);/);
});

const submission = {
  id: "s1",
  assignment_id: "a1",
  user_id: STUDENT,
  submitted_at: "2026-10-16T10:00:00.000Z",
  late: false,
  assignment: { title: "Weekly update", week: 2, cohort_id: "c1" },
  student: { full_name: "Ada Lovelace", email: "ada@example.com" },
};

test("feedback queue: a missing table is 'not set up', a timeout or a failed scope read is 'failed'", async () => {
  script.reply = (t) => (t === "course_assignment_submissions" ? { error: { code: "42P01", message: 'relation "course_assignment_submissions" does not exist' } } : {});
  assert.deepEqual(await quiet(() => loadFeedbackQueue(db as any, null, { limit: 8 })), {
    ready: false,
    failed: false,
    total: 0,
    items: [],
  });
  script.reply = (t) => (t === "course_assignment_submissions" ? { error: TIMEOUT } : {});
  assert.equal((await quiet(() => loadFeedbackQueue(db as any, null, { limit: 8 }))).failed, true);
  // A mentor's scope is read first (their cohorts' assignments); that failing is a failure too.
  script.reply = (t) => (t === "course_assignments" ? { error: TIMEOUT } : { data: [submission], count: 1 });
  const scoped = await quiet(() => loadFeedbackQueue(db as any, { cohortIds: ["c1"], studentIds: [] }, { limit: 8 }));
  assert.deepEqual({ ready: scoped.ready, failed: scoped.failed }, { ready: false, failed: true });
});

test("feedback queue: read fine, the oldest waiting first and every one counted", async () => {
  script.calls = [];
  script.reply = (t) => (t === "course_assignment_submissions" ? { data: [submission], count: 12 } : {});
  const r = await loadFeedbackQueue(db as any, null, { limit: 8 });
  assert.equal(r.ready, true);
  assert.equal(r.failed, false);
  assert.equal(r.total, 12);
  assert.deepEqual(r.items.map((i) => [i.studentName, i.assignment.title, i.assignment.cohortId]), [["Ada Lovelace", "Weekly update", "c1"]]);
  const q = script.calls.find((c) => c.table === "course_assignment_submissions")!.ops;
  assert.deepEqual(q.find(([m]) => m === "eq"), ["eq", ["status", "submitted"]]);
  assert.deepEqual(q.find(([m]) => m === "order"), ["order", ["submitted_at", { ascending: true }]]);
});
