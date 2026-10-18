import test from "node:test";
import assert from "node:assert/strict";
import * as nodeModule from "node:module";
import { pathToFileURL, fileURLToPath } from "node:url";
import path from "node:path";

// Run with `npm test`. runAction's one job beyond the try/catch: a rule saying
// no reaches the form without becoming a production error, and a real failure
// still does. Then the action behind the "Error: That time is in the past."
// line on /admin/calls, run for real against doubles — no database, no mail.

const logged: unknown[][] = [];
console.error = (...args: unknown[]) => void logged.push(args);

const state = { permissionChecks: 0, dbReads: 0, db: null as unknown };
(globalThis as any).__actionResultTest = state;
const root = fileURLToPath(new URL("../", import.meta.url));
const fake = (source: string) => `data:text/javascript,${encodeURIComponent(source)}`;
(nodeModule as any).registerHooks({
  resolve(specifier: string, context: any, next: any) {
    const g = "const t=globalThis.__actionResultTest;";
    const doubles: Record<string, string> = {
      // Next's predicate, reduced to the one shape these tests throw.
      "next/navigation":
        "export const unstable_rethrow=e=>{if(e&&typeof e.digest==='string'&&e.digest.startsWith('NEXT_REDIRECT'))throw e;};",
      "next/cache": "export const revalidatePath=()=>{};",
      "@/lib/server-guards":
        g + "export const assertPermission=async()=>{t.permissionChecks++;return{userId:'host',role:'admin',caps:{superAdmin:true,permissions:new Set(['*'])}};};export const requireActor=async()=>({userId:'stu',role:'student'});",
      "@/lib/supabase/admin":
        g + "export const createAdminClient=()=>t.db??new Proxy({},{get(){t.dbReads++;throw Error('no database in this test');}});",
      "@/lib/access": "export const getStudentAccess=async()=>({staff:false,enrolled:true,cohortId:'fall'});",
      "@/lib/scholarships":
        "export const callCreditsForUser=async()=>({applicationId:'sch1',cohortId:'fall',window:{open:true,until:null,cohortName:'Fall'},credits:{granted:2,remaining:2}});" +
        "export const loadWindowCohort=async()=>null;",
      "@/lib/interview-requests": "export const listInterviewTeamIds=async()=>[];",
      "@/lib/audit": "export const logAudit=async()=>{throw Error('Unexpected audit');};",
      "@/lib/notifications": "export const notify=async()=>{throw Error('Unexpected notification');};export const notifyMany=notify;",
      "@/lib/email/send": "export const sendEmail=async()=>{throw Error('Unexpected email');};",
      "@/lib/email/templates": "export const Templates={};",
      "@/lib/live-rooms": "export const notifyCallChanged=async()=>{};",
      "@/lib/calls":
        "const no=()=>{throw Error('Unexpected call helper');};export const addCohostRows=no,attachCohosts=no,notifyCohostsAdded=no,readCohostIds=no,refundScholarshipCreditFor=no,resolveCohosts=no,staffCallsHref=no;",
    };
    if (doubles[specifier]) return { url: fake(doubles[specifier]), shortCircuit: true };
    if (specifier.startsWith("@/")) {
      return next(pathToFileURL(path.join(root, specifier.slice(2) + ".ts")).href, context);
    }
    return next(specifier, context);
  },
});
const { runAction, refuse, isRefusal, ActionRefusal } = await import("./action-result.ts");

test("a refusal comes back as the form's error and is not logged", async () => {
  logged.length = 0;
  const result = await runAction({ name: "test" }, async () => refuse("That time is in the past."));
  assert.deepEqual(result, { ok: false, error: "That time is in the past." });
  assert.deepEqual(logged, []);
});

test("a real failure comes back the same way, and is still logged", async () => {
  logged.length = 0;
  const result = await runAction({ name: "test" }, async () => {
    throw new Error("duplicate key value violates unique constraint");
  });
  assert.deepEqual(result, { ok: false, error: "duplicate key value violates unique constraint" });
  assert.equal(logged.length, 1);
  assert.equal(logged[0][0], "[action:test]");
});

