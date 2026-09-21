import test from "node:test";
import assert from "node:assert/strict";
import { revenueInPeriod, revenuePeriods } from "./revenue-periods.ts";

test("Sunday evening's $78 stays in the previous Eastern week, even after UTC Monday begins", () => {
  const periods = revenuePeriods(new Date("2026-09-21T02:00:00Z")); // Still Sunday in New York.
  const payment = [{ paid_at: "2026-09-14T01:51:08Z", amount_cents: 7800 }];
  assert.equal(periods.current.start.toISOString(), "2026-09-14T04:00:00.000Z");
  assert.equal(periods.current.end.toISOString(), "2026-09-21T04:00:00.000Z");
  assert.equal(revenueInPeriod(payment, periods.current), 0);
  assert.equal(revenueInPeriod(payment, periods.previous), 7800);
  assert.equal(periods.weeks.at(-1)!.key, "2026-09-14");
  assert.equal(revenueInPeriod(payment, periods.weeks.at(-1)!), 0);
  assert.equal(revenueInPeriod(payment, periods.weeks.at(-2)!), 7800);
});

test("Eastern Monday midnight is inclusive and belongs to exactly one weekly bucket", () => {
  const periods = revenuePeriods(new Date("2026-09-21T04:00:00Z"));
  const rows = [
    { paid_at: "2026-09-21T03:59:59.999Z", amount_cents: 100 },
    { paid_at: "2026-09-21T04:00:00.000Z", amount_cents: 200 },
    { paid_at: null, amount_cents: 99999 },
  ];
  assert.equal(periods.weeks.at(-1)!.key, "2026-09-21");
  assert.equal(revenueInPeriod(rows, periods.weeks.at(-1)!), 200);
  assert.equal(revenueInPeriod(rows, periods.weeks.at(-2)!), 100);
});

test("spring daylight-saving week covers seven calendar days in 167 hours", () => {
  const periods = revenuePeriods(new Date("2026-03-08T18:00:00Z"));
  assert.equal(periods.current.start.toISOString(), "2026-03-02T05:00:00.000Z");
  assert.equal(periods.current.end.toISOString(), "2026-03-09T04:00:00.000Z");
  assert.equal((+periods.current.end - +periods.current.start) / 3600000, 167);
  assert.equal(+periods.previous.end, +periods.current.start);
  assert.equal((+periods.weeks.at(-1)!.end - +periods.weeks.at(-1)!.start) / 3600000, 167);
});

test("fall daylight-saving week covers seven calendar days in 169 hours and includes both repeated hours", () => {
  const periods = revenuePeriods(new Date("2026-11-01T18:00:00Z"));
  assert.equal(periods.current.start.toISOString(), "2026-10-26T04:00:00.000Z");
  assert.equal(periods.current.end.toISOString(), "2026-11-02T05:00:00.000Z");
  assert.equal((+periods.current.end - +periods.current.start) / 3600000, 169);
  assert.equal(revenueInPeriod([
    { paid_at: "2026-11-01T05:30:00Z", amount_cents: 100 },
    { paid_at: "2026-11-01T06:30:00Z", amount_cents: 200 },
  ], periods.current), 300);
  assert.equal((+periods.weeks.at(-1)!.end - +periods.weeks.at(-1)!.start) / 3600000, 169);
});
