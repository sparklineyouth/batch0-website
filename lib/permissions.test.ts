import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ADMIN_AREA_PERMISSIONS,
  ALL_PERMISSIONS,
  PERMISSION_BY_KEY,
  PERMISSION_GROUPS,
  canAccessAdmin,
  canViewAdminPath,
  capabilitiesFrom,
  can,
  canMeet,
  emailLandingFor,
  isKnownPermission,
  PERMISSION_NEEDS,
  rolesHolding,
  unmetPermissionNeed,
} from "./permissions.ts";

// Run with `npm test`.
//
// These guard the derivation that decides who gets into /admin. `canAccessAdmin`
// is "holds ANY admin-area permission", and admin-area is computed by
// subtracting a hand-maintained list of non-admin permissions from the whole
// catalog. That means the DEFAULT for a newly added permission is "this opens
// the admin panel" — a footgun that is invisible at the call site and only
// shows up as a mentor wandering into the payments page.

const NON_ADMIN = [
  "mentor.panel",
  "investor.panel",
  "student.dashboard",
  "calls.invite",
  "calls.join_any",
] as const;

test("the non-admin capabilities do not grant admin-area access", () => {
  for (const perm of NON_ADMIN) {
    const caps = capabilitiesFrom("custom", [perm]);
    assert.equal(
      canAccessAdmin(caps),
      false,
      `${perm} alone must not open /admin`,
    );
  }
});

test("calls.invite does not open the admin area", () => {
  // Called out on its own because migration 0059 grants it to the mentor and
  // investor roles. If it ever lands in ADMIN_AREA_PERMISSIONS, both roles
  // gain the entire admin panel the moment that migration runs.
  const mentor = capabilitiesFrom("mentor", ["mentor.panel", "calls.invite"]);
  assert.equal(canAccessAdmin(mentor), false);
  assert.equal(canViewAdminPath(mentor, "/admin/payments"), false);
  assert.equal(canViewAdminPath(mentor, "/admin/calls"), false);
  // …but they DO hold the capability itself, which is what /mentor/calls checks.
  assert.equal(can(mentor, "calls.invite"), true);
});

test("calls.join_any is its own grant: admins hold it, booking calls does not imply it", () => {
  // Joining someone else's 1:1 with a minor is the safeguarding power, not the
  // booking one. Admins have it through the wildcard and nobody else does
  // until it is ticked for them at /admin/roles: no migration grants it.
  const admin = capabilitiesFrom("admin", ["*"]);
  assert.equal(can(admin, "calls.join_any"), true);

  const mentor = capabilitiesFrom("mentor", ["mentor.panel", "calls.invite"]);
  assert.equal(can(mentor, "calls.join_any"), false);

  // The seeded roles, as 0048 + 0059 leave them: only the wildcard holds it.
  const seeded = [
    { slug: "student", permissions: ["student.dashboard"] },
    { slug: "admin", permissions: ["*"] },
    { slug: "mentor", permissions: ["mentor.panel", "calls.invite"] },
    { slug: "investor", permissions: ["investor.panel", "calls.invite"] },
  ];
  assert.deepEqual(rolesHolding(seeded, "calls.join_any"), ["admin"]);
});

test("calls.join_any never opens the admin area, even next to calls.invite", () => {
  // Admin-area access is more than a sidebar — it makes /mentor/students
  // program-wide. Granting "Join any 1:1 call" to mentors must not widen what
  // they can read about students they don't mentor.
  const lead = capabilitiesFrom("lead-mentor", [
    "mentor.panel",
    "calls.invite",
    "calls.join_any",
  ]);
  assert.equal(canAccessAdmin(lead), false);
  assert.equal(canViewAdminPath(lead, "/admin/calls"), false);
  assert.equal(can(lead, "calls.join_any"), true);

  // With admin-area access from elsewhere, it is usable where it lives.
  const safeguarding = capabilitiesFrom("safeguarding", [
    "people.view",
    "calls.invite",
    "calls.join_any",
  ]);
  assert.equal(canViewAdminPath(safeguarding, "/admin/calls"), true);
});

