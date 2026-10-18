import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  EVENT_HISTORY_MAX_PAGE,
  EVENT_HISTORY_PAGE_SIZE,
  emptyHistoryMessage,
  eventCohortIds,
  eventVisibilityScopes,
  historyHref,
  historyRange,
  needsRecordingLookup,
  parseHistoryPage,
  parseHistoryShow,
  pastHistoryRows,
  recordingLink,
  recordingOrFilter,
  takePage,
  visibleHistory,
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

  // A pasted link is an href only when it's https (httpsUrl): anything else
  // is no recording, not a link to tap.
  for (const bad of ["javascript:alert(1)", "http://video.test/p", "video.test/p"]) {
    const row = ev("bad", 1, { live_mode: "external", recording_url: bad });
    assert.equal(recordingLink(row, new Set()), null, bad);
    assert.deepEqual(visibleHistory([row], "recordings", new Set(), (e) => e), [], bad);
  }

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

// ---- Whose events the installed app reads ----
//
// /app/events reads with the service role, so its filter IS the `events read`
// policy there. It used to scope by access.cohortId: one cohort, the soonest
// ahead of the student, which can be one they are only accepted into.

const A = "aaaaaaaa-0000-4000-8000-000000000001"; // started, enrolled
const B = "bbbbbbbb-0000-4000-8000-000000000002"; // upcoming, accepted only
const C = "cccccccc-0000-4000-8000-000000000003"; // a returning student's first cohort
const D = "dddddddd-0000-4000-8000-000000000004"; // someone else's

/**
 * Just enough of PostgREST's `or=` logic tree to run the strings this module
 * builds: a top-level `or` of `and(...)` groups over `col.eq.v`,
 * `col.in.(a,b)` and `col.not.is.null`.
 */
function splitTop(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of s) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out;
}
function holds(cond: string, row: Record<string, unknown>): boolean {
  if (cond.startsWith("and(") && cond.endsWith(")")) {
    return splitTop(cond.slice(4, -1)).every((c) => holds(c, row));
  }
  const m = /^([a-z_]+)\.(not\.)?(eq|in|is)\.(.+)$/.exec(cond);
  assert.ok(m, `unparsed condition ${cond}`);
  const [, col, not, op, val] = m;
  const v = row[col];
  const hit =
    op === "eq"
      ? v != null && String(v) === val
      : op === "in"
        ? v != null && val.slice(1, -1).split(",").includes(String(v))
        : val === "null" && v == null;
  return not ? !hit : hit;
}
const matchesOr = (filter: string, row: Record<string, unknown>) =>
  splitTop(filter).some((c) => holds(c, row));

test("cohort ids: every enrollment, sorted and deduped, non-uuids dropped", () => {
  assert.deepEqual(eventCohortIds([C, A, null, A.toUpperCase(), undefined, "", "x),or(1"]), [A, C]);
  assert.deepEqual(eventCohortIds([]), []);
  assert.deepEqual(eventVisibilityScopes([]), ["visibility.eq.public"]);
  assert.deepEqual(eventVisibilityScopes([C, A]), [
    "visibility.eq.public",
    `visibility.eq.enrolled,cohort_id.in.(${A},${C})`,
  ]);
  // Order in, same scope out: it is the cache key.
  assert.deepEqual(eventVisibilityScopes([A, C]), eventVisibilityScopes([C, A, C]));
});

