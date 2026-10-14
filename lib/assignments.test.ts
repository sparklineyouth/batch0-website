import { test } from "node:test";
import assert from "node:assert/strict";
import {
  addDays,
  buildMatrix,
  canEditSubmission,
  cohortWeekCount,
  courseWeekAt,
  courseWeekStart,
  courseWeekWindow,
  deriveStatus,
  easternDate,
  easternTime,
  easternToUtc,
  formatEastern,
  formatEasternDay,
  isGoogleLink,
  normalizeDraft,
  normalizeLink,
  seriesWeeks,
  statusLabel,
  studentGroup,
  validateSubmission,
} from "./assignments.ts";

// Run with `npm test`. Fall 2026: starts Mon Sep 14, ends Fri Nov 13; DST ends Sun Nov 1.
const FALL = { startsOn: "2026-09-14", endsOn: "2026-11-13" };

test("New York wall time resolves on both sides of the Nov 1 2026 DST change", () => {
  assert.equal(easternToUtc("2026-10-25", "23:59"), "2026-10-26T03:59:00.000Z"); // EDT, -4
  assert.equal(easternToUtc("2026-11-01", "23:59"), "2026-11-02T04:59:00.000Z"); // EST, -5
  assert.equal(easternToUtc("2026-11-11", "20:00"), "2026-11-12T01:00:00.000Z"); // Demo Day deadline
  assert.equal(easternToUtc("2026-03-08", "12:00"), "2026-03-08T16:00:00.000Z"); // spring forward day
  assert.equal(easternToUtc("2026-11-31", "12:00"), null);
  assert.equal(easternToUtc("2026-11-01", "24:00"), null);
  assert.equal(easternDate("2026-11-02T04:59:00Z"), "2026-11-01");
  assert.equal(easternTime("2026-11-02T04:59:00Z"), "23:59");
  assert.equal(formatEastern("2026-11-02T04:59:00Z"), "Sun, Nov 1, 11:59 PM ET");
  assert.equal(formatEasternDay("2026-11-02T04:59:00Z"), "Nov 1");
});

test("course_week math: Monday 00:00 ET open, Sunday 23:59 ET due, DST-correct", () => {
  assert.equal(courseWeekStart(FALL.startsOn, 1), "2026-09-14");
  assert.equal(courseWeekStart(FALL.startsOn, 7), "2026-10-26");
  assert.equal(courseWeekStart(FALL.startsOn, 0), null);
  assert.deepEqual(courseWeekWindow({ startsOn: FALL.startsOn, week: 6 }), {
    opensAt: "2026-10-19T04:00:00.000Z",
    dueAt: "2026-10-26T03:59:00.000Z",
  });
  // Week 7 opens in EDT and is due in EST.
  assert.deepEqual(courseWeekWindow({ startsOn: FALL.startsOn, week: 7 }), {
    opensAt: "2026-10-26T04:00:00.000Z",
    dueAt: "2026-11-02T04:59:00.000Z",
  });
  assert.deepEqual(courseWeekWindow({ startsOn: FALL.startsOn, week: 8 }), {
    opensAt: "2026-11-02T05:00:00.000Z",
    dueAt: "2026-11-09T04:59:00.000Z",
  });
  // Custom due: Wednesday 20:00 of week 9 (Demo Day week).
  assert.equal(
    courseWeekWindow({ startsOn: FALL.startsOn, week: 9, dueDayOffset: 2, dueLocalTime: "20:00:00" })?.dueAt,
    "2026-11-12T01:00:00.000Z",
  );
  // Due on the opening instant is not a window.
  assert.equal(courseWeekWindow({ startsOn: FALL.startsOn, week: 1, dueDayOffset: 0, dueLocalTime: "00:00" }), null);
  assert.equal(courseWeekWindow({ startsOn: FALL.startsOn, week: 1, dueDayOffset: 14 }), null);
});

test("which week it is follows the New York calendar", () => {
  assert.equal(courseWeekAt(FALL.startsOn, new Date("2026-09-14T03:59:00Z")), null); // Sep 13, 11:59 PM ET
  assert.equal(courseWeekAt(FALL.startsOn, new Date("2026-09-14T04:00:00Z")), 1);
  assert.equal(courseWeekAt(FALL.startsOn, new Date("2026-10-14T16:00:00Z")), 5);
  // Monday 00:30 ET of week 8, which is still Monday 05:30 UTC.
  assert.equal(courseWeekAt(FALL.startsOn, new Date("2026-11-02T05:30:00Z")), 8);
  assert.equal(courseWeekAt(FALL.startsOn, new Date("2026-11-02T04:30:00Z")), 7);
});

