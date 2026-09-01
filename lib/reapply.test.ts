import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyStage,
  planReapply,
  selectCohortId,
  type ApplicationHistoryRow,
  type OpenCohort,
} from "./reapply.ts";

// Open cohorts, ordered by start date ascending the way the page's query
// returns them. SPRING is "the most upcoming cohort".
const SPRING: OpenCohort = { id: "spring", name: "Spring 2026", starts_on: "2026-03-01" };
const SUMMER: OpenCohort = { id: "summer", name: "Summer 2026", starts_on: "2026-06-01" };
const COHORTS = [SPRING, SUMMER];

function history(...rows: Array<[string, string | null]>): ApplicationHistoryRow[] {
  return rows.map(([status, cohort_id]) => ({ status, cohort_id }));
}

// ---------------------------------------------------------------------------
// Which form to render at all.
// ---------------------------------------------------------------------------

test("applyStage maps the lifecycle onto the four form states", () => {
  assert.equal(applyStage(null), "new");
  assert.equal(applyStage(undefined), "new");
  assert.equal(applyStage("draft"), "draft");
  assert.equal(applyStage("rejected"), "reapply");
  assert.equal(applyStage("withdrawn"), "reapply");
  for (const locked of ["submitted", "accepted", "waitlisted", "paid", "enrolled"]) {
    assert.equal(applyStage(locked), "locked", locked);
  }
});

// ---------------------------------------------------------------------------
// Rule 1 — a decline closes THAT cohort, not batch0.
// ---------------------------------------------------------------------------

test("a decline removes only the cohort that issued it", () => {
  const plan = planReapply({
    cohorts: COHORTS,
    history: history(["rejected", "spring"]),
    latestStatus: "rejected",
    holdsPass: false,
  });
  assert.deepEqual(plan.allowed.map((c) => c.id), ["summer"]);
  assert.deepEqual(plan.blocked.map((c) => c.id), ["spring"]);
  assert.equal(plan.stage, "reapply");
  assert.equal(plan.passReopened, false);
});

test("declines accumulate — every cohort that said no stays shut", () => {
  // The regression this guards: reading only the NEWEST application would
  // reopen spring the moment summer declined them.
  const plan = planReapply({
    cohorts: COHORTS,
    history: history(["rejected", "summer"], ["rejected", "spring"]),
    latestStatus: "rejected",
    holdsPass: false,
  });
  assert.deepEqual(plan.allowed, []);
  assert.deepEqual(plan.blocked.map((c) => c.id), ["spring", "summer"]);
});

test("a decline from a cohort that is no longer open blocks nothing", () => {
  const plan = planReapply({
    cohorts: COHORTS,
    history: history(["rejected", "winter"]),
    latestStatus: "rejected",
    holdsPass: false,
  });
  assert.deepEqual(plan.allowed.map((c) => c.id), ["spring", "summer"]);
  assert.deepEqual(plan.blocked, []);
});

// ---------------------------------------------------------------------------
// Rule 2 — a withdrawal closes nothing.
// ---------------------------------------------------------------------------

test("withdrawing leaves the cohort you left open to you", () => {
  const plan = planReapply({
    cohorts: COHORTS,
    history: history(["withdrawn", "spring"]),
    latestStatus: "withdrawn",
    holdsPass: false,
  });
  assert.deepEqual(plan.allowed.map((c) => c.id), ["spring", "summer"]);
  assert.deepEqual(plan.blocked, []);
});

test("a draft doesn't block its own cohort", () => {
  const plan = planReapply({
    cohorts: COHORTS,
    history: history(["draft", "spring"]),
    latestStatus: "draft",
    holdsPass: false,
  });
  assert.equal(plan.stage, "draft");
  assert.deepEqual(plan.allowed.map((c) => c.id), ["spring", "summer"]);
});

// ---------------------------------------------------------------------------
// Rule 3 — a founder pass reopens everything.
// ---------------------------------------------------------------------------

test("a pass holder declined from the soonest cohort can go straight back at it", () => {
  const plan = planReapply({
    cohorts: COHORTS,
    history: history(["rejected", "spring"]),
    latestStatus: "rejected",
    holdsPass: true,
  });
  assert.deepEqual(plan.allowed.map((c) => c.id), ["spring", "summer"]);
  assert.deepEqual(plan.blocked, []);
  assert.equal(plan.passReopened, true);
  // "The most upcoming cohort" is simply the first allowed one.
  assert.equal(selectCohortId(plan.allowed, []), "spring");
});

test("a pass holder declined from everything still has somewhere to go", () => {
  const plan = planReapply({
    cohorts: COHORTS,
    history: history(["rejected", "spring"], ["rejected", "summer"]),
    latestStatus: "rejected",
    holdsPass: true,
  });
  assert.deepEqual(plan.allowed.map((c) => c.id), ["spring", "summer"]);
});

test("passReopened is false when the pass changed nothing", () => {
  // Holding a pass isn't the claim — reopening a door that was shut is. The
  // "your pass gets you another run" copy must not appear for a first-time
  // applicant who happens to hold one.
  const plan = planReapply({
    cohorts: COHORTS,
    history: [],
    latestStatus: null,
    holdsPass: true,
  });
  assert.equal(plan.passReopened, false);
  assert.equal(plan.stage, "new");
});

// ---------------------------------------------------------------------------
// Nothing open.
// ---------------------------------------------------------------------------

test("no open cohorts means nothing allowed and nothing to explain away", () => {
  const plan = planReapply({
    cohorts: [],
    history: history(["rejected", "spring"]),
    latestStatus: "rejected",
    holdsPass: false,
  });
  assert.deepEqual(plan.allowed, []);
  assert.deepEqual(plan.blocked, []);
});

// ---------------------------------------------------------------------------
// Default selection.
// ---------------------------------------------------------------------------

test("selectCohortId honours the first allowed preference", () => {
  assert.equal(selectCohortId(COHORTS, ["summer", "spring"]), "summer");
  assert.equal(selectCohortId(COHORTS, [null, undefined, "spring"]), "spring");
});

test("selectCohortId skips a preference that is no longer allowed", () => {
  // The bug this replaced: the old chain fell through to `cohorts[0]` over the
  // FULL list, so a student declined from the soonest cohort was preselected
  // straight back onto it.
  const allowed = [SUMMER];
  assert.equal(selectCohortId(allowed, ["spring"]), "summer");
});

test("selectCohortId returns null when nothing is allowed", () => {
  assert.equal(selectCohortId([], ["spring"]), null);
});
