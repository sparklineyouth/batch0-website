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

const db = {
  from(table: string) {
    assert.equal(table, "profiles");
    let op: "select" | "update" = "select";
    let value: any;
    let returning = false;
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
        filters.push((r) => r[k].toLowerCase() === v.toLowerCase());
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
      return { data: single ? rows[0] ?? null : rows, error: null };
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

// The actions log their refusals; the assertions below are what matter.
mock.method(console, "error", () => {});

const { changeUserRole, bulkChangeUserRole } = await import("../app/admin/students/actions.ts");
const { grantRoleByEmail } = await import("../app/admin/roles/actions.ts");

function reset(profiles: Profile[], actor: Actor) {
  state.profiles = profiles.map((p) => ({ ...p }));
  state.actor = actor;
  state.audit = [];
  state.updates = 0;
  state.beforeUpdate = null;
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
