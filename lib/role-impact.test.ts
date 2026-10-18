import test from "node:test";
import assert from "node:assert/strict";
import { capabilitiesFrom, isKnownPermission, PERMISSION_BY_KEY } from "./permissions.ts";
import { LAST_FULL_ADMIN, SELF_ROLE_CHANGE } from "./role-change.ts";
import {
  EMPTY_ROLE,
  OWN_ROLES_MANAGE,
  PANELS,
  ROUTE_TABLE_PAGES,
  SENSITIVE_NOTE_KEYS,
  adminPagesOpenedBy,
  diffRoleAccess,
  grantedKeys,
  landingFor,
  previewRoleAssignment,
  roleSaveRefusal,
  unmetPermissionNeeds,
  type ImpactRole,
} from "./role-impact.ts";

// Run with `npm test`. The previews at /admin/roles and on People are worked
// out here, from the catalog alone; these pin what they say for the cases the
// review asked about: admin-panel access through a single permission, losing
// finance, the '*' role, and PERMISSION_NEEDS.

const hrefs = (pages: readonly { href: string }[]) => pages.map((p) => p.href);

const roles: ImpactRole[] = [
  { slug: "student", label: "Student", permissions: ["student.dashboard"], home_path: "/dashboard" },
  { slug: "admin", label: "Admin", permissions: ["*"], home_path: "/admin" },
  { slug: "mentor", label: "Mentor", permissions: ["mentor.panel", "calls.invite"], home_path: "/mentor" },
  { slug: "finance", label: "Finance", permissions: ["payments.view", "payments.manage"], home_path: "/admin" },
  { slug: "intern", label: "Intern", permissions: ["applications.view", "people.view"], home_path: "/admin" },
  { slug: "ops", label: "Ops", permissions: ["people.view", "people.roles", "applications.view", "mentor.panel", "calls.invite"], home_path: "/admin" },
];
const admin = { userId: "admin-1", caps: capabilitiesFrom("admin", ["*"]) };
const ops = { userId: "ops-1", caps: capabilitiesFrom("ops", roles.find((r) => r.slug === "ops")!.permissions) };

test("one admin-area key opens the whole admin panel, and 1:1 calls with it", () => {
  // Ticking "Manage the blog" for mentors: the blog, and — because they
  // already hold calls.invite — /admin/calls, which they couldn't open before.
  const diff = diffRoleAccess(["mentor.panel", "calls.invite"], ["mentor.panel", "calls.invite", "blog.manage"]);
  assert.equal(diff.adminArea, "gains");
  assert.deepEqual(diff.adminAreaVia, ["blog.manage"]);
  assert.deepEqual(diff.gained, ["blog.manage"]);
  assert.deepEqual(hrefs(diff.pagesGained), ["/admin/blog", "/admin/calls"]);
  assert.deepEqual(diff.pagesLost, []);
  assert.equal(diff.fullAccess, "none");
  assert.match(diff.notes.join(" "), /widens .* every enrolled student/);
  assert.equal(diff.same, false);
});

test("panel keys alone open no admin page: the mentor role can't open /admin/calls", () => {
  // The "Pages this role can open" card used to list /admin/calls for any
  // role holding calls.invite, admin panel or not.
  assert.deepEqual(adminPagesOpenedBy(["mentor.panel", "calls.invite"]), []);
  assert.deepEqual(adminPagesOpenedBy(["investor.panel", "calls.invite", "calls.join_any"]), []);
  assert.ok(hrefs(adminPagesOpenedBy(["calls.invite", "intros.manage"])).includes("/admin/calls"));
});

test("losing finance: the pages, the sensitive keys, and the admin panel when it was all they had", () => {
  const diff = diffRoleAccess(["payments.view", "payments.manage"], ["student.dashboard"], {
    home: { before: "/admin", after: "/admin" },
  });
  assert.deepEqual(diff.lost, ["payments.view", "payments.manage"]);
  assert.deepEqual(hrefs(diff.pagesLost), ["/admin/payments"]);
  assert.deepEqual(diff.sensitiveLost.map((s) => s.key), ["payments.manage"]);
  assert.match(diff.sensitiveLost[0].why, /^moves money/);
  assert.equal(diff.adminArea, "loses");
  assert.deepEqual(hrefs(diff.panelsGained), ["/dashboard"]);
  // Configured for /admin, which they can no longer reach: they fall back.
  assert.deepEqual(diff.home, { before: "/admin", after: "/dashboard" });

  // Losing one finance key of several keeps the panel.
  const partial = diffRoleAccess(["payments.view", "payments.manage", "people.view"], ["people.view"]);
  assert.equal(partial.adminArea, "keeps");
  assert.deepEqual(hrefs(partial.pagesLost), ["/admin/payments"]);
});