test("a redirect is still a redirect, refusal or not", async () => {
  const redirect = Object.assign(new Error("NEXT_REDIRECT"), { digest: "NEXT_REDIRECT;replace;/login;307;" });
  await assert.rejects(runAction({ name: "test" }, async () => { throw redirect; }), redirect);
});

test("a refusal is recognised by its brand, and is still an Error", () => {
  const r = new ActionRefusal("Pick a setting.");
  assert.ok(r instanceof Error);
  assert.equal(isRefusal(r), true);
  // The brand, not the class: a copy from another chunk still counts.
  assert.equal(isRefusal({ refusal: true, message: "x" }), true);
  assert.equal(isRefusal(new Error("x")), false);
  assert.equal(isRefusal({ refusal: "yes", message: "x" }), false);
  assert.equal(isRefusal(null), false);
});

test("booking a 1:1 in the past is answered inline, before any read, and not logged", async () => {
  logged.length = 0;
  const { createInvite } = await import("../app/calls/actions.ts");
  const result = await createInvite({
    inviteeId: "student",
    startsAt: new Date(Date.now() - 24 * 3600_000).toISOString(),
    durationMinutes: 30,
    topic: "",
  });
  assert.deepEqual(result, { ok: false, error: "That time is in the past." });
  assert.equal(state.permissionChecks, 1, "the permission is still checked first");
  assert.equal(state.dbReads, 0);
  assert.deepEqual(logged, []);
});

/** One table, one answer: what `from(table)` resolves to, whatever the chain. */
function oneAnswerDb(answers: Record<string, { data: unknown; error: unknown }>) {
  return {
    from(table: string) {
      const chain: any = {
        then: (ok: any, no: any) => Promise.resolve(answers[table] ?? { data: null, error: null }).then(ok, no),
      };
      for (const m of ["select", "insert", "eq", "maybeSingle", "single", "limit", "order"]) chain[m] = () => chain;
      return chain;
    },
  };
}

test("a failed read behind a refusal is a logged fault, not 'You can only invite students.'", async () => {
  logged.length = 0;
  state.db = oneAnswerDb({ profiles: { data: null, error: { message: "upstream request timeout" } } });
  try {
    const { createInvite } = await import("../app/calls/actions.ts");
    const result = await createInvite({
      inviteeId: "student",
      startsAt: new Date(Date.now() + 24 * 3600_000).toISOString(),
      durationMinutes: 30,
      topic: "",
    });
    assert.equal(result.ok, false);
    assert.notEqual(!result.ok && result.error, "You can only invite students.");
    assert.equal(logged.length, 1, "the fault reaches the error log");
    assert.equal(logged[0][0], "[action:createInvite]");
  } finally {
    state.db = null;
  }
});

test("a scholarship call: only a missing column reads 'not switched on', and even that is logged", async () => {
  const { requestScholarshipCall } = await import("../app/calls/scholarship-call-actions.ts");
  const book = () =>
    requestScholarshipCall({ preferredAt: new Date(Date.now() + 48 * 3600_000).toISOString() });
  try {
    // A foreign-key violation names the column too; it used to be answered
    // "Scholarship calls aren't switched on yet." with no log line at all.
    logged.length = 0;
    state.db = oneAnswerDb({
      interview_requests: {
        data: null,
        error: {
          code: "23503",
          message:
            'insert or update on table "interview_requests" violates foreign key constraint "interview_requests_scholarship_application_id_fkey"',
        },
      },
    });
    const fk = await book();
    assert.equal(fk.ok, false);
    assert.notEqual(!fk.ok && fk.error, "Scholarship calls aren't switched on yet.");
    assert.equal(logged.length, 1);
    assert.equal(logged[0][0], "[action:requestScholarshipCall]");

    // The column itself missing (0071 not run): the student's words, plus a log line.
    logged.length = 0;
    state.db = oneAnswerDb({
      interview_requests: {
        data: null,
        error: { code: "PGRST204", message: "Could not find the 'scholarship_application_id' column of 'interview_requests' in the schema cache" },
      },
    });
    assert.deepEqual(await book(), { ok: false, error: "Scholarship calls aren't switched on yet." });
    assert.equal(logged.length, 1);
    assert.match(String(logged[0][0]), /\[scholarship-call\]/);
  } finally {
    state.db = null;
  }
});
