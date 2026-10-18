import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { capabilitiesFrom } from "./permissions.ts";
import {
  PROFILE_ACTION_PERMISSIONS,
  hasAnyProfileAction,
  profileAccess,
} from "./people-profile-access.ts";

test("a people.view-only viewer sees no finance data and no controls", () => {
  const access = profileAccess(capabilitiesFrom("intern", ["people.view", "applications.view"]));
  assert.equal(access.payments, false);
  assert.equal(access.charges, false);
  assert.equal(access.readPayments, false, "payment rows aren't even fetched");
  assert.equal(access.issueCharge, false);
  assert.equal(hasAnyProfileAction(access), false);
});

test("a finance viewer sees the ledger and fees, and refunds only with payments.manage", () => {
  const viewer = profileAccess(capabilitiesFrom("finance", ["people.view", "payments.view"]));
  assert.equal(viewer.payments, true);
  assert.equal(viewer.charges, true);
  assert.equal(viewer.actions.refund, false);
  const refunder = profileAccess(capabilitiesFrom("finance", ["people.view", "payments.view", "payments.manage"]));
  assert.equal(refunder.actions.refund, true);
  assert.deepEqual(
    { ...refunder.actions, refund: false },
    { passwordReset: false, moveCohort: false, removeFromProgram: false, refund: false, deleteAccount: false },
  );
});

test("a refunder without payments.view reads payments only to know a refund is possible", () => {
  const access = profileAccess(capabilitiesFrom("x", ["people.view", "payments.manage"]));
  assert.equal(access.payments, false);
  assert.equal(access.readPayments, true);
});

test("fees & fines open with charges.manage, which also issues a charge", () => {
  const access = profileAccess(capabilitiesFrom("x", ["people.view", "charges.manage"]));
  assert.equal(access.charges, true);
  assert.equal(access.issueCharge, true);
  assert.equal(access.payments, false);
});

test("people.manage gets the people controls; delete stays full-admin only", () => {
  const manager = profileAccess(capabilitiesFrom("ops", ["people.view", "people.manage"]));
  assert.equal(manager.actions.moveCohort, true);
  assert.equal(manager.actions.passwordReset, true);
  assert.equal(manager.actions.removeFromProgram, true);
  assert.equal(manager.actions.deleteAccount, false);
  const full = profileAccess(capabilitiesFrom("admin", ["*"]));
  assert.ok(Object.values(full.actions).every(Boolean));
  assert.equal(full.payments, true);
});

/**
 * The page shows a control only when this module says so, and the action
 * behind it asserts the same key. Read the action file and check each one
 * still does, so the two can't drift into a button the server refuses (or a
 * hidden button the server would allow).
 */
test("each Manage action asserts exactly the permission the panel shows it for", () => {
  const src = readFileSync(new URL("../app/admin/students/[id]/actions.ts", import.meta.url), "utf8");
  const body = (name: string) => {
    const start = src.indexOf(`export async function ${name}(`);
    assert.ok(start >= 0, `${name} not found`);
    const next = src.indexOf("export async function", start + 1);
    return src.slice(start, next === -1 ? undefined : next);
  };
  const expected: Record<string, keyof typeof PROFILE_ACTION_PERMISSIONS> = {
    sendPasswordResetForUser: "passwordReset",
    moveToCohort: "moveCohort",
    removeFromProgram: "removeFromProgram",
    refundLatestPayment: "refund",
  };
  for (const [fn, key] of Object.entries(expected)) {
    assert.match(body(fn), new RegExp(`assertPermission\\(PROFILE_ACTION_PERMISSIONS\\.${key}\\)`), fn);
  }
  // Delete is the wildcard check, which profileAccess mirrors as superAdmin.
  assert.match(body("deleteUserAccount"), /assertAdmin\(\)/);
});

test("the profile page fetches and renders finance only behind profileAccess", () => {
  const page = readFileSync(new URL("../app/admin/students/[id]/page.tsx", import.meta.url), "utf8");
  assert.match(page, /access\.readPayments\s*\?\s*admin\s*\.from\("payments"\)/);
  assert.match(page, /access\.charges\s*\?\s*admin\s*\.from\("user_charges"\)/);
  assert.match(page, /\{access\.payments && \(\s*<Card[\s\S]*?Payments/);
  assert.match(page, /\{access\.charges && \(\s*<Card[\s\S]*?Fees & fines/);
  assert.match(page, /allowed=\{access\.actions\}/);
  // No unconditional query of either table is left.
  assert.equal((page.match(/\.from\("payments"\)/g) ?? []).length, 1);
  assert.equal((page.match(/\.from\("user_charges"\)/g) ?? []).length, 1);
});
