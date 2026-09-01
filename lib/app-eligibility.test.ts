import { test } from "node:test";
import assert from "node:assert/strict";
import { isEligibleForApp, APP_ELIGIBLE_STATUSES } from "./app-eligibility.ts";
import type { ApplicationStatus } from "./types.ts";

// Run with `npm test`. No framework, no transpile step — Node strips the types
// natively, which is why lib/app-eligibility.ts is kept import-free.
//
// This is an access rule, so the point of these tests is the NEGATIVE cases.
// A gate that lets the right people in is obvious the first time anyone opens
// the app; a gate that quietly lets the wrong people in is invisible until it
// matters.

const ALL_STATUSES: ApplicationStatus[] = [
  "draft",
  "submitted",
  "accepted",
  "waitlisted",
  "rejected",
  "paid",
  "enrolled",
  "withdrawn",
];

function viewer(over: Partial<Parameters<typeof isEligibleForApp>[0]> = {}) {
  return {
    enrolled: false,
    applicationStatus: null as ApplicationStatus | null,
    staff: false,
    ...over,
  };
}

// ---------- who is let in ----------

test("a student with a live application gets in", () => {
  for (const status of ["submitted", "waitlisted", "accepted", "paid", "enrolled"] as const) {
    assert.equal(
      isEligibleForApp(viewer({ applicationStatus: status })),
      true,
      `${status} should be eligible`,
    );
  }
});

test("enrollment alone is enough, whatever the application says", () => {
  // An admin can enroll someone directly, and a fee waiver moves a student to
  // enrolled by a different path. Someone holding a seat must never be locked
  // out of the app because their paperwork took an unusual route.
  for (const status of ALL_STATUSES) {
    assert.equal(
      isEligibleForApp(viewer({ enrolled: true, applicationStatus: status })),
      true,
      `enrolled + ${status} should be eligible`,
    );
  }
  assert.equal(isEligibleForApp(viewer({ enrolled: true })), true);
});

test("staff get in with no application and no enrollment", () => {
  // The admin side of the app lives under the same /app URL, so staff have to
  // pass this gate to reach it at all.
  assert.equal(isEligibleForApp(viewer({ staff: true })), true);
});

// ---------- who is kept out ----------

test("an account with no application is kept out", () => {
  // Signed up, never applied. There is nothing in the app for them.
  assert.equal(isEligibleForApp(viewer()), false);
});

test("an unsubmitted draft is kept out", () => {
  // "Applied" means submitted. A draft's next step is /apply, not the app.
  assert.equal(isEligibleForApp(viewer({ applicationStatus: "draft" })), false);
});

test("closed applications are kept out", () => {
  assert.equal(isEligibleForApp(viewer({ applicationStatus: "rejected" })), false);
  assert.equal(isEligibleForApp(viewer({ applicationStatus: "withdrawn" })), false);
});

// ---------- the catalog itself ----------

test("every status is deliberately classified", () => {
  // Guards the case that actually bites: a new application status is added to
  // the union and silently defaults to "kept out" (or, if the set were ever
  // inverted, to "let in") because nobody revisited this file. If this fails,
  // decide where the new status belongs rather than editing the expectation.
  const expectedIn = new Set(["submitted", "waitlisted", "accepted", "paid", "enrolled"]);
  const expectedOut = new Set(["draft", "rejected", "withdrawn"]);
  for (const status of ALL_STATUSES) {
    const inSet = APP_ELIGIBLE_STATUSES.has(status);
    assert.equal(
      inSet,
      expectedIn.has(status),
      `${status} is ${inSet ? "in" : "out of"} APP_ELIGIBLE_STATUSES, unexpectedly`,
    );
    assert.equal(
      inSet || expectedOut.has(status),
      true,
      `${status} is not classified in this test — classify it`,
    );
  }
});