test("repeat weekly generates weeks k..W; Fall spans 9 weeks", () => {
  assert.equal(cohortWeekCount(FALL.startsOn, FALL.endsOn), 9);
  assert.equal(cohortWeekCount("2026-09-14", "2026-09-20"), 1);
  assert.equal(cohortWeekCount("2026-09-14", "2026-09-21"), 2);
  assert.equal(cohortWeekCount("2026-09-14", "2026-09-01"), null);
  assert.deepEqual(seriesWeeks(5, cohortWeekCount(FALL.startsOn, FALL.endsOn)!), [5, 6, 7, 8, 9]);
  assert.deepEqual(seriesWeeks(1, 1), [1]);
  assert.deepEqual(seriesWeeks(6, 5), []);
  assert.deepEqual(seriesWeeks(0, 3), []);
  assert.deepEqual(seriesWeeks(1, 53), []);
  const windows = seriesWeeks(5, 9).map((w) => courseWeekWindow({ startsOn: FALL.startsOn, week: w })!);
  assert.equal(new Set(windows.map((w) => w.dueAt)).size, 5);
  assert.equal(addDays("2026-10-31", 2), "2026-11-02");
});

test("status derivation", () => {
  const opensAt = "2026-10-19T04:00:00.000Z";
  const dueAt = "2026-10-26T03:59:00.000Z"; // Sun Oct 25, 11:59 PM ET
  const at = (iso: string) => new Date(iso);
  assert.equal(deriveStatus({ opensAt, dueAt, now: at("2026-10-18T12:00:00Z") }), "upcoming");
  assert.equal(deriveStatus({ opensAt, dueAt, now: at("2026-10-20T12:00:00Z") }), "open");
  assert.equal(deriveStatus({ opensAt, dueAt, now: at("2026-10-25T14:00:00Z") }), "due_today");
  // Saturday night ET is not "today" for a Sunday deadline.
  assert.equal(deriveStatus({ opensAt, dueAt, now: at("2026-10-25T03:00:00Z") }), "open");
  assert.equal(deriveStatus({ opensAt, dueAt, now: at("2026-10-26T04:00:00Z") }), "missing");
  assert.equal(deriveStatus({ opensAt: null, dueAt: null, now: at("2030-01-01T00:00:00Z") }), "open");
  const late = { status: "submitted" as const, late: true };
  assert.equal(deriveStatus({ opensAt, dueAt, submission: late }), "late");
  assert.equal(deriveStatus({ opensAt, dueAt, submission: { status: "submitted", late: false } }), "submitted");
  assert.equal(deriveStatus({ opensAt, dueAt, submission: { status: "returned", late: false } }), "returned");
  assert.equal(deriveStatus({ opensAt, dueAt, submission: { status: "reviewed", late: true } }), "reviewed");
  assert.equal(deriveStatus({ opensAt, dueAt, submission: { status: "excused", late: false } }), "excused");
  assert.equal(statusLabel("missing"), "Late");
  assert.equal(statusLabel("missing", "staff"), "Missing");
  assert.equal(canEditSubmission("returned"), true);
  assert.equal(canEditSubmission("reviewed"), false);
  assert.equal(canEditSubmission(null), true);
});

test("a late entrant is excused from work due before they enrolled", () => {
  const dueAt = "2026-09-21T03:59:00.000Z"; // week 1
  const now = new Date("2026-10-14T16:00:00Z");
  assert.equal(deriveStatus({ opensAt: null, dueAt, enrolledAt: "2026-10-01T15:00:00Z", now }), "excused");
  assert.equal(deriveStatus({ opensAt: null, dueAt, enrolledAt: "2026-09-01T15:00:00Z", now }), "missing");
  // They can still hand it in, and then it counts.
  assert.equal(
    deriveStatus({ opensAt: null, dueAt, enrolledAt: "2026-10-01T15:00:00Z", submission: { status: "submitted", late: true }, now }),
    "late",
  );
});

test("student groups: due soon, upcoming, done", () => {
  const now = new Date("2026-10-14T16:00:00Z");
  assert.equal(studentGroup("missing", "2026-10-12T03:59:00Z", now), "due");
  assert.equal(studentGroup("open", "2026-10-19T03:59:00Z", now), "due");
  assert.equal(studentGroup("open", "2026-11-12T01:00:00Z", now), "upcoming");
  assert.equal(studentGroup("open", null, now), "upcoming");
  assert.equal(studentGroup("returned", "2026-11-12T01:00:00Z", now), "due");
  assert.equal(studentGroup("excused", null, now), "done");
  assert.equal(studentGroup("late", null, now), "done");
});