test("the '*' role: every key gained or lost, full access named as such", () => {
  const up = diffRoleAccess(["student.dashboard"], ["*"]);
  assert.equal(up.fullAccess, "gains");
  assert.equal(up.adminArea, "gains");
  // Full access isn't "through" any one key.
  assert.deepEqual(up.adminAreaVia, []);
  assert.equal(up.gained.length, grantedKeys(["*"]).length - 1);
  assert.deepEqual(hrefs(up.pagesGained), hrefs(ROUTE_TABLE_PAGES));
  const sensitive = up.sensitiveGained.map((s) => s.key);
  for (const key of ["chat.manage", "people.roles", "payments.manage", "roles.manage"]) {
    assert.ok(sensitive.includes(key as any), key);
  }
  assert.match(up.sensitiveGained.find((s) => s.key === "chat.manage")!.why, /reported direct messages/);
  assert.deepEqual(hrefs(up.panelsGained), ["/mentor", "/investor"]);

  const down = diffRoleAccess(["*"], ["student.dashboard"]);
  assert.equal(down.fullAccess, "loses");
  assert.equal(down.adminArea, "loses");
  assert.deepEqual(hrefs(down.pagesLost), hrefs(ROUTE_TABLE_PAGES));
  assert.deepEqual(down.gained, []);

  assert.equal(diffRoleAccess(["*"], ["*"]).same, true);
  assert.equal(diffRoleAccess(["*"], ["*"]).fullAccess, "keeps");
});

test("dependencies: every broken PERMISSION_NEEDS pair, and the save refusal in the action's words", () => {
  assert.deepEqual(unmetPermissionNeeds(["sms.send", "people.manage"]), [
    { key: "people.manage", needs: "people.view" },
    { key: "sms.send", needs: "sms.view" },
  ]);
  assert.deepEqual(unmetPermissionNeeds(["sms.send", "sms.view"]), []);
  assert.deepEqual(unmetPermissionNeeds(["*"]), []);
  assert.deepEqual(diffRoleAccess([], ["sms.send"]).unmet, [{ key: "sms.send", needs: "sms.view" }]);

  assert.equal(roleSaveRefusal({ permissions: ["sms.send"] }), `"Send texts" needs "View texting" too.`);
  assert.equal(roleSaveRefusal({ permissions: [] }), EMPTY_ROLE);
  assert.equal(roleSaveRefusal({ permissions: ["sms.send", "sms.view"] }), null);
});

test("the save refusal: nobody strips roles.manage from the role they hold", () => {
  const existing = { slug: "ops-lead", permissions: ["roles.manage", "people.view"] };
  assert.equal(roleSaveRefusal({ permissions: ["people.view"], existing, actorRole: "ops-lead" }), OWN_ROLES_MANAGE);
  // Someone on another role may; so may the holder, keeping it.
  assert.equal(roleSaveRefusal({ permissions: ["people.view"], existing, actorRole: "admin" }), null);
  assert.equal(roleSaveRefusal({ permissions: ["roles.manage"], existing, actorRole: "ops-lead" }), null);
});

test("keys that do nothing as ticked are named; a save still goes through", () => {
  assert.match(diffRoleAccess([], ["support.sensitive", "people.view"]).inert[0].reason, /opens nothing without/);
  assert.deepEqual(diffRoleAccess([], ["support.sensitive", "support.view"]).inert, []);
  // Join any 1:1 call needs calls.invite AND the admin panel.
  assert.equal(diffRoleAccess([], ["mentor.panel", "calls.invite", "calls.join_any"]).inert[0].key, "calls.join_any");
  assert.deepEqual(diffRoleAccess([], ["intros.manage", "calls.invite", "calls.join_any"]).inert, []);
  assert.deepEqual(diffRoleAccess([], ["*"]).inert, []);
});

test("retired keys grant nothing, so they're neither gained nor lost", () => {
  const diff = diffRoleAccess(["pulse.view", "people.view"], ["people.view"]);
  assert.equal(diff.same, true);
  assert.deepEqual(grantedKeys(["pulse.view"]), []);
  assert.equal(diffRoleAccess(["pulse.view"], ["pulse.view"]).opensNothing, true);
});

test("pages carry the labels the caller gives them", () => {
  const pages = [
    { href: "/admin/payments", label: "Payments" },
    { href: "/admin/email/blast", label: "Email · Blast" },
  ];
  const diff = diffRoleAccess(["email.view"], ["email.view", "email.send", "payments.view"], { pages });
  assert.deepEqual(diff.pagesGained, [
    { href: "/admin/payments", label: "Payments" },
    { href: "/admin/email/blast", label: "Email · Blast" },
  ]);
});

