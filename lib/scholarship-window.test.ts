import test from "node:test";
import assert from "node:assert/strict";
import {
  NO_COHORT_REASON,
  callTimeProblem,
  cohortIsOver,
  describeCohortWindows,
  resolveScholarshipCohort,
  scholarshipCallWindow,
  scholarshipWindow,
  windowHeadline,
  windowUntilLabel,
  type CohortCandidate,
  type ScholarshipCohort,
  type ScholarshipWindow,
} from "./scholarship-window.ts";

// The two cohorts as they stand in production (read 2026-09-26): Fall is
// running with late entry through Sep 30 Eastern; Winter is upcoming with an
// applications deadline typed as a time, not an end of day.
const FALL: ScholarshipCohort = {
  id: "fall",
  name: "Fall 2026",
  status: "active",
  starts_on: "2026-09-14",
  ends_on: "2026-11-13",
  applications_close_at: "2026-10-01T03:59:59.999+00:00",
  late_entry_until: "2026-10-01T03:59:59.999+00:00",
  catch_up_plan: "Complete the Week 1 field guide, then catch-up with the team.",
};
const WINTER: ScholarshipCohort = {
  id: "winter",
  name: "Winter 2026",
  status: "upcoming",
  starts_on: "2026-12-14",
  ends_on: "2027-02-12",
  applications_close_at: "2026-12-12T23:59:00+00:00",
  late_entry_until: null,
  catch_up_plan: null,
};
const TODAY = new Date("2026-09-26T16:00:00Z");

function open(w: ScholarshipWindow) {
  assert.equal(w.open, true, w.open ? "" : w.reason);
  return w as Extract<ScholarshipWindow, { open: true }>;
}
function closed(w: ScholarshipWindow) {
  assert.equal(w.open, false);
  return w as Extract<ScholarshipWindow, { open: false }>;
}

// --- enrolled: until the cohort ends -----------------------------------------

test("an enrolled Fall student can apply today — the live Learner's Scholarship bug", () => {
  // The scholarship's own closes_at was Sep 20; Fall runs to Nov 13.
  const w = open(scholarshipWindow({ cohort: FALL, stage: "enrolled", awardType: "perks" }, TODAY));
  assert.equal(w.basis, "cohort_end");
  // End of Nov 13 in New York, which is EST (-05:00) by then.
  assert.equal(w.until, "2026-11-14T04:59:59.000Z");
  assert.equal(windowHeadline(w), "Open until Nov 13 — while Fall 2026 runs");
});

test("the enrolled window runs to the last second of the cohort's final Eastern day", () => {
  open(scholarshipWindow({ cohort: FALL, stage: "enrolled" }, new Date("2026-11-14T04:59:58Z")));
  const w = closed(scholarshipWindow({ cohort: FALL, stage: "enrolled" }, new Date("2026-11-14T05:00:00Z")));
  assert.equal(w.reason, "Fall 2026 has ended.");
});

test("an enrolled student in an upcoming cohort is open until that cohort ends", () => {
  const w = open(scholarshipWindow({ cohort: WINTER, stage: "enrolled" }, TODAY));
  assert.equal(w.until, "2027-02-13T04:59:59.000Z");
  assert.equal(w.cohortId, "winter");
});

test("a cohort with no end date on file stays open without claiming a date", () => {
  const w = open(scholarshipWindow({ cohort: { ...FALL, ends_on: null }, stage: "enrolled" }, TODAY));
  assert.equal(w.until, null);
  assert.equal(windowHeadline(w), "Open — while Fall 2026 runs");
});

test("a completed or cancelled cohort is closed at every stage", () => {
  for (const stage of ["accepted", "enrolled"] as const) {
    assert.equal(
      closed(scholarshipWindow({ cohort: { ...FALL, status: "completed" }, stage }, TODAY)).reason,
      "Fall 2026 has ended.",
    );
    assert.equal(
      closed(scholarshipWindow({ cohort: { ...FALL, status: "cancelled" }, stage }, TODAY)).reason,
      "Fall 2026 was cancelled.",
    );
  }
});

// --- accepted: until the enrollment deadline ---------------------------------

