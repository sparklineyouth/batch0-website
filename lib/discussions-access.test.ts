import { test } from "node:test";
import assert from "node:assert/strict";
import {
  canReadThread,
  canReplyToThread,
  type DiscussionViewer,
} from "./discussions-access.ts";

// Run with `npm test`.
//
// The privacy promise behind a "question to the team" is that no other
// student can see it — not a teammate, not someone in the same cohort. These
// pin that promise in code; the RLS function in migration 0068 makes the
// same promise at the row level.

const asker: DiscussionViewer = { userId: "u-asker", manages: false, cohortIds: ["c1"] };
const classmate: DiscussionViewer = { userId: "u-mate", manages: false, cohortIds: ["c1"] };
const otherCohort: DiscussionViewer = { userId: "u-other", manages: false, cohortIds: ["c2"] };
const staff: DiscussionViewer = { userId: "u-staff", manages: true, cohortIds: [] };

const question = { visibility: "admin" as const, cohortId: "c1", authorId: "u-asker" };
const discussion = { visibility: "cohort" as const, cohortId: "c1", authorId: "u-asker" };

test("a private question is readable by its author and the team only", () => {
  assert.equal(canReadThread(question, asker), true);
  assert.equal(canReadThread(question, staff), true);
  assert.equal(canReadThread(question, classmate), false, "same cohort grants nothing");
  assert.equal(canReadThread(question, otherCohort), false);
});

test("a cohort discussion is readable by the cohort and the team", () => {
  assert.equal(canReadThread(discussion, asker), true);
  assert.equal(canReadThread(discussion, classmate), true);
  assert.equal(canReadThread(discussion, staff), true);
  assert.equal(canReadThread(discussion, otherCohort), false);
});

test("a cohort discussion with no cohort left is author + team only", () => {
  // cohort_id is `on delete set null` — the thread survives its cohort.
  const orphan = { ...discussion, cohortId: null };
  assert.equal(canReadThread(orphan, asker), true);
  assert.equal(canReadThread(orphan, staff), true);
  assert.equal(canReadThread(orphan, classmate), false);
});

test("nobody replies to a closed thread, the team included", () => {
  const closed = { ...discussion, status: "closed" as const };
  assert.equal(canReplyToThread(closed, classmate), false);
  assert.equal(canReplyToThread(closed, staff), false);
  assert.equal(canReplyToThread({ ...discussion, status: "open" }, classmate), true);
});

test("replying still requires being able to read", () => {
  const open = { ...question, status: "open" as const };
  assert.equal(canReplyToThread(open, classmate), false);
  assert.equal(canReplyToThread(open, asker), true);
  assert.equal(canReplyToThread(open, staff), true);
});
