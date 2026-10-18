import test from "node:test";
import assert from "node:assert/strict";
import { capabilitiesFrom } from "./permissions.ts";
import {
  LAST_FULL_ADMIN,
  SELF_ROLE_CHANGE,
  adminPowersOf,
  isFullAccessRole,
  isLastFullAdminError,
  planRoleChange,
  roleAssignRefusal,
  roleChangeLock,
  type RoleDef,
} from "./role-change.ts";

const roles: RoleDef[] = [
  { slug: "student", label: "Student", permissions: ["student.dashboard"] },
  { slug: "admin", label: "Admin", permissions: ["*"] },
  { slug: "mentor", label: "Mentor", permissions: ["mentor.panel", "calls.invite"] },
  // A delegated role manager: may assign roles, holds nothing else much.
  { slug: "manager", label: "Manager", permissions: ["people.view", "people.roles", "student.dashboard", "mentor.panel", "calls.invite"] },
  { slug: "finance", label: "Finance", permissions: ["payments.view", "payments.manage"] },
  { slug: "investor", label: "Investor", permissions: ["investor.panel", "calls.invite"] },
  { slug: "intern", label: "Intern", permissions: ["applications.view", "people.view"] },
  // A realistic delegate: staff, so no student.dashboard (permissions.ts says
  // to grant it only to roles that take part in the programme).
  { slug: "ops", label: "Ops", permissions: ["people.view", "people.roles", "applications.view", "mentor.panel", "calls.invite"] },
];

const admin = { userId: "admin-1", caps: capabilitiesFrom("admin", ["*"]) };
const manager = {
  userId: "manager-1",
  caps: capabilitiesFrom("manager", roles.find((r) => r.slug === "manager")!.permissions),
};
const ops = {
  userId: "ops-1",
  caps: capabilitiesFrom("ops", roles.find((r) => r.slug === "ops")!.permissions),
};

test("a full admin can't change their own role (the email form used to let them)", () => {
  assert.equal(roleChangeLock(admin, { id: "admin-1", role: "admin" }, roles), SELF_ROLE_CHANGE);
  const plan = planRoleChange({
    actor: admin,
    roles,
    targets: [{ id: "admin-1", role: "admin" }],
    nextRole: "student",
    fullAdminIds: ["admin-1"],
  });
  assert.deepEqual(plan.change, []);
  assert.equal(plan.skipped[0].reason, SELF_ROLE_CHANGE);
});

test("a delegated role manager can't demote a full admin", () => {
  assert.match(roleChangeLock(manager, { id: "admin-1", role: "admin" }, roles)!, /Only a full admin/);
  const plan = planRoleChange({
    actor: manager,
    roles,
    targets: [{ id: "admin-1", role: "admin" }],
    nextRole: "student",
    fullAdminIds: ["admin-1"],
  });
  assert.equal(plan.error, null);
  assert.deepEqual(plan.change, []);
  assert.match(plan.skipped[0].reason, /Only a full admin/);
});

