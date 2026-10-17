import test from "node:test";
import assert from "node:assert/strict";
import * as nodeModule from "node:module";
import { pathToFileURL, fileURLToPath } from "node:url";
import path from "node:path";

// Run with `npm test`. The real inviteStudentsByEmail (app/dashboard/team/
// actions.ts) against an in-memory double of the five tables it reads: each
// address gets its own answer in its own words, one failure doesn't stop the
// rest, and a database fault is logged rather than shown raw. No network.

type Profile = { id: string; email: string; role: string };
const state = {
  profiles: [] as Profile[],
  enrolled: new Set<string>(),
  onTeam: new Set<string>(),
  brokenUpsertFor: null as string | null,
  invited: [] as string[],
  logged: [] as unknown[][],
};
function reset() {
  state.profiles = [
    { id: "me", email: "me@school.edu", role: "student" },
    { id: "ada", email: "ada@school.edu", role: "student" },
    { id: "bob", email: "bob@school.edu", role: "student" },
    { id: "mentor", email: "mentor@batch0.org", role: "mentor" },
    { id: "cy", email: "cy@school.edu", role: "student" },
  ];
  state.enrolled = new Set(["me", "ada", "bob", "cy"]);
  state.onTeam = new Set(["me"]);
  state.brokenUpsertFor = null;
  state.invited = [];
  state.logged = [];
}
reset();
console.error = (...args: unknown[]) => void state.logged.push(args);

const db = {
  from(table: string) {
    const f: Record<string, unknown> = {};
    let op: "select" | "upsert" = "select";
    let payload: any = null;
    let head = false;
    const result = () => {
      if (op === "upsert") {
        if (payload.invitee_id === state.brokenUpsertFor) return { data: null, error: { message: "connection reset" } };
        state.invited.push(payload.invitee_id);
        return { data: null, error: null };
      }
      switch (table) {
        case "team_members":
          if (head) return { count: 1, error: null };
          if (f.team_id && f.user_id) return { data: f.user_id === "me" ? { id: "m1", role: "founder" } : null, error: null };
          return { data: state.onTeam.has(f.user_id as string) ? { id: "x" } : null, error: null };
        case "profiles": {
          const p = f.email
            ? state.profiles.find((r) => r.email === String(f.email).toLowerCase())
            : state.profiles.find((r) => r.id === f.id);
          return { data: p ?? null, error: null };
        }
        case "teams":
          return { data: { cohort_id: "fall", name: "Rocket" }, error: null };
        case "enrollments":
          return { data: state.enrolled.has(f.user_id as string) ? { id: "e" } : null, error: null };
      }
      throw new Error(`unexpected table ${table}`);
    };
    const chain: any = { then: (ok: any, no: any) => Promise.resolve().then(result).then(ok, no) };
    chain.select = (_cols?: string, opts?: { head?: boolean }) => { head = !!opts?.head; return chain; };
    chain.eq = (k: string, v: unknown) => { f[k] = v; return chain; };
    chain.ilike = (k: string, v: unknown) => { f[k] = v; return chain; };
    for (const m of ["limit", "order", "maybeSingle", "single"]) chain[m] = () => chain;
    chain.upsert = (v: any) => { op = "upsert"; payload = v; return chain; };
    return chain;
  },
};
(globalThis as any).__teamInviteTest = { db };
const root = fileURLToPath(new URL("../", import.meta.url));
const fake = (source: string) => `data:text/javascript,${encodeURIComponent(source)}`;
(nodeModule as any).registerHooks({
  resolve(specifier: string, context: any, next: any) {
    const g = "const t=globalThis.__teamInviteTest;";
    const doubles: Record<string, string> = {
      "@/lib/supabase/admin": g + "export const createAdminClient=()=>t.db;",
      "@/lib/server-guards": "export const assertSelf=async()=>({userId:'me'});",
      "@/lib/notifications": "export const notify=async()=>{};",
      "@/lib/team": "export const reserveTeamSlug=async()=>'x';export const slugify=s=>s;",
      "next/cache": "export const revalidatePath=()=>{};",
      "next/navigation": "export const unstable_rethrow=()=>{};",
    };
    if (doubles[specifier]) return { url: fake(doubles[specifier]), shortCircuit: true };
    if (specifier.startsWith("@/")) {
      return next(pathToFileURL(path.join(root, specifier.slice(2) + ".ts")).href, context);
    }
    return next(specifier, context);
  },
});
const { inviteStudentsByEmail } = await import("../app/dashboard/team/actions.ts");

test("each address gets its own answer, and one refusal doesn't stop the rest", async () => {
  reset();
  const result = await inviteStudentsByEmail({
    teamId: "t1",
    emails: "Ada@school.edu\nnobody@school.edu, mentor@batch0.org; bob@school.edu, me@school.edu",
  });
  assert.ok(result.ok);
  assert.deepEqual(result.data!.results, [
    { email: "ada@school.edu", ok: true },
    {
      email: "nobody@school.edu",
      ok: false,
      error: "No batch0 account found for that email. Ask them to sign up first, then send the invite.",
    },
    { email: "mentor@batch0.org", ok: false, error: "You can only invite students." },
    { email: "bob@school.edu", ok: true },
  ]);
  // Four at most per send: the fifth waits rather than vanishing.
  assert.deepEqual(result.data!.overflow, ["me@school.edu"]);
  assert.deepEqual(state.invited, ["ada", "bob"]);
  assert.deepEqual(state.logged, [], "refusals aren't errors");
});

test("a database fault is logged and reported generically, not as raw SQL", async () => {
  reset();
  state.brokenUpsertFor = "cy";
  const result = await inviteStudentsByEmail({ teamId: "t1", emails: "cy@school.edu, ada@school.edu" });
  assert.ok(result.ok);
  assert.deepEqual(result.data!.results, [
    { email: "cy@school.edu", ok: false, error: "Couldn't send that invite. Try again." },
    { email: "ada@school.edu", ok: true },
  ]);
  assert.equal(state.logged.length, 1);
  assert.equal(state.logged[0][0], "[team] invite by email failed");
});

test("nothing usable pasted is answered inline", async () => {
  reset();
  assert.deepEqual(await inviteStudentsByEmail({ teamId: "t1", emails: "ada@school" }), {
    ok: false,
    error: "ada@school doesn't look like a valid email.",
  });
  assert.deepEqual(await inviteStudentsByEmail({ teamId: "t1", emails: "  " }), {
    ok: false,
    error: "Add their batch0 email.",
  });
  assert.deepEqual(state.invited, []);
});
