import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isSunday,
  upcomingSundays,
  webinarWeek,
  webinarTitle,
  localDateTime,
  localHhmm,
  localYmd,
} from "./webinar-schedule.ts";

// Run with `npm test`. Dates below are built with the local-time constructor
// so the assertions hold in whatever zone the test runs in — the module works
// in the scheduler's local calendar, and so must the tests.

// Tuesday Sep 15 2026, mid-morning — the day this rule was written down.
const TUESDAY = new Date(2026, 8, 15, 10, 30);

test("isSunday is about the local calendar", () => {
  assert.equal(isSunday(new Date(2026, 8, 20, 12)), true); // Sun Sep 20
  assert.equal(isSunday(new Date(2026, 8, 19, 23, 59)), false); // Sat
  assert.equal(isSunday(new Date(2026, 8, 21, 0, 0)), false); // Mon
});

test("upcomingSundays starts at the next Sunday and steps by a week", () => {
  assert.deepEqual(upcomingSundays(TUESDAY, 4), [
    "2026-09-20",
    "2026-09-27",
    "2026-10-04",
    "2026-10-11",
  ]);
});

test("upcomingSundays includes today when today is a Sunday", () => {
  const sundayEvening = new Date(2026, 8, 20, 21, 0);
  assert.deepEqual(upcomingSundays(sundayEvening, 2), [
    "2026-09-20",
    "2026-09-27",
  ]);
});

test("upcomingSundays offers Sunday when asked on a Saturday", () => {
  assert.deepEqual(upcomingSundays(new Date(2026, 8, 19, 8), 1), [
    "2026-09-20",
  ]);
});

test("upcomingSundays crosses a DST change without drifting", () => {
  // US clocks fall back on Nov 1 2026. Stepping by calendar days, not by
  // 7×24h, keeps every entry a real Sunday on both sides of it.
  const sundays = upcomingSundays(new Date(2026, 9, 20), 4);
  assert.deepEqual(sundays, [
    "2026-10-25",
    "2026-11-01",
    "2026-11-08",
    "2026-11-15",
  ]);
  for (const ymd of sundays) {
    assert.equal(isSunday(localDateTime(ymd, "12:00")), true, ymd);
  }
});

test("webinarWeek counts from the cohort start, one-based", () => {
  // Cohort starts Monday Sep 14: the Sunday that closes week 1 is Sep 20.
  assert.equal(webinarWeek("2026-09-20", "2026-09-14"), 1);
  assert.equal(webinarWeek("2026-09-27", "2026-09-14"), 2);
  assert.equal(webinarWeek("2026-10-04", "2026-09-14"), 3);
  // A cohort that starts on the Sunday itself is in week 1 that day.
  assert.equal(webinarWeek("2026-09-20", "2026-09-20"), 1);
});

test("webinarWeek is null before the cohort starts or without a start", () => {
  assert.equal(webinarWeek("2026-09-13", "2026-09-14"), null);
  assert.equal(webinarWeek("2026-09-20", null), null);
  assert.equal(webinarWeek("2026-09-20", undefined), null);
  assert.equal(webinarWeek("2026-09-20", "not a date"), null);
});

test("webinarTitle names by week, falling back to the date", () => {
  assert.equal(webinarTitle("2026-09-20", 1), "Week 1 Webinar");
  assert.equal(webinarTitle("2026-10-04", 3), "Week 3 Webinar");
  assert.equal(webinarTitle("2026-10-04", null), "Sunday Webinar · Oct 4");
});

test("localDateTime and localHhmm round-trip a picked time", () => {
  const d = localDateTime("2026-09-20", "19:30");
  assert.equal(localYmd(d), "2026-09-20");
  assert.equal(localHhmm(d), "19:30");
  assert.equal(isSunday(d), true);
});
