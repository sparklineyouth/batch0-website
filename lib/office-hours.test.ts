import { test } from "node:test";
import assert from "node:assert/strict";
import { upcomingOfficeHours, type OfficeHoursBookingRow, type OfficeHoursSlotRow } from "./office-hours.ts";

const NOW = new Date("2026-10-14T18:00:00Z");

const slots: OfficeHoursSlotRow[] = [
  { id: "s-later", mentor_id: "m1", starts_at: "2026-10-20T16:00:00Z", ends_at: "2026-10-20T16:30:00Z", zoom_url: "https://zoom.us/j/123", notes: "  Bring your deck.  " },
  { id: "s-soon", mentor_id: "m2", starts_at: "2026-10-16T16:00:00Z", ends_at: "2026-10-16T16:30:00Z", zoom_url: "javascript:alert(1)", notes: null },
  { id: "s-past", mentor_id: "m1", starts_at: "2026-10-10T16:00:00Z", ends_at: "2026-10-10T16:30:00Z", zoom_url: "https://zoom.us/j/9", notes: null },
  // Started before now, still running: still listed.
  { id: "s-now", mentor_id: "m1", starts_at: "2026-10-14T17:45:00Z", ends_at: "2026-10-14T18:15:00Z", zoom_url: null, notes: "   " },
  // The old form took any text as the meeting "link".
  { id: "s-text", mentor_id: "m1", starts_at: "2026-10-22T16:00:00Z", ends_at: "2026-10-22T16:30:00Z", zoom_url: " zoom.us/j/77 pw 123 ", notes: "x".repeat(900) },
];

const bookings: OfficeHoursBookingRow[] = [
  { id: "b-later", slot_id: "s-later", student_id: "st1", topic: "  pricing  ", status: "booked" },
  { id: "b-soon", slot_id: "s-soon", student_id: "st2", topic: "", status: "booked" },
  { id: "b-past", slot_id: "s-past", student_id: "st1", topic: "old", status: "booked" },
  { id: "b-cancel", slot_id: "s-later", student_id: "st3", topic: null, status: "cancelled" },
  { id: "b-now", slot_id: "s-now", student_id: "st1", topic: null, status: "booked" },
  { id: "b-text", slot_id: "s-text", student_id: "st1", topic: null, status: "booked" },
  { id: "b-orphan", slot_id: "missing", student_id: "st1", topic: null, status: "booked" },
];

const names = new Map([
  ["m1", "Mira Mentor"],
  ["st1", "Sam Student"],
]);

test("lists booked sessions that haven't ended, soonest first", () => {
  const rows = upcomingOfficeHours("student", bookings, slots, names, NOW);
  assert.deepEqual(rows.map((r) => r.id), ["b-now", "b-soon", "b-later", "b-text"]);
});

test("a student sees the mentor's name; a mentor sees the student's", () => {
  const forStudent = upcomingOfficeHours("student", bookings, slots, names, NOW);
  assert.equal(forStudent.find((r) => r.id === "b-later")?.withName, "Mira Mentor");
  // No name on file: a neutral label, never an id.
  assert.equal(forStudent.find((r) => r.id === "b-soon")?.withName, "your mentor");
  const forMentor = upcomingOfficeHours("mentor", bookings, slots, names, NOW);
  assert.equal(forMentor.find((r) => r.id === "b-later")?.withName, "Sam Student");
  assert.equal(forMentor.find((r) => r.id === "b-soon")?.withName, "a student");
});

test("only an https meeting link is offered; topics are trimmed", () => {
  const rows = upcomingOfficeHours("student", bookings, slots, names, NOW);
  const byId = new Map(rows.map((r) => [r.id, r]));
  assert.equal(byId.get("b-later")?.joinUrl, "https://zoom.us/j/123");
  assert.equal(byId.get("b-later")?.topic, "pricing");
  assert.equal(byId.get("b-soon")?.joinUrl, null);
  assert.equal(byId.get("b-soon")?.topic, null);
  assert.equal(byId.get("b-now")?.joinUrl, null);
});

test("nothing booked, nothing listed", () => {
  assert.deepEqual(upcomingOfficeHours("mentor", [], slots, names, NOW), []);
});

test("the mentor's notes come through, and a meeting field that isn't an https link is text only", () => {
  const byId = new Map(upcomingOfficeHours("mentor", bookings, slots, names, NOW).map((r) => [r.id, r]));
  assert.equal(byId.get("b-later")?.notes, "Bring your deck.");
  assert.equal(byId.get("b-later")?.meetingText, null);
  assert.equal(byId.get("b-now")?.notes, null);
  assert.equal(byId.get("b-now")?.meetingText, null);
  const text = byId.get("b-text");
  assert.equal(text?.joinUrl, null);
  assert.equal(text?.meetingText, "zoom.us/j/77 pw 123");
  assert.equal(text?.notes?.length, 500);
  assert.ok(text?.notes?.endsWith("…"));
  // Never a link, but still shown as what the mentor typed.
  assert.equal(byId.get("b-soon")?.joinUrl, null);
  assert.equal(byId.get("b-soon")?.meetingText, "javascript:alert(1)");
});