test("app recordings match what RLS lets the student watch: every enrolled cohort, never an accepted-only one", () => {
  const events = [
    { id: "pub", visibility: "public", cohort_id: null, recording_url: "https://v.test/pub" },
    { id: "a", visibility: "enrolled", cohort_id: A, recording_url: "https://v.test/a" },
    { id: "a-hosted", visibility: "enrolled", cohort_id: A, recording_url: null, live_mode: "hosted", assets_shared_at: "2026-09-01T00:00:00Z" },
    { id: "a-none", visibility: "enrolled", cohort_id: A, recording_url: null, live_mode: "external" },
    { id: "b", visibility: "enrolled", cohort_id: B, recording_url: "https://v.test/b" },
    { id: "c", visibility: "enrolled", cohort_id: C, recording_url: "https://v.test/c" },
    { id: "d", visibility: "enrolled", cohort_id: D, recording_url: "https://v.test/d" },
  ].map((e) => ({ live_mode: null, assets_shared_at: null, ...e }));
  const enrolledIn = [A, C];
  // The `events read` policy (0098), for a signed-in non-staff student.
  const rlsAllows = (e: (typeof events)[number]) =>
    e.visibility === "public" ||
    (e.visibility === "enrolled" && enrolledIn.includes(e.cohort_id as string));
  const watchable = (e: (typeof events)[number]) =>
    !!e.recording_url || needsRecordingLookup(e);

  const now = recordingOrFilter(eventVisibilityScopes(enrolledIn));
  assert.deepEqual(
    events.filter((e) => matchesOr(now, e)).map((e) => e.id),
    events.filter((e) => rlsAllows(e) && watchable(e)).map((e) => e.id),
  );
  assert.deepEqual(events.filter((e) => matchesOr(now, e)).map((e) => e.id), ["pub", "a", "a-hosted", "c"]);

  // What the old access.cohortId scope (B: the soonest cohort ahead) read:
  // B's recordings, which RLS denies, and none of A's or C's.
  const before = recordingOrFilter(["visibility.eq.public", `visibility.eq.enrolled,cohort_id.eq.${B}`]);
  assert.deepEqual(events.filter((e) => matchesOr(before, e)).map((e) => e.id), ["pub", "b"]);

  // Staff, or a student with no enrollment rows: public only.
  const none = recordingOrFilter(eventVisibilityScopes([]));
  assert.deepEqual(events.filter((e) => matchesOr(none, e)).map((e) => e.id), ["pub"]);
});

test("both app screens scope events by enrollments, not access.cohortId", () => {
  for (const page of ["events", "home"]) {
    const src = readFileSync(new URL(`../app/app/(student)/${page}/page.tsx`, import.meta.url), "utf8");
    assert.ok(/enrolledCohortIds\(\)/.test(src), `${page} reads the enrolled cohorts`);
    assert.ok(
      !/getCohort(Events|Recordings)\(\{\s*cohortId\s*[},]/.test(src),
      `${page} scopes events by one cohort`,
    );
    assert.ok(!/cohortId: access\.cohortId/.test(src), `${page} scopes events by access.cohortId`);
  }
});

// ---- /dashboard/events' past list, composed ----

test("past rows: the last day's ended sessions lead page one only", () => {
  const lastDay = [ev("y2", 20), ev("y1", 19)];
  const older = [ev("o1", 10), ev("o2", 9)];
  assert.deepEqual(pastHistoryRows(1, lastDay, older).map((e) => e.id), ["y2", "y1", "o1", "o2"]);
  assert.deepEqual(pastHistoryRows(2, lastDay, older).map((e) => e.id), ["o1", "o2"]);
  assert.deepEqual(pastHistoryRows(1, [], []), []);
});

test("recordings view: a shared hosted session without a take drops; pasted links and real takes stay", () => {
  const rows = [
    { e: ev("link", 5, { recording_url: "https://v.test/l" }) },
    { e: ev("take", 4, { assets_shared_at: "2026-09-04T00:00:00Z" }) },
    { e: ev("no-take", 3, { assets_shared_at: "2026-09-03T00:00:00Z" }) },
    { e: ev("plain", 2) },
  ];
  const recorded = new Set(["take"]);
  assert.deepEqual(
    visibleHistory(rows, "recordings", recorded, (r) => r.e).map((r) => r.e.id),
    ["link", "take"],
  );
  assert.deepEqual(visibleHistory(rows, "all", recorded, (r) => r.e).length, 4);
});

test("empty page: never \"No recordings yet.\" above an Older page that has some", () => {
  // Page one came back as eleven shared-but-untaken hosted sessions: the
  // filter drops all ten shown, and the lookahead row says more exist.
  const page1 = Array.from({ length: 11 }, (_, i) =>
    ev(`s${i}`, 28 - i, { assets_shared_at: "2026-09-01T00:00:00Z" }),
  );
  const { rows, hasMore } = takePage(page1);
  const shown = visibleHistory(rows, "recordings", new Set(), (e) => e);
  assert.equal(shown.length, 0);
  assert.equal(hasMore, true);
  assert.equal(emptyHistoryMessage({ show: "recordings", page: 1, hasMore }), "No recordings on this page.");

  assert.equal(emptyHistoryMessage({ show: "recordings", page: 1, hasMore: false }), "No recordings yet.");
  assert.equal(emptyHistoryMessage({ show: "recordings", page: 3, hasMore: false }), "No recordings on this page.");
  assert.equal(emptyHistoryMessage({ show: "all", page: 2, hasMore: false }), "Nothing older.");
});
