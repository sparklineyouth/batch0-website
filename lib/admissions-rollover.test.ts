import test from "node:test";
import assert from "node:assert/strict";
import { cohortEligibility, selectAdmissionCohort } from "./cohort-eligibility.ts";
import { resolveApplicationCohort, applyStage } from "./reapply.ts";
import { isEligibleForApp } from "./app-eligibility.ts";

const fall = { id: "fall", name: "Fall 2026", status: "active", starts_on: "2026-09-14", ends_on: "2026-11-13", late_entry_until: "2026-09-30T23:59:59.999-04:00", catch_up_plan: "Review Week 1 with the team.", capacity: 24 };
const winter = { id: "winter", name: "Winter 2026", status: "upcoming", starts_on: "2026-12-14", ends_on: "2027-02-12", applications_close_at: "2026-12-13T23:59:59.999-05:00", capacity: 24 };
const before = new Date("2026-10-01T03:59:59.999Z");
const after = new Date("2026-10-01T04:00:00.000Z");

test("Fall remains joinable for the entire September 30 Eastern evening and Winter wins at midnight despite Fall's pin", () => {
  assert.equal(cohortEligibility(fall, before).mode, "late_entry");
  assert.equal(cohortEligibility(fall, after).eligible, false);
  assert.equal(selectAdmissionCohort([winter, fall], "fall", before)?.id, "fall");
  assert.equal(selectAdmissionCohort([fall, winter], "fall", after)?.id, "winter");
  assert.equal(fall.status, "active", "admissions rollover must not complete the ongoing course");
});
test("full or closed cohorts cannot override the next eligible intake", () => {
  assert.equal(selectAdmissionCohort([fall, winter], "fall", before, c => c.id === "fall" ? 24 : 0)?.id, "winter");
  assert.equal(selectAdmissionCohort([fall], "fall", after), null);
});
test("new applicants default to Winter, but old explicit URLs and drafts need a deliberate choice", () => {
  assert.deepEqual(resolveApplicationCohort([winter], null, null, "fall"), { cohortId: "winter", unavailableCohortId: null });
  for (const [requested, draft] of [["fall", null], [null, "fall"], ["fall", "fall"], ["unknown", null]]) {
    assert.equal(resolveApplicationCohort([winter], requested, draft, "fall").cohortId, null);
  }
  assert.deepEqual(resolveApplicationCohort([winter], "winter", "fall", "fall"), { cohortId: "winter", unavailableCohortId: null });
});
test("rollover does not unlock existing applications or revoke enrolled access", () => {
  for (const status of ["submitted", "accepted", "paid", "enrolled"]) assert.equal(applyStage(status), "locked");
  assert.equal(isEligibleForApp({ enrolled: true, applicationStatus: "enrolled", staff: false }), true);
});
