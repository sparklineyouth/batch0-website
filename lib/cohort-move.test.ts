import test from "node:test";
import assert from "node:assert/strict";
import {
  cohortMoveFailureMessage,
  cohortMoveRefusalMessage,
  parseCohortMoveResult,
} from "./cohort-move.ts";

test("a successful move parses into the audit's fields", () => {
  const r = parseCohortMoveResult({
    ok: true,
    from_cohort_id: "fall",
    to_cohort_id: "winter",
    application_id: null,
    enrollment: "moved",
    scholarship_application_ids: ["s1", 2, "s2"],
  });
  assert.deepEqual(r, {
    ok: true,
    fromCohortId: "fall",
    toCohortId: "winter",
    applicationId: null,
    enrollment: "moved",
    scholarshipApplicationIds: ["s1", "s2"],
  });
});

test("anything unrecognised is a refusal, never a success", () => {
  for (const raw of [null, undefined, "ok", 42, {}, { ok: true }, { ok: "true", to_cohort_id: "w" }]) {
    assert.equal(parseCohortMoveResult(raw).ok, false, JSON.stringify(raw));
  }
  assert.deepEqual(parseCohortMoveResult({ ok: false, code: "drop table" }), { ok: false, code: "unknown" });
  assert.deepEqual(parseCohortMoveResult({ ok: false, code: "application_exists", status: "draft" }), {
    ok: false,
    code: "application_exists",
    status: "draft",
  });
});

test("every refusal has a message that names the cohort where it matters", () => {
  const msg = (code: string, status?: string) =>
    cohortMoveRefusalMessage(parseCohortMoveResult({ ok: false, code, status }) as any, "Winter");
  assert.match(msg("same_cohort"), /already in Winter/);
  assert.match(msg("already_enrolled"), /enrolled in Winter/);
  assert.match(msg("application_exists", "draft"), /a draft application for Winter/);
  assert.match(msg("award_conflict"), /one award per cohort/);
  assert.match(msg("stale"), /Refresh/);
  assert.match(msg("nothing_to_move"), /nothing to move/);
  assert.match(msg("no_profile"), /no longer exists/);
  assert.match(msg("no_cohort"), /doesn't exist/);
  assert.match(msg("whatever"), /nothing was changed/);
});

test("a rolled-back write says nothing changed, and the award index reads plainly", () => {
  assert.equal(
    cohortMoveFailureMessage("This cohort is full.", "Winter"),
    "Couldn't move them to Winter, so nothing was changed: This cohort is full.",
  );
  assert.match(
    cohortMoveFailureMessage(
      'duplicate key value violates unique constraint "scholarship_applications_one_award_idx"',
      "Winter",
    ),
    /already hold a scholarship award in Winter/,
  );
  assert.match(cohortMoveFailureMessage("", "Winter"), /nothing was changed: the database refused it\./);
});
