import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assignmentEvent,
  challengeEvent,
  formatWatched,
  pickStoppedAt,
  sortRecent,
  type ProgressEvent,
} from "./progress-events.ts";

const ev = (at: string, complete: boolean, label = at): ProgressEvent => ({
  area: "course",
  label,
  at,
  complete,
});

test("pickStoppedAt: newest wins; an unfinished touch beats a finished one at the same time", () => {
  assert.equal(pickStoppedAt([]), null);
  const older = ev("2026-10-01T10:00:00Z", false, "older");
  const newer = ev("2026-10-02T10:00:00Z", true, "newer");
  assert.equal(pickStoppedAt([older, newer])?.label, "newer");
  const done = ev("2026-10-03T10:00:00Z", true, "finished lesson 3");
  const started = ev("2026-10-03T10:00:00Z", false, "started lesson 4");
  assert.equal(pickStoppedAt([done, started])?.label, "started lesson 4");
});

test("sortRecent: newest first, capped", () => {
  const list = [ev("2026-10-01T00:00:00Z", true), ev("2026-10-03T00:00:00Z", true), ev("2026-10-02T00:00:00Z", true)];
  assert.deepEqual(
    sortRecent(list, 2).map((e) => e.at),
    ["2026-10-03T00:00:00Z", "2026-10-02T00:00:00Z"],
  );
});

test("formatWatched", () => {
  assert.equal(formatWatched(42), "42s watched");
  assert.equal(formatWatched(180), "3m watched");
  assert.equal(formatWatched(252), "4m 12s watched");
});

test("assignmentEvent: a handed-in assignment is activity, dated when it was handed in", () => {
  const e = assignmentEvent({
    status: "reviewed",
    submitted_at: "2026-10-05T12:00:00Z",
    updated_at: "2026-10-07T09:00:00Z",
    assignment: { title: "Weekly update — week 5" },
  });
  assert.deepEqual(e, {
    area: "assignment",
    label: "Weekly update — week 5",
    detail: "reviewed",
    at: "2026-10-05T12:00:00Z",
    complete: true,
    href: "/admin/assignments",
  });
  assert.equal(assignmentEvent({ status: "submitted", updated_at: "x", assignment: [{ title: "A" }] })?.detail, "submitted");
  assert.equal(assignmentEvent({ status: "returned", updated_at: "x", assignment: null })?.detail, "returned for changes");
  assert.equal(assignmentEvent({ status: "returned", updated_at: "x", assignment: null })?.label, "an assignment");
  // No submitted_at (shouldn't happen): fall back to the row's last change.
  assert.equal(assignmentEvent({ status: "submitted", submitted_at: null, updated_at: "2026-10-09T00:00:00Z" })?.at, "2026-10-09T00:00:00Z");
});

test("assignmentEvent: excused is a staff decision, not activity", () => {
  assert.equal(assignmentEvent({ status: "excused", updated_at: "2026-10-05T12:00:00Z" }), null);
});

test("challengeEvent: dated by submission, not the first autosave", () => {
  const e = challengeEvent({
    created_at: "2026-10-01T00:00:00Z",
    submitted_at: "2026-10-04T00:00:00Z",
    challenge: [{ title: "Ship it" }],
  });
  assert.equal(e.at, "2026-10-04T00:00:00Z");
  assert.equal(e.label, "Ship it");
  assert.equal(e.area, "challenge");
  assert.equal(challengeEvent({ created_at: "2026-10-01T00:00:00Z" }).label, "a weekly challenge");
});

test("a student whose only activity is a submission has a stopped-at (not 'never started')", () => {
  const only = assignmentEvent({
    status: "submitted",
    submitted_at: "2026-10-12T20:00:00Z",
    updated_at: "2026-10-12T20:00:00Z",
    assignment: { title: "RQ weekly" },
  });
  assert.ok(only);
  assert.equal(pickStoppedAt([only])?.label, "RQ weekly");
});
