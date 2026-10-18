import test, { mock } from "node:test";
import assert from "node:assert/strict";
import * as nodeModule from "node:module";
import { pathToFileURL, fileURLToPath } from "node:url";
import path from "node:path";

// Run the real role-change actions — the email form (grantRoleByEmail), the
// picker (changeUserRole) and the bulk change (bulkChangeUserRole) — against
// an in-memory profiles table, to pin that all three go through one rule
// (lib/role-change.ts). The first cases are the review's reproductions
// (Codex review 2026-10-16 §4), now refused: a sole admin demoting themselves
// through the email form, and a delegated role manager demoting the only full
// admin. The in-memory update also refuses what 0103's trigger refuses, so
// the "the database said no" path is exercised too.

type Profile = { id: string; email: string; full_name: string; role: string };
type Actor = { userId: string; role: string; caps: { role: string; permissions: string[]; superAdmin: boolean } };

const roles = [
  { slug: "student", label: "Student", permissions: ["student.dashboard"] },
  { slug: "admin", label: "Admin", permissions: ["*"] },
  { slug: "mentor", label: "Mentor", permissions: ["mentor.panel"] },
  { slug: "limited", label: "Limited", permissions: ["people.roles", "people.view", "student.dashboard", "mentor.panel"] },
  // A staff delegate as they'd really be set up: no student.dashboard.
  { slug: "ops", label: "Ops", permissions: ["people.roles", "people.view", "applications.view", "mentor.panel"] },
  { slug: "intern", label: "Intern", permissions: ["applications.view", "people.view"] },
];
const full = (r: string) => roles.find((x) => x.slug === r)?.permissions.includes("*") ?? false;
const capsOf = (slug: string) => {
  const permissions = roles.find((r) => r.slug === slug)?.permissions ?? [];
  return { role: slug, permissions, superAdmin: permissions.includes("*") };
};

const state: {
  actor: Actor;
  profiles: Profile[];
  audit: any[];
  updates: number;
  /** Runs just before an update applies: another admin's write landing in between. */
  beforeUpdate: (() => void) | null;
} = { actor: null as any, profiles: [], audit: [], updates: 0, beforeUpdate: null };

function as(id: string, role: string): Actor {
  return { userId: id, role, caps: capsOf(role) };
}

