import { test } from "node:test";
import assert from "node:assert/strict";
import {
  EVENT_HISTORY_MAX_PAGE,
  EVENT_HISTORY_PAGE_SIZE,
  historyHref,
  historyRange,
  needsRecordingLookup,
  parseHistoryPage,
  parseHistoryShow,
  recordingLink,
  recordingOrFilter,
  takePage,
} from "./event-history.ts";

// Run with `npm test`. Both events lists used to cut history before choosing
// what to show (ten rows on /dashboard/events; five on /app/events, filtered
// for recordings afterwards), so older recordings could not be reached.

type Ev = {
  id: string;
  starts_at: string;
  recording_url: string | null;
  live_mode: string | null;
  assets_shared_at: string | null;
};

const ev = (id: string, day: number, extra: Partial<Ev> = {}): Ev => ({
  id,
  starts_at: new Date(Date.UTC(2026, 8, day)).toISOString(),
  recording_url: null,
  live_mode: "hosted",
  assets_shared_at: null,
  ...extra,
});

test("page params: missing, malformed and absurd values fall back safely", () => {
  assert.equal(parseHistoryPage(undefined), 1);
  assert.equal(parseHistoryPage(""), 1);
  assert.equal(parseHistoryPage("0"), 1);
  assert.equal(parseHistoryPage("-2"), 1);
  assert.equal(parseHistoryPage("2.5"), 1);
  assert.equal(parseHistoryPage("abc"), 1);
  assert.equal(parseHistoryPage("3"), 3);
  assert.equal(parseHistoryPage(["4", "9"]), 4);
  assert.equal(parseHistoryPage("999999"), EVENT_HISTORY_MAX_PAGE);
  assert.equal(parseHistoryShow("recordings"), "recordings");
  assert.equal(parseHistoryShow("RECORDINGS"), "all");
  assert.equal(parseHistoryShow(undefined), "all");
});

test("range: one page plus one row of lookahead, contiguous across pages", () => {
  assert.deepEqual(historyRange(1), { from: 0, to: EVENT_HISTORY_PAGE_SIZE });
  assert.deepEqual(historyRange(2), { from: EVENT_HISTORY_PAGE_SIZE, to: 2 * EVENT_HISTORY_PAGE_SIZE });
  assert.deepEqual(historyRange(0, 5), { from: 0, to: 5 });
  const full = Array.from({ length: 11 }, (_, i) => i);
  assert.deepEqual(takePage(full), { rows: full.slice(0, 10), hasMore: true });
  assert.deepEqual(takePage(full.slice(0, 10)), { rows: full.slice(0, 10), hasMore: false });
});

test("paging walks every recording, however many unrecorded sessions came after it", () => {
  // 30 sessions, newest first; only the three oldest were recorded. The old
  // installed app read the newest five and found nothing to list.
  const history = Array.from({ length: 30 }, (_, i) =>
    ev(`s${i}`, 30 - i, i >= 27 ? { recording_url: `https://video.test/${i}` } : {}),
  );
  const oldPick = history.slice(0, 5).filter((e) => recordingLink(e, new Set()));
  assert.equal(oldPick.length, 0);

  // The query now filters first; simulate it, then page through.
  const matching = history.filter((e) => e.recording_url || needsRecordingLookup(e));
  const seen: string[] = [];
  for (let page = 1; ; page++) {
    const { from, to } = historyRange(page, 2);
    const { rows, hasMore } = takePage(matching.slice(from, to + 1), 2);
    seen.push(...rows.map((e) => e.id));
    if (!hasMore) break;
  }
  assert.deepEqual(seen, ["s27", "s28", "s29"]);
});

test("filter: two recording kinds, or their product with visibility in one flat or", () => {
  assert.equal(
    recordingOrFilter(),
    "recording_url.not.is.null,and(assets_shared_at.not.is.null,live_mode.in.(hosted,premiere))",
  );
  assert.equal(
    recordingOrFilter(["visibility.eq.public", "visibility.eq.enrolled,cohort_id.eq.c1"]),
    [
      "and(visibility.eq.public,recording_url.not.is.null)",
      "and(visibility.eq.public,assets_shared_at.not.is.null,live_mode.in.(hosted,premiere))",
      "and(visibility.eq.enrolled,cohort_id.eq.c1,recording_url.not.is.null)",
      "and(visibility.eq.enrolled,cohort_id.eq.c1,assets_shared_at.not.is.null,live_mode.in.(hosted,premiere))",
    ].join(","),
  );
});

test("recording link: a pasted link, else the room's own once a take exists", () => {
  const pasted = ev("p", 1, { live_mode: "external", recording_url: "https://video.test/p" });
  assert.deepEqual(recordingLink(pasted, new Set()), { href: "https://video.test/p", external: true });
  assert.equal(needsRecordingLookup(pasted), false);

  const shared = ev("w/1", 2, { assets_shared_at: "2026-09-02T12:00:00Z" });
  assert.equal(needsRecordingLookup(shared), true);
  assert.equal(recordingLink(shared, new Set()), null, "shared, but no take yet");
  assert.deepEqual(recordingLink(shared, new Set(["w/1"])), {
    href: "/dashboard/events/w%2F1/live",
    external: false,
  });

  // Not shared yet, or not batch0's room: nothing to look up or play.
  const unshared = ev("u", 3);
  assert.equal(needsRecordingLookup(unshared), false);
  assert.equal(recordingLink(unshared, new Set(["u"])), null);
  const external = ev("x", 4, { live_mode: "external", assets_shared_at: "2026-09-04T12:00:00Z" });
  assert.equal(recordingLink(external, new Set(["x"])), null);
  assert.equal(needsRecordingLookup(ev("pr", 5, { live_mode: "premiere", assets_shared_at: "x" })), true);
});

test("href: defaults stay out of the URL", () => {
  assert.equal(historyHref("/dashboard/events", { page: 1, show: "all" }), "/dashboard/events");
  assert.equal(
    historyHref("/dashboard/events", { page: 3, show: "recordings" }),
    "/dashboard/events?show=recordings&page=3",
  );
  assert.equal(historyHref("/app/events", { page: 2, show: "all" }), "/app/events?page=2");
});