test("an accepted student in a running cohort is open through late entry", () => {
  const w = open(scholarshipWindow({ cohort: FALL, stage: "accepted", awardType: "discount" }, TODAY));
  assert.equal(w.basis, "enrollment_deadline");
  assert.equal(w.until, FALL.late_entry_until);
  assert.equal(windowUntilLabel(w.until), "Sep 30");
  assert.match(w.why, /Fall 2026's enrollment deadline, since the award comes off your tuition/);
});

test("an accepted student is closed once the enrollment deadline passes — checkout would refuse them", () => {
  const w = closed(
    scholarshipWindow({ cohort: FALL, stage: "accepted", awardType: "discount" }, new Date("2026-10-01T04:00:00Z")),
  );
  assert.equal(w.basis, "enrollment_deadline");
  assert.match(w.reason, /^Enrollment in Fall 2026 has closed, so there's no checkout left/);
  // Perks-only wording doesn't talk about a checkout.
  assert.equal(
    closed(scholarshipWindow({ cohort: FALL, stage: "accepted", awardType: "perks" }, new Date("2026-10-01T04:00:00Z"))).reason,
    "Enrollment in Fall 2026 has closed.",
  );
});

test("an accepted student in an upcoming cohort is open until its applications deadline, to the minute", () => {
  const w = open(scholarshipWindow({ cohort: WINTER, stage: "accepted" }, TODAY));
  assert.equal(w.until, WINTER.applications_close_at);
  // Typed as a time, not an end of day — shown as one, not rounded up to "Dec 12".
  assert.equal(windowUntilLabel(w.until), "Dec 12, 6:59 PM EST");
  closed(scholarshipWindow({ cohort: WINTER, stage: "accepted" }, new Date("2026-12-13T00:00:00Z")));
});

test("once started without late entry, an accepted student's window is closed", () => {
  const started = { ...WINTER, status: "active" };
  closed(scholarshipWindow({ cohort: started, stage: "accepted" }, new Date("2026-12-15T15:00:00Z")));
});

test("with no applications deadline, an accepted window runs to the eve of the start — or through late entry", () => {
  const noDeadline = { ...WINTER, applications_close_at: null };
  // End of Dec 13, Eastern: the last day before the cohort starts.
  assert.equal(open(scholarshipWindow({ cohort: noDeadline, stage: "accepted" }, TODAY)).until, "2026-12-14T04:59:59.000Z");
  const withLateEntry = {
    ...noDeadline,
    late_entry_until: "2026-12-19T04:59:59.000Z",
    catch_up_plan: "Catch-up session on Dec 17.",
  };
  assert.equal(open(scholarshipWindow({ cohort: withLateEntry, stage: "accepted" }, TODAY)).until, "2026-12-19T04:59:59.000Z");
  // A late-entry date without a catch-up plan isn't late entry (cohortEligibility's rule).
  assert.equal(
    open(scholarshipWindow({ cohort: { ...withLateEntry, catch_up_plan: " " }, stage: "accepted" }, TODAY)).until,
    "2026-12-14T04:59:59.000Z",
  );
});

test("a student with no cohort is closed, and told why", () => {
  const w = closed(scholarshipWindow({ cohort: null, stage: "enrolled" }, TODAY));
  assert.equal(w.basis, "no_cohort");
  assert.equal(w.reason, NO_COHORT_REASON);
  assert.equal(windowHeadline(w), NO_COHORT_REASON);
});

test("an unnamed cohort still reads as a sentence", () => {
  const w = closed(scholarshipWindow({ cohort: { ...FALL, name: null, status: "completed" }, stage: "enrolled" }, TODAY));
  assert.equal(w.reason, "Your cohort has ended.");
});

// --- which cohort ------------------------------------------------------------

const SUMMER: ScholarshipCohort = {
  ...FALL,
  id: "summer",
  name: "Summer 2026",
  status: "completed",
  starts_on: "2026-06-01",
  ends_on: "2026-07-31",
};

function candidate(cohort: ScholarshipCohort, stage: CohortCandidate["stage"], applicationId: string | null = null): CohortCandidate {
  return { cohort, stage, applicationId };
}

test("an accepted application for the next cohort outranks a running enrollment — the lib/access.ts rule", () => {
  const got = resolveScholarshipCohort([candidate(FALL, "enrolled"), candidate(WINTER, "accepted", "app-w")], TODAY);
  assert.equal(got?.cohort.id, "winter");
  assert.equal(got?.stage, "accepted");
  assert.equal(got?.applicationId, "app-w");
});

test("with everything started, the most recently started cohort wins — not whichever row came back first", () => {
  for (const order of [[SUMMER, FALL], [FALL, SUMMER]]) {
    const got = resolveScholarshipCohort(order.map((c) => candidate(c, "enrolled")), TODAY);
    assert.equal(got?.cohort.id, "fall");
  }
});

test("a finished enrollment alone resolves to that cohort, whose window is then closed", () => {
  // The old read counted this student as enrolled with a live window.
  const got = resolveScholarshipCohort([candidate(SUMMER, "enrolled")], TODAY);
  assert.equal(got?.cohort.id, "summer");
  closed(scholarshipWindow({ cohort: got!.cohort, stage: got!.stage }, TODAY));
});

test("a cohort listed as both accepted and enrolled resolves to enrolled", () => {
  const got = resolveScholarshipCohort([candidate(FALL, "accepted", "app-f"), candidate(FALL, "enrolled")], TODAY);
  assert.equal(got?.stage, "enrolled");
  assert.equal(got?.applicationId, "app-f");
});

test("a cancelled cohort is passed over while another remains", () => {
  const cancelledWinter = { ...WINTER, status: "cancelled" };
  assert.equal(resolveScholarshipCohort([candidate(cancelledWinter, "accepted"), candidate(FALL, "enrolled")], TODAY)?.cohort.id, "fall");
  assert.equal(resolveScholarshipCohort([candidate(cancelledWinter, "accepted")], TODAY)?.cohort.id, "winter");
  assert.equal(resolveScholarshipCohort([], TODAY), null);
});

// --- scholarship-funded 1:1 calls --------------------------------------------

test("a scholarship call can be proposed for any time up to the end of the award's cohort", () => {
  const w = scholarshipCallWindow(FALL, TODAY);
  assert.equal(w.open, true);
  // 8 PM Eastern on the last day is fine; the next morning is not.
  assert.equal(callTimeProblem(new Date("2026-11-14T01:00:00Z"), w), null);
  assert.equal(
    callTimeProblem(new Date("2026-11-14T15:00:00Z"), w),
    "Pick a time on or before Nov 13 — scholarship calls happen during Fall 2026.",
  );
  assert.match(callTimeProblem(new Date("2026-12-01T15:00:00Z"), w, "backup") ?? "", /^Pick a backup time on or before Nov 13/);
});

test("once the award's cohort has ended, scholarship calls can't be booked at all", () => {
  const w = scholarshipCallWindow(FALL, new Date("2026-11-20T15:00:00Z"));
  assert.equal(w.open, false);
  if (!w.open) assert.equal(w.reason, "Your scholarship calls were for Fall 2026, which has ended.");
  assert.equal(callTimeProblem(new Date("2026-11-21T15:00:00Z"), w), "Your scholarship calls were for Fall 2026, which has ended.");
  const cancelled = scholarshipCallWindow({ ...FALL, status: "cancelled" }, TODAY);
  assert.equal(cancelled.open, false);
});

test("a legacy award with no cohort is left unbounded rather than locked out", () => {
  const w = scholarshipCallWindow(null, TODAY);
  assert.deepEqual(w, { open: true, until: null, cohortName: null });
  assert.equal(callTimeProblem(new Date("2030-01-01T00:00:00Z"), w), null);
});

// --- whether a cohort is over ------------------------------------------------

test("cohortIsOver: running and upcoming aren't over; past the last Eastern day, completed and cancelled are", () => {
  assert.equal(cohortIsOver(FALL, TODAY), false);
  assert.equal(cohortIsOver(WINTER, TODAY), false);
  // 11:30 PM Eastern on Nov 13 is still Fall's last day; the next morning isn't.
  assert.equal(cohortIsOver(FALL, new Date("2026-11-14T04:30:00Z")), false);
  assert.equal(cohortIsOver(FALL, new Date("2026-11-14T15:00:00Z")), true);
  assert.equal(cohortIsOver({ ...FALL, status: "completed" }, TODAY), true);
  assert.equal(cohortIsOver({ ...WINTER, status: "cancelled" }, TODAY), true);
});

test("cohortIsOver: no cohort on file reads as not over, so a legacy award keeps its perks and keeps blocking", () => {
  assert.equal(cohortIsOver(null, TODAY), false);
});

// --- wording -----------------------------------------------------------------

test("windowUntilLabel shows a whole Eastern day as a date, and anything else to the minute", () => {
  assert.equal(windowUntilLabel("2026-11-14T04:59:59.000Z"), "Nov 13");
  assert.equal(windowUntilLabel("2026-10-01T03:59:59.999Z"), "Sep 30");
  assert.equal(windowUntilLabel("2026-09-23T03:59:59Z"), "Sep 22");
  assert.equal(windowUntilLabel("2026-12-12T23:59:00Z"), "Dec 12, 6:59 PM EST");
  assert.equal(windowUntilLabel(null), "");
  assert.equal(windowUntilLabel("not a date"), "");
});

test("the admin list describes each stage's window in a cohort", () => {
  assert.equal(
    describeCohortWindows({ cohort: FALL, stages: ["accepted", "enrolled"] }, TODAY),
    "accepted students until Sep 30 · enrolled students until Nov 13",
  );
  assert.equal(
    describeCohortWindows({ cohort: FALL, stages: ["enrolled", "accepted"] }, new Date("2026-10-05T15:00:00Z")),
    "accepted students closed · enrolled students until Nov 13",
  );
  assert.equal(describeCohortWindows({ cohort: FALL, stages: ["enrolled"] }, TODAY), "enrolled students until Nov 13");
  assert.equal(
    describeCohortWindows({ cohort: WINTER, stages: ["accepted"] }, TODAY),
    "accepted students until Dec 12, 6:59 PM EST",
  );
});
