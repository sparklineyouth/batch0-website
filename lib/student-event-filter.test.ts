import { test } from "node:test";
import assert from "node:assert/strict";
import {
  STUDENT_EVENT_VISIBILITIES,
  studentEventsOrFilter,
} from "./student-event-filter.ts";

const A = "6350c6ac-70f0-4f53-93d5-c99e397185a9";
const B = "0f8e2c41-1b7a-4c35-9d2e-7a1f3b9c5d10";

test("staff-only events are never student-visible", () => {
  assert.deepEqual([...STUDENT_EVENT_VISIBILITIES], ["public", "enrolled"]);
  assert.ok(!(STUDENT_EVENT_VISIBILITIES as readonly string[]).includes("staff"));
  for (const f of [studentEventsOrFilter([]), studentEventsOrFilter([A, B])]) {
    assert.ok(!f.includes("staff"));
    assert.ok(!f.includes("cohort_id.is.null"));
  }
});

test("no enrollment: public events only", () => {
  assert.equal(studentEventsOrFilter([]), "visibility.eq.public");
  assert.equal(studentEventsOrFilter([null, undefined]), "visibility.eq.public");
});

test("enrolled: public events plus enrolled events of the student's cohorts", () => {
  assert.equal(
    studentEventsOrFilter([A]),
    `visibility.eq.public,and(visibility.eq.enrolled,cohort_id.in.(${A}))`,
  );
  assert.equal(
    studentEventsOrFilter([A, B, A]),
    `visibility.eq.public,and(visibility.eq.enrolled,cohort_id.in.(${A},${B}))`,
  );
});

test("non-UUID ids are dropped, so the filter cannot be widened", () => {
  assert.equal(
    studentEventsOrFilter([`${A}),visibility.eq.staff`, "x", ""]),
    "visibility.eq.public",
  );
  assert.equal(
    studentEventsOrFilter(["nope", B]),
    `visibility.eq.public,and(visibility.eq.enrolled,cohort_id.in.(${B}))`,
  );
});