test("calls.join_any sits beside calls.invite at /admin/roles, flagged sensitive", () => {
  const group = PERMISSION_GROUPS.find((g) =>
    g.permissions.some((p) => p.key === "calls.invite"),
  );
  assert.ok(group, "calls.invite is in a group");
  const def = group.permissions.find((p) => p.key === "calls.join_any");
  assert.ok(def, "calls.join_any is in the same group as calls.invite");
  assert.equal(def.sensitive, true);
  assert.equal(def.label, "Join any 1:1 call");
});

test("an admin-area permission does open the admin area", () => {
  const caps = capabilitiesFrom("ops", ["payments.view"]);
  assert.equal(canAccessAdmin(caps), true);
  assert.equal(canViewAdminPath(caps, "/admin/payments"), true);
  // …but only the page it names.
  assert.equal(canViewAdminPath(caps, "/admin/roles"), false);
});

test("the wildcard reaches every admin route", () => {
  const caps = capabilitiesFrom("admin", ["*"]);
  assert.equal(canAccessAdmin(caps), true);
  for (const path of ["/admin", "/admin/calls", "/admin/roles", "/admin/payments"]) {
    assert.equal(canViewAdminPath(caps, path), true, path);
  }
});

test("both scholarship keys are admin-area, so neither may be granted to mentor", () => {
  // Migration 0071 deliberately grants nothing. This pins why: either key on
  // its own opens the whole admin panel, so the obvious-looking "let mentors
  // see a student's scholarship credits" grant would also hand every mentor
  // the payments page and the audit log. Same shape as the calls.invite
  // near-miss above — except calls.invite was caught by being listed in
  // NON_ADMIN, and these two must NOT be, because they really do gate
  // /admin/scholarships.
  for (const perm of ["scholarships.view", "scholarships.manage"] as const) {
    const caps = capabilitiesFrom("custom", [perm]);
    assert.equal(canAccessAdmin(caps), true, `${perm} is an admin-area key`);
  }

  // The route itself opens on `view`, exactly like /admin/payments opens on
  // payments.view rather than payments.manage. `manage` is a write key: it
  // makes the award and refund buttons work, and is meant to be held
  // alongside `view`, not instead of it.
  const awarder = capabilitiesFrom("custom", ["scholarships.manage"]);
  assert.equal(canViewAdminPath(awarder, "/admin/scholarships"), false);

  // A read-only reviewer reaches the scholarship area and nothing else.
  const reviewer = capabilitiesFrom("reviewer", ["scholarships.view"]);
  assert.equal(canViewAdminPath(reviewer, "/admin/scholarships"), true);
  assert.equal(canViewAdminPath(reviewer, "/admin/scholarships/applications"), true);
  assert.equal(canViewAdminPath(reviewer, "/admin/payments"), false);
  assert.equal(canViewAdminPath(reviewer, "/admin/roles"), false);
  // Reading the queue must not imply being able to award or refund.
  assert.equal(can(reviewer, "scholarships.manage"), false);
});

test("the Email landing opens on any email key; each tab keeps its own", () => {
  // The sidebar has one Email row pointing at /admin/email, which forwards to
  // the first tab the viewer holds. A templates-only role must reach it…
  const writer = capabilitiesFrom("writer", ["email.templates"]);
  assert.equal(canViewAdminPath(writer, "/admin/email"), true);
  assert.equal(canViewAdminPath(writer, "/admin/email/templates"), true);
  // …without the landing widening any tab.
  assert.equal(canViewAdminPath(writer, "/admin/email/outbox"), false);
  assert.equal(canViewAdminPath(writer, "/admin/email/blast"), false);
  assert.equal(canViewAdminPath(writer, "/admin/email/settings"), false);
  // No email key, no landing.
  const ops = capabilitiesFrom("ops", ["payments.view"]);
  assert.equal(canViewAdminPath(ops, "/admin/email"), false);
});

