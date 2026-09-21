import test from "node:test";
import assert from "node:assert/strict";
import { cohortEligibility, type AdmissionCohort } from "./cohort-eligibility.ts";
import { createPayerToken, hashPayerToken, isPayerToken, payerLinkExpiresAt } from "./payer-token.ts";
const fall: AdmissionCohort = { status: "active", starts_on: "2026-09-14", ends_on: "2026-11-13", applications_close_at: "2026-09-13T23:59:59-04:00", late_entry_until: "2026-09-22T23:59:59-04:00", catch_up_plan: "Review week one and attend catch-up.", capacity: 16 };
test("late enrollment remains available through the advertised Eastern evening, not UTC midnight", () => {
  assert.equal(cohortEligibility(fall, new Date("2026-09-23T03:59:58Z"), 15).mode, "late_entry");
  assert.equal(cohortEligibility(fall, new Date("2026-09-23T04:00:00Z"), 15).eligible, false);
});
test("the first cohort day requires explicit late-entry authorization and catch-up", () => {
  assert.equal(cohortEligibility({ ...fall, late_entry_until: null }, new Date("2026-09-14T04:00:00Z")).eligible, false);
  assert.equal(cohortEligibility({ ...fall, catch_up_plan: "  " }, new Date("2026-09-20T12:00:00Z")).eligible, false);
});
test("upcoming application deadline, exhausted capacity, completed status and ended cohort all fail closed", () => {
  assert.equal(cohortEligibility(fall, new Date("2026-09-20T12:00:00Z"), 16).mode, "full");
  assert.equal(cohortEligibility({ ...fall, status: "completed" }, new Date("2026-09-20T12:00:00Z")).eligible, false);
  assert.equal(cohortEligibility({ ...fall, late_entry_until: "2027-01-01T00:00:00Z" }, new Date("2026-11-14T05:00:00Z")).eligible, false);
  assert.equal(cohortEligibility({ ...fall, starts_on: "2026-12-14", applications_close_at: "2026-12-01T23:59:59-05:00" }, new Date("2026-12-02T05:00:00Z")).eligible, false);
});
test("payer invitation is an opaque 256-bit token; persisted hash is domain separated", () => {
  const first = createPayerToken(); const second = createPayerToken();
  assert.equal(first.length, 43); assert.notEqual(first, second); assert.ok(isPayerToken(first));
  assert.match(hashPayerToken(first), /^[a-f0-9]{64}$/);
  assert.notEqual(hashPayerToken(first), hashPayerToken(second));
  for (const bad of [null, "", first + "x", "../../etc/passwd", "?token=" + first, 12]) assert.equal(isPayerToken(bad), false);
  assert.throws(() => hashPayerToken("bad"));
});
test("payer invitations expire within 24 hours and never outlive admissions", () => {
  const now = new Date("2026-09-22T20:00:00Z");
  assert.equal(payerLinkExpiresAt(now, fall.late_entry_until!).toISOString(), "2026-09-23T03:59:59.000Z");
  assert.equal(payerLinkExpiresAt(now, null).toISOString(), "2026-09-23T20:00:00.000Z");
});