test("links are https only", () => {
  assert.deepEqual(normalizeLink(""), { ok: true, url: null });
  assert.deepEqual(normalizeLink(" https://docs.google.com/document/d/abc/edit "), {
    ok: true,
    url: "https://docs.google.com/document/d/abc/edit",
  });
  assert.equal(normalizeLink("http://example.com").ok, false);
  assert.equal(normalizeLink("javascript:alert(1)").ok, false);
  assert.equal(normalizeLink("https://exa mple.com").ok, false);
  assert.equal(normalizeLink("https://user:pw@example.com").ok, false);
  assert.equal(normalizeLink("https://localhost/x").ok, false);
  assert.equal(normalizeLink(`https://example.com/${"a".repeat(2100)}`).ok, false);
  assert.equal(isGoogleLink("https://drive.google.com/drive/folders/x"), true);
  assert.equal(isGoogleLink("https://example.com"), false);
});

test("submission rules per type", () => {
  assert.deepEqual(validateSubmission({ type: "link", body: "notes", link: "https://a.co/x" }), {
    ok: true,
    body: "notes",
    link: "https://a.co/x",
  });
  assert.equal(validateSubmission({ type: "link", body: "only text" }).ok, false);
  assert.equal(validateSubmission({ type: "text", body: "  " }).ok, false);
  // A text-only assignment ignores a link rather than storing it.
  assert.deepEqual(validateSubmission({ type: "text", body: "hi", link: "http://bad" }), { ok: true, body: "hi", link: null });
  assert.equal(validateSubmission({ type: "text_or_link" }).ok, false);
  assert.equal(validateSubmission({ type: "text_or_link", link: "http://x.co" }).ok, false);
  assert.equal(validateSubmission({ type: "text_or_link", body: "x".repeat(10001) }).ok, false);
});

test("matrix: audience, excusal, missing counts", () => {
  const now = new Date("2026-10-14T16:00:00Z");
  const w4 = { id: "w4", opensAt: "2026-10-05T04:00:00Z", dueAt: "2026-10-12T03:59:00Z", audience: "cohort" as const };
  const w5 = { id: "w5", opensAt: "2026-10-12T04:00:00Z", dueAt: "2026-10-19T03:59:00Z", audience: "cohort" as const };
  const w3 = { id: "w3", opensAt: "2026-09-28T04:00:00Z", dueAt: "2026-10-05T03:59:00Z", audience: "cohort" as const };
  const solo = { id: "solo", opensAt: null, dueAt: "2026-10-10T03:59:00Z", audience: "students" as const };
  const rows = buildMatrix({
    assignments: [w3, w4, w5, solo],
    students: [
      { userId: "ana", enrolledAt: "2026-09-01T00:00:00Z" },
      { userId: "ben", enrolledAt: "2026-10-08T00:00:00Z" }, // late entrant: w3 excused
    ],
    submissions: [{ assignmentId: "w4", userId: "ben", status: "submitted", late: true }],
    targets: new Map([["solo", new Set(["ana"])]]),
    now,
  });
  const ana = rows.find((r) => r.userId === "ana")!;
  const ben = rows.find((r) => r.userId === "ben")!;
  assert.deepEqual(ana.cells, { w3: "missing", w4: "missing", w5: "open", solo: "missing" });
  assert.equal(ana.missing, 3);
  assert.deepEqual(ben.cells, { w3: "excused", w4: "late", w5: "open", solo: null });
  assert.equal(ben.missing, 0);
  assert.equal(ben.done, 2);
  assert.equal(rows.filter((r) => r.missing >= 2).length, 1);
});

test("admin form normalisation", () => {
  const now = new Date("2026-10-14T16:00:00Z");
  const base = { title: "Weekly update", submissionType: "text_or_link" as const, audience: "cohort" as const, status: "published" as const };
  const week = normalizeDraft({ ...base, release: "course_week", week: 7 }, { startsOn: FALL.startsOn, now });
  assert.ok(week.ok);
  assert.equal(week.ok && week.value.dueAt, "2026-11-02T04:59:00.000Z");
  assert.equal(week.ok && week.value.dueLocalTime, "23:59");
  const dated = normalizeDraft(
    { ...base, release: "date", opensDate: "2026-11-01", opensTime: "09:00", dueDate: "2026-11-11", dueTime: "20:00" },
    { startsOn: FALL.startsOn, now },
  );
  assert.ok(dated.ok);
  assert.equal(dated.ok && dated.value.opensAt, "2026-11-01T14:00:00.000Z");
  assert.equal(dated.ok && dated.value.dueAt, "2026-11-12T01:00:00.000Z");
  const instant = normalizeDraft({ ...base, release: "now" }, { startsOn: FALL.startsOn, now });
  assert.equal(instant.ok && instant.value.opensAt, now.toISOString());
  assert.equal(instant.ok && instant.value.dueAt, null);
  assert.equal(normalizeDraft({ ...base, title: " " , release: "now" }, { startsOn: null }).ok, false);
  assert.equal(normalizeDraft({ ...base, release: "course_week", week: 3 }, { startsOn: null }).ok, false);
  assert.equal(
    normalizeDraft({ ...base, release: "date", opensDate: "2026-11-12", dueDate: "2026-11-11" }, { startsOn: null }).ok,
    false,
  );
});
