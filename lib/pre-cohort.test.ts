import { test } from "node:test";
import assert from "node:assert/strict";
import { isPreCohortAllowedPath } from "./pre-cohort.ts";

const ID = "5b1e2f0a-8c7d-4e6f-9a0b-1c2d3e4f5a6b";

test("a webinar room is reachable pre-cohort; the events list is not", () => {
  assert.equal(isPreCohortAllowedPath(`/dashboard/events/${ID}/live`), true);
  assert.equal(isPreCohortAllowedPath(`/dashboard/events/${ID}/live/`), true);
  assert.equal(isPreCohortAllowedPath("/dashboard/events"), false);
  assert.equal(isPreCohortAllowedPath(`/dashboard/events/${ID}`), false);
  assert.equal(isPreCohortAllowedPath(`/dashboard/events/${ID}/live/x`), false);
  assert.equal(isPreCohortAllowedPath("/dashboard/events//live"), false);
});

test("the existing allow list is unchanged", () => {
  assert.equal(isPreCohortAllowedPath("/dashboard"), true);
  assert.equal(isPreCohortAllowedPath(`/dashboard/calls/${ID}/live`), true);
  assert.equal(isPreCohortAllowedPath("/dashboard/billing/receipts"), true);
  assert.equal(isPreCohortAllowedPath("/dashboard/teams"), false);
});