test("nor change anyone whose current role holds admin powers theirs doesn't", () => {
  const lock = roleChangeLock(manager, { id: "fin-1", role: "finance" }, roles);
  assert.match(lock!, /"Finance": it holds admin permissions you don't have/);
  assert.match(roleChangeLock(ops, { id: "fin-1", role: "finance" }, roles)!, /"Finance"/);
  assert.match(roleChangeLock(ops, { id: "admin-1", role: "admin" }, roles)!, /Only a full admin/);
});

// Review of PR #346: rule 3 compared every key, and the Student role holds
// student.dashboard, which staff roles don't. A delegate without it was locked
// out of every Student row: badge instead of picker, bulk "0 updated", and a
// refusal from the email form.
test("a delegate without student.dashboard can still promote a Student", () => {
  assert.equal(roleChangeLock(ops, { id: "s1", role: "student" }, roles), null);
  for (const nextRole of ["mentor", "intern"]) {
    const plan = planRoleChange({
      actor: ops,
      roles,
      targets: [{ id: "s1", role: "student" }, { id: "s2", role: "student" }],
      nextRole,
      fullAdminIds: null,
    });
    assert.deepEqual(plan, {
      error: null,
      change: [{ id: "s1", role: "student" }, { id: "s2", role: "student" }],
      skipped: [],
    });
  }
});

test("panel keys the delegate lacks don't lock a target; handing them out still needs them", () => {
  // investor.panel is a panel key, so an investor can be moved to a role the
  // delegate covers…
  assert.equal(roleChangeLock(ops, { id: "i1", role: "investor" }, roles), null);
  const plan = planRoleChange({ actor: ops, roles, targets: [{ id: "i1", role: "investor" }], nextRole: "mentor", fullAdminIds: null });
  assert.deepEqual(plan.change.map((t) => t.id), ["i1"]);
  // …but rule 2 still stops the delegate making anyone an investor or a
  // student, because they hold neither key.
  assert.match(roleAssignRefusal(ops, "investor", roles)!, /can't assign "Investor"/);
  assert.match(roleAssignRefusal(ops, "student", roles)!, /can't assign "Student"/);
});

test("adminPowersOf keeps the wildcard and admin-area keys only", () => {
  assert.deepEqual(adminPowersOf(["*"]), ["*"]);
  assert.deepEqual(adminPowersOf(["student.dashboard", "mentor.panel", "investor.panel", "calls.invite", "calls.join_any"]), []);
  assert.deepEqual(adminPowersOf(["people.view", "student.dashboard", "payments.manage", "retired.key"]), ["people.view", "payments.manage"]);
});

test("a delegated manager can still re-role people within their own reach", () => {
  const plan = planRoleChange({
    actor: manager,
    roles,
    targets: [{ id: "s1", role: "student" }],
    nextRole: "mentor",
    fullAdminIds: null,
  });
  assert.deepEqual(plan, { error: null, change: [{ id: "s1", role: "student" }], skipped: [] });
});

test("the destination rule still holds: nobody hands out what they don't have", () => {
  assert.match(roleAssignRefusal(manager, "admin", roles)!, /can't assign "Admin"/);
  assert.match(roleAssignRefusal(manager, "nope", roles)!, /isn't a role/);
  assert.equal(roleAssignRefusal(admin, "finance", roles), null);
  const plan = planRoleChange({ actor: manager, roles, targets: [{ id: "s1", role: "student" }], nextRole: "admin", fullAdminIds: null });
  assert.match(plan.error!, /can't assign "Admin"/);
  assert.deepEqual(plan.change, []);
});

test("a bulk change by a delegate skips the full admin and changes the rest", () => {
  const plan = planRoleChange({
    actor: manager,
    roles,
    targets: [
      { id: "s1", role: "student" },
      { id: "admin-1", role: "admin" },
      { id: "manager-1", role: "manager" },
      { id: "m1", role: "mentor" },
    ],
    nextRole: "mentor",
    fullAdminIds: ["admin-1"],
  });
  assert.deepEqual(plan.change.map((t) => t.id), ["s1"]);
  assert.deepEqual(
    plan.skipped.map((s) => s.id),
    ["admin-1", "manager-1", "m1"],
  );
  assert.match(plan.skipped.find((s) => s.id === "m1")!.reason, /already hold/);
});

test("a full admin can demote another full admin while one remains", () => {
  const plan = planRoleChange({
    actor: admin,
    roles,
    targets: [{ id: "admin-2", role: "admin" }],
    nextRole: "student",
    fullAdminIds: ["admin-1", "admin-2"],
  });
  assert.deepEqual(plan.change.map((t) => t.id), ["admin-2"]);
});

test("a change that would leave nobody with full access is refused before the write", () => {
  // The actor's standing is stale: they still read as a full admin, but the
  // database says admin-2 is the only one left.
  const plan = planRoleChange({
    actor: admin,
    roles,
    targets: [{ id: "admin-2", role: "admin" }, { id: "s1", role: "student" }],
    nextRole: "mentor",
    fullAdminIds: ["admin-2"],
  });
  assert.deepEqual(plan.change.map((t) => t.id), ["s1"]);
  assert.deepEqual(plan.skipped, [{ id: "admin-2", reason: LAST_FULL_ADMIN }]);
  // Not knowing who else holds full access fails closed.
  const unknown = planRoleChange({
    actor: admin,
    roles,
    targets: [{ id: "admin-2", role: "admin" }],
    nextRole: "student",
    fullAdminIds: null,
  });
  assert.deepEqual(unknown.change, []);
});

test("moving a full admin to another full-access role keeps full access", () => {
  const withOwner: RoleDef[] = [...roles, { slug: "owner", label: "Owner", permissions: ["*"] }];
  const plan = planRoleChange({
    actor: admin,
    roles: withOwner,
    targets: [{ id: "admin-2", role: "admin" }],
    nextRole: "owner",
    fullAdminIds: ["admin-2"],
  });
  assert.deepEqual(plan.change.map((t) => t.id), ["admin-2"]);
});

test("a profile on a deleted role holds nothing, so anyone with people.roles can fix it", () => {
  assert.equal(roleChangeLock(manager, { id: "x", role: "gone" }, roles), null);
});

test("helpers", () => {
  assert.equal(isFullAccessRole(roles[1]), true);
  assert.equal(isFullAccessRole(roles[0]), false);
  assert.equal(isFullAccessRole(null), false);
  assert.equal(isLastFullAdminError("batch0 needs at least one full admin, and this would leave none."), true);
  assert.equal(isLastFullAdminError("duplicate key"), false);
  assert.equal(isLastFullAdminError(undefined), false);
});