/**
 * Postgres ILIKE as PostgREST hands it over: `*` is `%`, `%` and `_` are
 * wildcards, and a backslash makes the next character literal. The same
 * double as lib/team-invite-actions.test.ts, so a lookup that passes a typed
 * address through unescaped matches here what it would match in production.
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
    assert.equal(table, "profiles");
    let op: "select" | "update" = "select";
    let value: any;
    let returning = false;
    let limit = Infinity;
    const filters: ((r: Profile) => boolean)[] = [];
    const chain: any = {
      select() {
        if (op === "update") returning = true;
        return chain;
      },
      in(k: keyof Profile, v: string[]) {
        filters.push((r) => v.includes(r[k]));
        return chain;
      },
      eq(k: keyof Profile, v: string) {
        filters.push((r) => r[k] === v);
        return chain;
      },
      ilike(k: keyof Profile, v: string) {
        filters.push((r) => ilike(r[k], v));
        return chain;
      },
      limit(n: number) {
        limit = n;
        return chain;
      },
      update(v: any) {
        op = "update";
        value = v;
        return chain;
      },
      maybeSingle: () => run(true),
      then: (a: any, b: any) => run(false).then(a, b),
    };
    async function run(single: boolean) {
      if (op === "update") {
        state.beforeUpdate?.();
        state.beforeUpdate = null;
        const hit = state.profiles.filter((r) => filters.every((f) => f(r)));
        // What 0103's keep_a_full_admin trigger refuses.
        const after = state.profiles.map((r) => (hit.includes(r) ? { ...r, ...value } : r));
        if (!after.some((r) => full(r.role)) && state.profiles.some((r) => full(r.role))) {
          return { data: null, error: { message: "batch0 needs at least one full admin, and this would leave none." } };
        }
        state.updates++;
        for (const r of hit) Object.assign(r, value);
        return { data: returning ? hit.map((r) => ({ id: r.id })) : null, error: null };
      }
      const rows = state.profiles.filter((r) => filters.every((f) => f(r))).map((r) => ({ ...r }));
      if (single && rows.length > 1) {
        return { data: null, error: { message: "JSON object requested, multiple (or no) rows returned" } };
      }
      return { data: single ? rows[0] ?? null : rows.slice(0, limit), error: null };
    }
    return chain;
  },
};
(globalThis as any).__roleChange = { state, db, roles };

const root = fileURLToPath(new URL("../", import.meta.url));
const fake = (source: string) => `data:text/javascript,${encodeURIComponent(source)}`;
(nodeModule as any).registerHooks({
  resolve(specifier: string, context: any, next: any) {
    const g = "const t=globalThis.__roleChange;";
    const doubles: Record<string, string> = {
      "server-only": "export {};",
      "next/cache": "export const revalidatePath=()=>{};",
      // lib/action-result.ts's one import: Next's predicate, reduced to the
      // shape a redirect throws (none of these actions redirect).
      "next/navigation":
        "export const unstable_rethrow=e=>{if(e&&typeof e.digest==='string'&&e.digest.startsWith('NEXT_REDIRECT'))throw e;};",
      "@/lib/supabase/admin": g + "export const createAdminClient=()=>t.db;",
      "@/lib/server-guards":
        g +
        "export const assertPermission=async(p)=>{const a=t.state.actor;if(!a.caps.superAdmin&&!a.caps.permissions.includes(p))throw Error('Forbidden');return a;};",
      "@/lib/roles":
        g +
        "export const getAllRoles=async()=>t.roles;export const getRole=async(s)=>t.roles.find(r=>r.slug===s)??null;",
      "@/lib/audit":
        g +
        "export const logAudit=async(e)=>{t.state.audit.push(e);};export const logAuditMany=async(a,es)=>{for(const e of es)t.state.audit.push({...e,actor:a});};",
      "@/lib/auth": g + "export const getUser=async()=>({id:t.state.actor.userId,email:t.state.actor.userId+'@example.test'});",
    };
    if (doubles[specifier]) return { url: fake(doubles[specifier]), shortCircuit: true };
    if (specifier.startsWith("@/")) return next(pathToFileURL(path.join(root, specifier.slice(2) + ".ts")).href, context);
    return next(specifier, context);
  },
});

// Failures are logged; refusals no longer are (lib/action-result.ts), and
// the email form's cases below count what reached the log.
const errorLog = mock.method(console, "error", () => {});

const { changeUserRole, bulkChangeUserRole } = await import("../app/admin/students/actions.ts");
const { grantRoleByEmail, previewRoleGrant } = await import("../app/admin/roles/actions.ts");

function reset(profiles: Profile[], actor: Actor) {
  state.profiles = profiles.map((p) => ({ ...p }));
  state.actor = actor;
  state.audit = [];
  state.updates = 0;
  state.beforeUpdate = null;
  errorLog.mock.resetCalls();
}
const p = (id: string, role: string): Profile => ({ id, email: `${id}@example.test`, full_name: id, role });
const roleOf = (id: string) => state.profiles.find((r) => r.id === id)?.role;

test("review repro: the sole full admin can no longer demote themselves through the email form", async () => {
  reset([p("actor", "admin")], as("actor", "admin"));
  const res = await grantRoleByEmail("actor@example.test", "student");
  assert.equal(res.ok, false);
  assert.match((res as any).error, /can't change your own role/);
  assert.equal(roleOf("actor"), "admin");
  assert.equal(state.updates, 0);
  assert.deepEqual(state.audit, []);
});

test("review repro: a limited role manager can no longer demote the sole full admin", async () => {
  reset([p("delegate", "limited"), p("only-admin", "admin")], as("delegate", "limited"));
  const res = await changeUserRole("only-admin", "student");
  assert.equal(res.ok, false);
  assert.match((res as any).error, /Only a full admin/);
  assert.equal(roleOf("only-admin"), "admin");
  // …nor through the email form, which used to share none of this code.
  const viaEmail = await grantRoleByEmail("only-admin@example.test", "student");
  assert.equal(viaEmail.ok, false);
  assert.match((viaEmail as any).error, /Only a full admin/);
  assert.equal(state.updates, 0);
});

test("a limited role manager still re-roles people within their reach, audited with their email", async () => {
  reset([p("delegate", "limited"), p("s1", "student")], as("delegate", "limited"));
  assert.deepEqual(await changeUserRole("s1", "mentor"), { ok: true });
  assert.equal(roleOf("s1"), "mentor");
  assert.equal(state.audit.length, 1);
  assert.deepEqual(state.audit[0].payload, { from: "student", to: "mentor", email: "s1@example.test" });
  assert.deepEqual(state.audit[0].actor, { userId: "delegate", email: "delegate@example.test" });
});

// Review of PR #346: a delegate whose role lacks student.dashboard (staff
// roles normally do) was refused on every Student, by every path.
test("a staff delegate without student.dashboard promotes Students by picker, bulk change and email", async () => {
  reset([p("ops-1", "ops"), p("s1", "student"), p("s2", "student"), p("s3", "student"), p("s4", "student")], as("ops-1", "ops"));
  assert.deepEqual(await changeUserRole("s1", "mentor"), { ok: true });
  assert.equal(roleOf("s1"), "mentor");
  assert.deepEqual(await bulkChangeUserRole({ userIds: ["s2", "s3"], role: "intern" }), { succeeded: 2, failed: 0, skipped: 0 });
  assert.equal(roleOf("s2"), "intern");
  assert.equal(roleOf("s3"), "intern");
  const viaEmail = await grantRoleByEmail("s4@example.test", "intern");
  assert.equal(viaEmail.ok, true);
  assert.equal(roleOf("s4"), "intern");
  assert.equal(state.audit.length, 4);
  // Still not a full admin's role, and still not their own.
  reset([p("ops-1", "ops"), p("admin-1", "admin")], as("ops-1", "ops"));
  assert.match((await changeUserRole("admin-1", "intern") as any).error, /Only a full admin/);
  assert.match((await changeUserRole("ops-1", "intern") as any).error, /can't change your own role/);
  assert.equal(state.updates, 0);
});

test("the email form records where the change came from", async () => {
  reset([p("actor", "admin"), p("s1", "student")], as("actor", "admin"));
  const res = await grantRoleByEmail("S1@example.test", "mentor");
  assert.equal(res.ok, true);
  assert.equal(roleOf("s1"), "mentor");
  assert.equal(state.audit[0].payload.via, "roles_page");
});

test("nobody changes their own role, by any path", async () => {
  reset([p("actor", "admin"), p("other-admin", "admin")], as("actor", "admin"));
  const single = await changeUserRole("actor", "student");
  assert.match((single as any).error, /can't change your own role/);
  const bulk = await bulkChangeUserRole({ userIds: ["actor"], role: "student" });
  assert.deepEqual(bulk, { succeeded: 0, failed: 0, skipped: 1 });
  assert.equal(roleOf("actor"), "admin");
});

test("a bulk change by a delegate skips the full admin and changes the rest", async () => {
  reset([p("delegate", "limited"), p("admin-1", "admin"), p("s1", "student"), p("s2", "student")], as("delegate", "limited"));
  const res = await bulkChangeUserRole({ userIds: ["admin-1", "s1", "s2", "delegate"], role: "mentor" });
  assert.deepEqual(res, { succeeded: 2, failed: 0, skipped: 2 });
  assert.equal(roleOf("admin-1"), "admin");
  assert.equal(roleOf("s1"), "mentor");
  assert.equal(roleOf("s2"), "mentor");
  assert.equal(state.audit.length, 2);
});

test("a destination the actor can't hand out fails the whole batch, with the reason", async () => {
  reset([p("delegate", "limited"), p("s1", "student")], as("delegate", "limited"));
  const res = await bulkChangeUserRole({ userIds: ["s1"], role: "admin" });
  assert.equal(res.succeeded, 0);
  assert.match(res.error!, /can't assign "Admin"/);
  assert.equal(state.updates, 0);
});

test("a full admin can demote another full admin while one remains", async () => {
  reset([p("actor", "admin"), p("admin-2", "admin")], as("actor", "admin"));
  assert.deepEqual(await changeUserRole("admin-2", "student"), { ok: true });
  assert.equal(roleOf("admin-2"), "student");
});

test("two admins demoting each other: whoever writes second is refused by the database", async () => {
  // A's request passed every check while B was still an admin; B demoted A
  // first. The trigger is what stops the second write.
  reset([p("a", "admin"), p("b", "admin")], as("b", "admin"));
  state.beforeUpdate = () => {
    state.profiles.find((r) => r.id === "a")!.role = "student";
  };
  const res = await changeUserRole("a", "student");
  // a was already moved by the "other" write, so the compare-and-set misses…
  assert.equal(res.ok, false);
  assert.match((res as any).error, /changed while you were editing/);

  reset([p("a", "admin"), p("b", "admin")], as("a", "admin"));
  state.beforeUpdate = () => {
    state.profiles.find((r) => r.id === "a")!.role = "student";
  };
  // …and a's own demotion of b lands after a lost full access: refused.
  const second = await changeUserRole("b", "student");
  assert.equal(second.ok, false);
  assert.match((second as any).error, /at least one full admin/);
  assert.equal(roleOf("b"), "admin");
});

test("someone promoted in between isn't overwritten by a decision about their old role", async () => {
  reset([p("delegate", "limited"), p("s1", "student")], as("delegate", "limited"));
  state.beforeUpdate = () => {
    state.profiles.find((r) => r.id === "s1")!.role = "admin";
  };
  const res = await bulkChangeUserRole({ userIds: ["s1"], role: "mentor" });
  assert.deepEqual(res, { succeeded: 0, failed: 1, skipped: 0 });
  assert.equal(roleOf("s1"), "admin");
});

test("the permission guard still throws for someone without people.roles", async () => {
  reset([p("intern", "mentor"), p("s1", "student")], as("intern", "mentor"));
  await assert.rejects(changeUserRole("s1", "mentor"), /Forbidden/);
  await assert.rejects(bulkChangeUserRole({ userIds: ["s1"], role: "mentor" }), /Forbidden/);
  assert.equal(roleOf("s1"), "student");
});

// The email form's preview (previewRoleGrant) answers before Assign is
// pressed, from the same reads and the same guard as the write, and writes
// nothing.
test("the email preview names the account and its role, and refuses what the write would", async () => {
  reset([p("delegate", "limited"), p("s1", "student"), p("only-admin", "admin")], as("delegate", "limited"));
  assert.deepEqual(await previewRoleGrant("S1@example.test", "mentor"), {
    ok: true,
    data: { name: "s1", email: "s1@example.test", role: "student", refusal: null },
  });
  const admin = await previewRoleGrant("only-admin@example.test", "student");
  assert.equal(admin.ok, true);
  assert.equal((admin as any).data.role, "admin");
  assert.match((admin as any).data.refusal, /Only a full admin/);
  const self = await previewRoleGrant("delegate@example.test", "mentor");
  assert.match((self as any).data.refusal, /can't change your own role/);
  const up = await previewRoleGrant("s1@example.test", "admin");
  assert.match((up as any).data.refusal, /can't assign "Admin"/);
  // Reads only.
  assert.equal(state.updates, 0);
  assert.deepEqual(state.audit, []);
  assert.equal(roleOf("s1"), "student");
});

test("the email preview's answers for a missing account are refusals, not logged errors", async () => {
  reset([p("actor", "admin"), p("s1", "student")], as("actor", "admin"));
  assert.deepEqual(await previewRoleGrant("nobody@example.test", "mentor"), {
    ok: false,
    error: "No account for nobody@example.test. Ask them to sign up first, then assign the role.",
  });
  assert.deepEqual(await previewRoleGrant("not-an-email", "mentor"), { ok: false, error: "Enter a valid email." });
  const already = await previewRoleGrant("s1@example.test", "student");
  assert.match((already as any).data.refusal, /already holds the Student role/);
  assert.equal(errorLog.mock.callCount(), 0);
});

test("the email form's refusals reach the form without reaching the error log", async () => {
  reset([p("actor", "admin")], as("actor", "admin"));
  const res = await grantRoleByEmail("actor@example.test", "student");
  assert.match((res as any).error, /can't change your own role/);
  const missing = await grantRoleByEmail("nobody@example.test", "student");
  assert.match((missing as any).error, /No account for/);
  assert.equal(errorLog.mock.callCount(), 0);
});

test("the email preview is gated like the write", async () => {
  reset([p("m", "mentor"), p("s1", "student")], as("m", "mentor"));
  assert.deepEqual(await previewRoleGrant("s1@example.test", "mentor"), { ok: false, error: "Forbidden" });
});

// Review of PR #352: accountByEmail passed the typed address to ilike raw, so
// `_` and `%` (and PostgREST's `*`) were wildcards. An address for someone
// not signed up yet matched someone else's account, Assign re-roled that
// person, and the preview, answering as you type, named whoever a pattern hit.
test("the email form matches the address literally: a_b@ never finds aXb@", async () => {
  const dot = { id: "john-dot", email: "john.doe@example.test", full_name: "John Dot", role: "student" };
  reset([p("actor", "admin"), dot], as("actor", "admin"));
  const missing = "No account for john_doe@example.test. Ask them to sign up first, then assign the role.";
  assert.deepEqual(await previewRoleGrant("john_doe@example.test", "mentor"), { ok: false, error: missing });
  assert.deepEqual(await grantRoleByEmail("john_doe@example.test", "mentor"), { ok: false, error: missing });
  assert.equal(roleOf("john-dot"), "student");
  assert.equal(state.updates, 0);
  // The real address still resolves, in any case.
  const exact = await previewRoleGrant("John.Doe@Example.test", "mentor");
  assert.equal(exact.ok, true);
  assert.equal((exact as any).data.name, "John Dot");
  assert.equal(errorLog.mock.callCount(), 0);
});

test("a pattern typed into the email form finds nobody", async () => {
  reset(
    [p("actor", "admin"), p("ada", "student"), p("alan", "mentor"), { id: "star", email: "a*b@example.test", full_name: "Star", role: "student" }],
    as("actor", "admin"),
  );
  for (const probe of ["a%@example.test", "%@example.test", "a*@example.test", "____@example.test", "a\\%@example.test"]) {
    const res = await previewRoleGrant(probe, "mentor");
    assert.equal(res.ok, false, probe);
    assert.match((res as any).error, /^No account for /, probe);
  }
  // `*` is legal in an address and has no escape in PostgREST: matched exactly.
  const star = await previewRoleGrant("a*b@example.test", "mentor");
  assert.equal((star as any).data.name, "Star");
  assert.equal(state.updates, 0);
  assert.deepEqual(state.audit, []);
});

test("two accounts that differ only by case are refused rather than guessed between", async () => {
  reset(
    [
      p("actor", "admin"),
      { id: "lower", email: "sam@example.test", full_name: "Sam", role: "student" },
      { id: "upper", email: "Sam@example.test", full_name: "Sam Again", role: "student" },
    ],
    as("actor", "admin"),
  );
  const res = await grantRoleByEmail("sam@example.test", "mentor");
  assert.equal(res.ok, false);
  assert.match((res as any).error, /More than one account uses sam@example\.test/);
  assert.equal(state.updates, 0);
  // A refusal, not a logged failure (maybeSingle used to throw here).
  assert.equal(errorLog.mock.callCount(), 0);
});