test("the Email landing forwards to the first tab the viewer holds", () => {
  assert.equal(emailLandingFor(capabilitiesFrom("admin", ["*"])), "/admin/email/templates");
  assert.equal(emailLandingFor(capabilitiesFrom("w", ["email.templates"])), "/admin/email/templates");
  assert.equal(emailLandingFor(capabilitiesFrom("s", ["email.send"])), "/admin/email/blast");
  assert.equal(emailLandingFor(capabilitiesFrom("v", ["email.view", "email.settings"])), "/admin/email/outbox");
  assert.equal(emailLandingFor(capabilitiesFrom("o", ["payments.view"])), null);
  assert.equal(emailLandingFor(null), null);
  // Every tab the landing can pick is a page the viewer may open.
  for (const key of ["email.view", "email.send", "email.templates", "email.automate", "email.settings"] as const) {
    const caps = capabilitiesFrom("one", [key]);
    const landing = emailLandingFor(caps);
    assert.ok(landing && canViewAdminPath(caps, landing), `${key} → ${landing}`);
  }
});

test("canMeet: one key, or any of a list", () => {
  const caps = capabilitiesFrom("custom", ["email.send"]);
  assert.equal(canMeet(caps, "email.send"), true);
  assert.equal(canMeet(caps, "email.view"), false);
  assert.equal(canMeet(caps, ["email.view", "email.send"]), true);
  assert.equal(canMeet(caps, ["email.view"]), false);
  assert.equal(canMeet(capabilitiesFrom("admin", ["*"]), ["email.view"]), true);
  assert.equal(canMeet(null, ["email.send"]), false);
});

test("a key that needs a companion is refused without it", () => {
  // "Add a person" is a button on the People directory, so people.manage
  // alone opens /admin/students/new with no way to navigate there.
  assert.deepEqual(unmetPermissionNeed(["people.manage"]), ["people.manage", "people.view"]);
  assert.equal(unmetPermissionNeed(["people.manage", "people.view"]), null);
  assert.equal(unmetPermissionNeed(["people.view"]), null);
  assert.equal(unmetPermissionNeed(["*", "not.a.key"]), null);
  // Every pair names real keys.
  for (const [key, needs] of Object.entries(PERMISSION_NEEDS)) {
    assert.ok(isKnownPermission(key) && isKnownPermission(needs!), `${key} → ${needs}`);
  }
  const manager = capabilitiesFrom("m", ["people.manage", "people.view"]);
  assert.equal(canViewAdminPath(manager, "/admin/students"), true);
  assert.equal(canViewAdminPath(manager, "/admin/students/new"), true);
});

test("retired keys are gone from the catalog", () => {
  // Migration 0100 strips 'ai_usage.view' from stored roles; a stale string
  // would make missingPermissions block non-superadmins from editing a role.
  assert.equal(isKnownPermission("ai_usage.view"), false);
});

test("a signed-out viewer reaches nothing", () => {
  assert.equal(canAccessAdmin(null), false);
  assert.equal(canViewAdminPath(null, "/admin"), false);
});

test("every permission is renderable at /admin/roles", () => {
  // A key missing from PERMISSION_GROUPS is a permission nobody can grant —
  // the module warns in dev, but a warning in a log is not a test.
  const missing = ALL_PERMISSIONS.filter((k) => !PERMISSION_BY_KEY.has(k));
  assert.deepEqual(missing, []);
});

test("admin-area permissions are exactly the catalog minus the non-admin set", () => {
  const expected = ALL_PERMISSIONS.filter(
    (p) => !(NON_ADMIN as readonly string[]).includes(p),
  );
  assert.deepEqual([...ADMIN_AREA_PERMISSIONS], expected);
});

test("rolesHolding picks roles by what they may do, not by their name", () => {
  const roles = [
    { slug: "student", permissions: ["student.dashboard"] },
    { slug: "admin", permissions: ["*"] },
    // calls.invite taken off investors in /admin/roles...
    { slug: "mentor", permissions: ["mentor.panel", "calls.invite"] },
    { slug: "investor", permissions: ["investor.panel"] },
    // ...and handed to a custom role.
    { slug: "partner", permissions: ["calls.invite"] },
    { slug: "broken", permissions: null },
  ];
  assert.deepEqual(rolesHolding(roles, "calls.invite"), ["admin", "mentor", "partner"]);
  assert.deepEqual(rolesHolding([], "calls.invite"), []);
});
