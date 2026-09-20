import { test } from "node:test";
import assert from "node:assert/strict";
import { easternDeadline, formatUsd, sessionTime, visibleSchedule } from "./offer-format.ts";

test("tuition preserves the exact Winter and discounted cents", () => {
  assert.equal(formatUsd(15099), "$150.99");
  assert.equal(formatUsd(12999), "$129.99");
  assert.equal(formatUsd(13000), "$130");
  assert.equal(formatUsd(0), "$0");
});
test("late deadline stays September 22 in Eastern, not September 23 UTC", () => {
  assert.equal(easternDeadline("2026-09-23T03:59:59Z"), "Sep 22, 11:59 PM EDT");
});
test("public calendar filters stale/out-of-cohort dates and orders actual sessions", () => {
  const row = (id: string, starts_at: string) => ({id, starts_at, title: "Session", type: "workshop", ends_at: null});
  const rows = [row("end", "2026-11-14T01:00:00Z"), row("bad", "bad"), row("old", "2026-09-01T20:00:00Z"), row("start", "2026-09-22T00:00:00Z"), row("next", "2026-12-15T01:00:00Z")];
  assert.deepEqual(visibleSchedule(rows, "2026-09-14", "2026-11-13").map(row => row.id), ["start", "end"]);
  assert.deepEqual(visibleSchedule(rows, null, null), []);
});
test("calendar preserves 8 PM Eastern across November daylight saving change", () => {
  assert.match(sessionTime({id:"1",title:"Workshop",type:"workshop",starts_at:"2026-10-27T00:00:00Z",ends_at:"2026-10-27T01:00:00Z"}), /Mon, Oct 26 · 8:00 PM–9:00 PM EDT/);
  assert.match(sessionTime({id:"2",title:"Demo",type:"demo_day",starts_at:"2026-11-14T01:00:00Z",ends_at:"2026-11-14T02:00:00Z"}), /Fri, Nov 13 · 8:00 PM–9:00 PM EST/);
});