test("landing: a configured home the role can't reach falls back", () => {
  assert.equal(landingFor(["mentor.panel"], "/admin"), "/mentor");
  assert.equal(landingFor(["blog.manage"], "/admin"), "/admin");
  assert.equal(landingFor([], null), "/dashboard");
});

test("assigning a person: what they gain and lose next to the role they hold now", () => {
  const p = previewRoleAssignment({ actor: admin, roles, targets: [{ id: "f1", role: "finance" }], nextRole: "intern" });
  assert.equal(p.error, null);
  assert.equal(p.skipped.length, 0);
  assert.equal(p.moves.length, 1);
  const [move] = p.moves;
  assert.deepEqual([move.from, move.fromLabel, move.ids], ["finance", "Finance", ["f1"]]);
  assert.deepEqual(move.diff.lost, ["payments.view", "payments.manage"]);
  assert.deepEqual(move.diff.gained, ["applications.view", "people.view"]);
  assert.equal(move.diff.adminArea, "keeps");
  assert.deepEqual(hrefs(move.diff.pagesLost), ["/admin/payments"]);
});

test("promoting a Student to the '*' role, and a full admin demoting another", () => {
  const up = previewRoleAssignment({ actor: admin, roles, targets: [{ id: "s1", role: "student" }], nextRole: "admin" });
  assert.equal(up.moves[0].diff.fullAccess, "gains");
  assert.deepEqual(up.moves[0].diff.home, { before: "/dashboard", after: "/admin" });

  // The actor stays a full admin (rule 1 keeps them out of the batch), so the
  // preview doesn't claim the last-full-admin refusal.
  const down = previewRoleAssignment({ actor: admin, roles, targets: [{ id: "admin-2", role: "admin" }], nextRole: "student" });
  assert.deepEqual(down.skipped, []);
  assert.equal(down.moves[0].diff.fullAccess, "loses");
});

test("a bulk change: grouped by current role, with the guard's skips explained", () => {
  const p = previewRoleAssignment({
    actor: ops,
    roles,
    targets: [
      { id: "s1", role: "student" },
      { id: "s2", role: "student" },
      { id: "admin-1", role: "admin" },
      { id: "ops-1", role: "ops" },
      { id: "i1", role: "intern" },
      { id: "m1", role: "mentor" },
      { id: "x", role: "gone" },
    ],
    nextRole: "intern",
  });
  assert.equal(p.error, null);
  assert.deepEqual(
    p.moves.map((m) => [m.from, m.ids]),
    [["student", ["s1", "s2"]], ["mentor", ["m1"]], ["gone", ["x"]]],
  );
  assert.equal(p.moves[0].diff.adminArea, "gains");
  assert.deepEqual(hrefs(p.moves[0].diff.panelsLost), ["/dashboard"]);
  // A profile on a deleted role holds nothing: everything is a gain.
  assert.equal(p.moves[2].fromLabel, "gone");
  assert.deepEqual(p.moves[2].diff.lost, []);
  const reasons = Object.fromEntries(p.skipped.map((s) => [s.ids.join(","), s.reason]));
  assert.match(reasons["admin-1"], /Only a full admin/);
  assert.equal(reasons["ops-1"], SELF_ROLE_CHANGE);
  assert.match(reasons["i1"], /already hold the "Intern" role/);
  assert.ok(!p.skipped.some((s) => s.reason === LAST_FULL_ADMIN));
});

test("a destination the actor can't hand out is the preview's error", () => {
  const p = previewRoleAssignment({ actor: ops, roles, targets: [{ id: "s1", role: "student" }], nextRole: "finance" });
  assert.match(p.error!, /can't assign "Finance"/);
  assert.deepEqual(p.moves, []);
  assert.match(
    previewRoleAssignment({ actor: admin, roles, targets: [], nextRole: "nope" }).error!,
    /isn't a role/,
  );
});

test("the catalog bits the preview leans on", () => {
  // Every note is about a key the catalog marks sensitive.
  for (const key of SENSITIVE_NOTE_KEYS) {
    assert.ok(isKnownPermission(key), key);
    assert.equal(PERMISSION_BY_KEY.get(key)?.sensitive, true, key);
  }
  assert.deepEqual(PANELS.map((p) => p.label), ["Student dashboard", "Mentor panel", "Investor panel"]);
  // The default page list is the route table, deduplicated.
  assert.equal(new Set(hrefs(ROUTE_TABLE_PAGES)).size, ROUTE_TABLE_PAGES.length);
  assert.ok(hrefs(ROUTE_TABLE_PAGES).includes("/admin/email"));
});
