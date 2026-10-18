import test from "node:test";
import assert from "node:assert/strict";
import * as nodeModule from "node:module";
import { pathToFileURL, fileURLToPath } from "node:url";
import path from "node:path";

// Run with `npm test`. The real inviteStudentsByEmail (app/dashboard/team/
// actions.ts) against an in-memory double of the five tables it reads: each
// address gets its own answer in its own words, one failure doesn't stop the
// rest, a database fault is logged rather than shown raw, and an address is
// matched literally — a LIKE pattern pasted into the box finds nobody. No
// network.

type Profile = { id: string; email: string; role: string };
const state = {
  profiles: [] as Profile[],
  enrolled: new Set<string>(),
  onTeam: new Set<string>(),
  brokenUpsertFor: null as string | null,
  brokenProfiles: false,
  rateLimited: false,
  lookups: 0,
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
    { id: "john", email: "john@school.edu", role: "student" },
  ];
  state.enrolled = new Set(["me", "ada", "bob", "cy", "john"]);
  state.onTeam = new Set(["me"]);
  state.brokenUpsertFor = null;
  state.brokenProfiles = false;
  state.rateLimited = false;
  state.lookups = 0;
  state.invited = [];
  state.logged = [];
}
reset();
console.error = (...args: unknown[]) => void state.logged.push(args);

/**
 * Postgres ILIKE as PostgREST hands it over: `*` is `%`, `%` and `_` are
 * wildcards, and a backslash makes the next character literal.
 */
function ilike(value: string, pattern: string): boolean {
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "\\" && i + 1 < pattern.length) re += pattern[++i].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    else if (c === "%" || c === "*") re += ".*";
    else if (c === "_") re += ".";
    else re += c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`, "i").test(value);
}

const db = {
  from(table: string) {
    const f: Record<string, unknown> = {};
    let like: { col: string; pattern: string } | null = null;
    let op: "select" | "upsert" = "select";
    let payload: any = null;
    let head = false;
    let single = false;
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
          if (state.brokenProfiles) return { data: null, error: { message: "upstream request timeout" } };
          if (!single) {
            // The by-email lookup: a list (limit 2), never maybeSingle.
            state.lookups++;
            const rows = state.profiles.filter((r) =>
              like ? ilike(r.email, like.pattern) : r.email === f.email,
            );
            return { data: rows.slice(0, 2), error: null };
          }
          return { data: state.profiles.find((r) => r.id === f.id) ?? null, error: null };
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
    chain.ilike = (k: string, v: string) => { like = { col: k, pattern: v }; return chain; };
    for (const m of ["limit", "order"]) chain[m] = () => chain;
    for (const m of ["maybeSingle", "single"]) chain[m] = () => { single = true; return chain; };
    chain.upsert = (v: any) => { op = "upsert"; payload = v; return chain; };
    return chain;
  },
};
const rateLimit = async () => ({ ok: !state.rateLimited, count: 0, limit: 20 });
(globalThis as any).__teamInviteTest = { db, rateLimit };
const root = fileURLToPath(new URL("../", import.meta.url));
const fake = (source: string) => `data:text/javascript,${encodeURIComponent(source)}`;
(nodeModule as any).registerHooks({
  resolve(specifier: string, context: any, next: any) {
    const g = "const t=globalThis.__teamInviteTest;";
    const doubles: Record<string, string> = {
      "@/lib/supabase/admin": g + "export const createAdminClient=()=>t.db;",
      "@/lib/server-guards": "export const assertSelf=async()=>({userId:'me'});",
      "@/lib/notifications": "export const notify=async()=>{};",
      "@/lib/rate-limit": g + "export const checkRateLimit=(a)=>t.rateLimit(a);",
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
const actions = await import("../app/dashboard/team/actions.ts");
const { inviteStudentsByEmail } = actions;
const { NO_STUDENT_ACCOUNT } = await import("./team-invites.ts");

test("each address gets its own answer, and one refusal doesn't stop the rest", async () => {
  reset();
  const result = await inviteStudentsByEmail({
    teamId: "t1",
    emails: "Ada@school.edu\nnobody@school.edu, mentor@batch0.org; bob@school.edu, me@school.edu",
  });
  assert.ok(result.ok);
  assert.deepEqual(result.data!.results, [
    { email: "ada@school.edu", ok: true },
    { email: "nobody@school.edu", ok: false, error: NO_STUDENT_ACCOUNT },
    // A staff account reads exactly like no account: the box can't be used
    // to find out which addresses belong to the batch0 team.
    { email: "mentor@batch0.org", ok: false, error: NO_STUDENT_ACCOUNT },
    { email: "bob@school.edu", ok: true },
  ]);
  // Four at most per send: the fifth waits rather than vanishing.
  assert.deepEqual(result.data!.overflow, ["me@school.edu"]);
  assert.deepEqual(state.invited, ["ada", "bob"]);
  assert.deepEqual(state.logged, [], "refusals aren't errors");
});

test("a pasted LIKE pattern matches nobody: no account lookup by wildcard", async () => {
  reset();
  // Each of these used to reach ilike() raw: `%@batch0.org` hit the mentor
  // (and said "You can only invite students."), `jo_n@school.edu` invited
  // john, `a*@school.edu` matched ada.
  const result = await inviteStudentsByEmail({
    teamId: "t1",
    emails: "%@batch0.org, jo_n@school.edu, a*@school.edu, ___@school.edu",
  });
  assert.ok(result.ok);
  assert.deepEqual(
    result.data!.results.map((r) => [r.email, r.ok ? "invited" : r.error]),
    [
      ["%@batch0.org", NO_STUDENT_ACCOUNT],
      ["jo_n@school.edu", NO_STUDENT_ACCOUNT],
      ["a*@school.edu", NO_STUDENT_ACCOUNT],
      ["___@school.edu", NO_STUDENT_ACCOUNT],
    ],
  );
  assert.deepEqual(state.invited, [], "nobody gets an invite meant for a pattern");
  // The literal address still matches, case-insensitively.
  const exact = await inviteStudentsByEmail({ teamId: "t1", emails: "JOHN@school.edu" });
  assert.deepEqual(exact.ok && exact.data!.results, [{ email: "john@school.edu", ok: true }]);
  assert.deepEqual(state.invited, ["john"]);
});

test("too many lookups in a few minutes: told to wait, nothing looked up", async () => {
  reset();
  state.rateLimited = true;
  const result = await inviteStudentsByEmail({ teamId: "t1", emails: "ada@school.edu, bob@school.edu" });
  assert.ok(result.ok);
  for (const r of result.data!.results) {
    assert.equal(r.ok, false);
    assert.match((r as { error: string }).error, /a lot of invites/);
  }
  assert.equal(state.lookups, 0);
  assert.deepEqual(state.invited, []);
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

test("a failed account lookup is a logged fault, never 'no account found'", async () => {
  reset();
  state.brokenProfiles = true;
  const result = await inviteStudentsByEmail({ teamId: "t1", emails: "ada@school.edu" });
  assert.ok(result.ok);
  assert.deepEqual(result.data!.results, [
    { email: "ada@school.edu", ok: false, error: "Couldn't send that invite. Try again." },
  ]);
  assert.equal(state.logged.length, 1);
  assert.match(String((state.logged[0][1] as Error).message), /upstream request timeout/);
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

test("the single-address lookup is no longer an endpoint of its own", () => {
  // Every export of a "use server" file can be called directly; the per-
  // address helper is reached only through the paste, after its team check.
  assert.equal("inviteStudentByEmail" in actions, false);
});
