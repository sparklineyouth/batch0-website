import { test } from "node:test";
import assert from "node:assert/strict";
import { checkinHistory, weekOfLabel, type CheckinRow, type CheckinFeedbackRow } from "./checkin-history.ts";

const checkins: CheckinRow[] = [
  { id: "w1", week_start: "2026-09-14", accomplished: "Interviews", next_up: "Canvas", blockers: " ", created_at: "2026-09-18T00:00:00Z" },
  { id: "w4", week_start: "2026-10-05", accomplished: "Week 4 stuff", next_up: null, blockers: "y", created_at: "2026-10-09T00:00:00Z" },
  { id: "blank", week_start: "2026-09-21", accomplished: "  ", next_up: null, blockers: null, created_at: "2026-09-25T00:00:00Z" },
  { id: "blank-fb", week_start: "2026-09-28", accomplished: null, next_up: null, blockers: null, created_at: "2026-10-02T00:00:00Z" },
];

const feedback: CheckinFeedbackRow[] = [
  { id: "f2", checkin_id: "w4", author_id: "m1", body: "Second note", created_at: "2026-10-11T00:00:00Z" },
  { id: "f1", checkin_id: "w4", author_id: "m2", body: " First note ", created_at: "2026-10-10T00:00:00Z" },
  { id: "f-empty", checkin_id: "w1", author_id: "m1", body: "   ", created_at: "2026-09-19T00:00:00Z" },
  { id: "f3", checkin_id: "blank-fb", author_id: "m1", body: "Where's your update?", created_at: "2026-10-03T00:00:00Z" },
];

const names = new Map([["m1", "Mira Mentor"]]);

test("newest week first; blank check-ins with no feedback are dropped", () => {
  const items = checkinHistory(checkins, feedback, names);
  assert.deepEqual(items.map((i) => i.id), ["w4", "blank-fb", "w1"]);
});

test("feedback rides on its check-in, oldest first, trimmed, with a name", () => {
  const [w4] = checkinHistory(checkins, feedback, names);
  assert.deepEqual(
    w4.feedback.map((f) => [f.id, f.author, f.body]),
    [
      ["f1", "Mentor", "First note"],
      ["f2", "Mira Mentor", "Second note"],
    ],
  );
  assert.equal(w4.blockers, "y");
  assert.equal(w4.nextUp, null);
});

test("blank fields read as absent, and empty feedback is skipped", () => {
  const w1 = checkinHistory(checkins, feedback, names).find((i) => i.id === "w1");
  assert.equal(w1?.blockers, null);
  assert.deepEqual(w1?.feedback, []);
});

test("weekOfLabel reads a bare date without shifting it", () => {
  assert.equal(weekOfLabel("2026-10-05"), "Week of Oct 5, 2026");
  assert.equal(weekOfLabel("2026-01-01"), "Week of Jan 1, 2026");
  assert.equal(weekOfLabel("nonsense"), "Week");
});
