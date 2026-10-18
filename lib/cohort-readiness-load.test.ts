import { test } from "node:test";
import assert from "node:assert/strict";
import { courseWeekStart, courseWeekWindow, easternToUtc } from "./assignments.ts";
import type { Bucket, CheckId, CohortReadiness, ReadinessCheck } from "./cohort-readiness.ts";
import { capabilitiesFrom, type Capabilities } from "./permissions.ts";
import {
  READINESS_TIMEOUTS,
  SIGN_BATCH,
  loadCohortReadiness,
  sharedEventSpan,
  type ReadinessCohortRow,
} from "./cohort-readiness-load.ts";

// Winter (upcoming, Dec 14 – Feb 12) and Fall (active, Sep 14 – Nov 13) on
// one page, checked on Oct 17 — production's shape when this shipped.
const NOW = new Date("2026-10-17T16:00:00Z");
const WINTER = "c0000000-0000-4000-8000-00000000000w";
const FALL = "c0000000-0000-4000-8000-00000000000f";
const SPRING = "c0000000-0000-4000-8000-00000000000s";
const W_START = "2026-12-14";
const W_END = "2027-02-12";

const ALL: Capabilities = { role: "admin", permissions: [], superAdmin: true };

function cohortRows(): ReadinessCohortRow[] {
  return [
    {
      id: FALL,
      name: "Fall 2026",
      status: "active",
      starts_on: "2026-09-14",
      ends_on: "2026-11-13",
      capacity: 24,
      price_cents: 13000,
      applications_close_at: "2026-10-09T23:59:00Z",
      enrollments: [{ count: 18 }],
    },
    {
      id: WINTER,
      name: "Winter 2026",
      status: "upcoming",
      starts_on: W_START,
      ends_on: W_END,
      capacity: 24,
      price_cents: 13000,
      applications_close_at: "2026-12-12T23:59:00Z",
      enrollments: [{ count: 6 }],
    },
    // Nothing left to launch: no checklist, no queries on its behalf.
    { id: SPRING, name: "Spring 2026", status: "completed", starts_on: "2026-03-02", ends_on: "2026-05-01", capacity: 24, price_cents: 13000 },
  ];
}

type Row = Record<string, unknown>;

/** Nine weekly modules, each with one lesson carrying `perLesson` materials. */
function moduleRows(cohortId: string, prefix: string, weeks = 9, perLesson = 1): Row[] {
  return Array.from({ length: weeks }, (_, i) => ({
    id: `${prefix}-m${i + 1}`,
    cohort_id: cohortId,
    week: i + 1,
    title: `Week ${i + 1}`,
    position: 0,
    lessons: [
      {
        id: `${prefix}-l${i + 1}`,
        title: `Lesson ${i + 1}`,
        position: 0,
        description: "Read this.",
        video_path: null,
        video_url: null,
        materials: Array.from({ length: perLesson }, (_, j) => ({
          title: `Handout ${j + 1}`,
          path: `${prefix}/week-${i + 1}/handout-${j + 1}.pdf`,
        })),
      },
    ],
  }));
}

function weeklyAssignments(cohortId: string, prefix: string): Row[] {
  return Array.from({ length: 9 }, (_, i) => {
    const w = courseWeekWindow({ startsOn: W_START, endsOn: W_END, week: i + 1 })!;
    return {
      id: `${prefix}-a${i + 1}`,
      cohort_id: cohortId,
      title: "Weekly update",
      status: "published",
      module_id: null,
      lesson_id: null,
      week: i + 1,
      opens_at: w.opensAt,
      due_at: w.dueAt,
    };
  });
}

function mondayEvents(cohortId: string | null, prefix: string, visibility = "enrolled"): Row[] {
  return Array.from({ length: 9 }, (_, i) => {
    const startsAt = easternToUtc(courseWeekStart(W_START, i + 1)!, "20:00")!;
    return {
      id: `${prefix}-e${i + 1}`,
      cohort_id: cohortId,
      title: "Workshop",
      visibility,
      live_mode: "hosted",
      starts_at: startsAt,
      ends_at: new Date(Date.parse(startsAt) + 3_600_000).toISOString(),
      zoom_url: null,
      live_ended_at: null,
    };
  });
}

const KICKOFF_ROW = {
  headline: null,
  intro: null,
  time_label: "Mondays, 8–9 p.m. Eastern",
  location_label: "Live inside batch0",
  join_url: "/dashboard/events",
  agenda: null,
  checklist: null,
  note: null,
};

function tables(): Record<string, Row[]> {
  const winterModules = moduleRows(WINTER, "winter");
  return {
    modules: [...winterModules, ...moduleRows(FALL, "fall", 3)],
    resources: [],
    course_assignments: [
      ...weeklyAssignments(WINTER, "winter"),
      // Archived rows are filtered out by the query, so this never counts.
      { ...weeklyAssignments(WINTER, "winter")[0], id: "gone", status: "archived", due_at: "2026-01-01T00:00:00Z" },
    ],
    events: mondayEvents(WINTER, "winter"),
    cohort_kickoff: [{ cohort_id: WINTER, ...KICKOFF_ROW }],
  };
}

/** Every object the fixtures reference, so storage starts out complete. */
function objectsFor(t: Record<string, Row[]>): Record<Bucket, Set<string>> {
  const materials = new Set<string>();
  const videos = new Set<string>();
  for (const m of t.modules) {
    for (const l of m.lessons as Row[]) {
      if (l.video_path) videos.add(l.video_path as string);
      for (const mat of (l.materials as Row[]) ?? []) materials.add(mat.path as string);
    }
  }
  const resources = new Set(t.resources.map((r) => r.storage_path as string).filter(Boolean));
  return { "course-materials": materials, "course-videos": videos, resources };
}

// ---------------------------------------------------------------------------
// A fake client: just enough PostgREST and Storage for the loader
// ---------------------------------------------------------------------------

type Filter = [op: "in" | "eq" | "neq" | "is" | "gte" | "lte", col: string, value: unknown];
type Fault = { error?: { code?: string; message: string }; hang?: true; throws?: string };
type StorageFault = "error" | "hang" | "throw";

function compare(a: unknown, b: unknown): number {
  const x = Date.parse(String(a));
  const y = Date.parse(String(b));
  return Number.isFinite(x) && Number.isFinite(y) ? x - y : String(a).localeCompare(String(b));
}

function matches(row: Row, [op, col, value]: Filter): boolean {
  const v = row[col];
  if (op === "in") return (value as unknown[]).includes(v);
  if (op === "eq") return v === value;
  if (op === "neq") return v !== value;
  if (op === "is") return v == null && value === null;
  if (op === "gte") return v != null && compare(v, value) >= 0;
  return v != null && compare(v, value) <= 0;
}

function fakeDb(
  data: Record<string, Row[]>,
  opts: {
    objects?: Record<Bucket, Set<string>>;
    /** Keyed by table, or "events:shared" for the cohort-less events read. */
    faults?: Record<string, Fault>;
    storage?: Partial<Record<Bucket, StorageFault>>;
    /** Thrown from from(table) itself, before any query runs. */
    throwOn?: string;
  } = {},
) {
  const objects = opts.objects ?? objectsFor(data);
  const calls = {
    queries: [] as { key: string; select: string; filters: Filter[]; signal: boolean }[],
    sign: [] as { bucket: Bucket; paths: string[] }[],
  };
  const client = {
    from(table: string) {
      if (opts.throwOn === table) throw new Error(`boom: ${table}`);
      const filters: Filter[] = [];
      let select = "";
      let signal: AbortSignal | null = null;
      const builder = {
        select(cols: string) {
          select = cols;
          return builder;
        },
        in: (col: string, v: unknown[]) => (filters.push(["in", col, v]), builder),
        eq: (col: string, v: unknown) => (filters.push(["eq", col, v]), builder),
        neq: (col: string, v: unknown) => (filters.push(["neq", col, v]), builder),
        is: (col: string, v: unknown) => (filters.push(["is", col, v]), builder),
        gte: (col: string, v: unknown) => (filters.push(["gte", col, v]), builder),
        lte: (col: string, v: unknown) => (filters.push(["lte", col, v]), builder),
        abortSignal(s: AbortSignal) {
          signal = s;
          return builder;
        },
        then<A, B = never>(resolve: (v: { data: Row[] | null; error: unknown }) => A, reject?: (e: unknown) => B) {
          const shared = filters.some(([op, col]) => op === "is" && col === "cohort_id");
          const key = shared ? `${table}:shared` : table;
          calls.queries.push({ key, select, filters: [...filters], signal: !!signal });
          const fault = opts.faults?.[key];
          const answer = new Promise<{ data: Row[] | null; error: unknown }>((ok, fail) => {
            if (fault?.throws) return fail(new Error(fault.throws));
            if (fault?.error) return ok({ data: null, error: fault.error });
            if (fault?.hang) {
              // Like postgrest: an aborted request resolves with an error.
              signal?.addEventListener("abort", () => ok({ data: null, error: { message: "AbortError: This operation was aborted" } }));
              return;
            }
            ok({ data: (data[table] ?? []).filter((r) => filters.every((f) => matches(r, f))), error: null });
          });
          return answer.then(resolve, reject);
        },
      };
      return builder;
    },
    storage: {
      from(bucket: Bucket) {
        return {
          async createSignedUrls(paths: string[], _ttl: number) {
            calls.sign.push({ bucket, paths });
            const fault = opts.storage?.[bucket];
            if (fault === "hang") return new Promise(() => {});
            if (fault === "throw") throw new Error("fetch failed");
            if (fault === "error") return { data: null, error: { message: "Bucket not found" } };
            // Storage's answer for a missing object: an entry with an error and no URL.
            return {
              data: paths.map((p) =>
                objects[bucket].has(p)
                  ? { error: null, path: p, signedUrl: `https://example.supabase.co/storage/v1/object/sign/${bucket}/${p}?token=t` }
                  : { error: "Either the object does not exist or you do not have access to it", path: p, signedUrl: null },
              ),
              error: null,
            };
          },
        };
      },
    },
  };
  return { client: client as any, calls };
}

function byId(r: CohortReadiness | undefined, id: CheckId): ReadinessCheck {
  assert.ok(r, "no checklist");
  const c = r.checks.find((x) => x.id === id);
  assert.ok(c, `missing check ${id}`);
  return c;
}

const FAST = { readMs: 25, storageMs: 25 };
// A loader that waits on a hung call fails these tests instead of stalling the run.
const BOUNDED = { timeout: 5_000 };

// ---------------------------------------------------------------------------
// Batching and per-cohort rows
// ---------------------------------------------------------------------------

test("one read per table for every cohort on the page, checklists keyed by cohort", async () => {
  const { client, calls } = fakeDb(tables());
  const out = await loadCohortReadiness(client, cohortRows(), { caps: ALL, now: NOW });

  assert.deepEqual(Object.keys(out).sort(), [FALL, WINTER].sort());
  assert.deepEqual(
    calls.queries.map((q) => q.key).sort(),
    ["cohort_kickoff", "course_assignments", "events", "events:shared", "modules", "resources"],
  );
  for (const q of calls.queries) {
    assert.equal(q.signal, true, `${q.key} has no timeout`);
    if (q.key !== "events:shared") assert.deepEqual(q.filters[0], ["in", "cohort_id", [FALL, WINTER]], q.key);
  }
  assert.ok(calls.queries.find((q) => q.key === "course_assignments")!.filters.some((f) => f[0] === "neq" && f[2] === "archived"));
  assert.match(calls.queries.find((q) => q.key === "resources")!.select, /external_url/);

  // Winter gets only its own rows: Fall's three modules don't leak in.
  const winter = out[WINTER];
  for (const c of winter.checks) assert.equal(c.state, "pass", `${c.id}: ${c.detail}`);
  assert.equal(byId(winter, "content").detail, "9 modules, 9 lessons, every week covered.");
  assert.equal(byId(winter, "enrollment").detail, "$130 list · 6 of 24 seats · applications close Dec 12.");
  assert.equal(byId(out[FALL], "content").detail, "3 modules, 3 lessons.");
  assert.match(byId(out[FALL], "enrollment").detail, /18 of 24 seats/);
});

test("no upcoming or active cohort: nothing is read", async () => {
  const { client, calls } = fakeDb(tables());
  const out = await loadCohortReadiness(client, [cohortRows()[2]], { caps: ALL, now: NOW });
  assert.deepEqual(out, {});
  assert.equal(calls.queries.length, 0);
  assert.equal(calls.sign.length, 0);
});

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

test(`signs each bucket once per ${SIGN_BATCH} paths and fails exactly the ones storage won't sign`, async () => {
  const t = tables();
  // 17 handouts a week for Winter: 153 paths, plus Fall's 3.
  t.modules = [...moduleRows(WINTER, "winter", 9, 17), ...moduleRows(FALL, "fall", 3)];
  t.resources = [
    { id: "r1", cohort_id: WINTER, title: "Reading list", storage_path: "winter/reading.pdf", external_url: null },
    // Students are sent to the link; the stale upload is never opened.
    { id: "r2", cohort_id: WINTER, title: "Pitch template", storage_path: "winter/stale.pptx", external_url: "https://docs.google.com/x" },
  ];
  const objects = objectsFor(t);
  objects.resources.delete("winter/stale.pptx");
  objects["course-materials"].delete("winter/week-3/handout-2.pdf");
  const { client, calls } = fakeDb(t, { objects });
  const out = await loadCohortReadiness(client, cohortRows(), { caps: ALL, now: NOW });

  const materials = calls.sign.filter((s) => s.bucket === "course-materials");
  assert.deepEqual(materials.map((s) => s.paths.length), [100, 56]);
  assert.deepEqual(calls.sign.filter((s) => s.bucket === "resources").map((s) => s.paths), [["winter/reading.pdf"]]);
  // No videos anywhere: that bucket isn't asked at all.
  assert.equal(calls.sign.filter((s) => s.bucket === "course-videos").length, 0);

  const files = byId(out[WINTER], "files");
  assert.equal(files.state, "fail");
  assert.equal(files.detail, "1 of 154 files not in storage. Students don't get them.");
  assert.deepEqual(files.items.map((i) => i.text), ["Week 3 · Lesson 3: Handout 2"]);
  assert.equal(byId(out[FALL], "files").state, "pass");
});

for (const fault of ["error", "throw", "hang"] as const) {
  test(`storage that answers with ${fault === "hang" ? "nothing" : `a${fault === "error" ? "n" : ""} ${fault}`} reads as unreachable, and the page still loads`, BOUNDED, async (t) => {
    t.mock.method(console, "error", () => {});
    const { client } = fakeDb(tables(), { storage: { "course-materials": fault } });
    const started = Date.now();
    const out = await loadCohortReadiness(client, cohortRows(), { caps: ALL, now: NOW, timeouts: FAST });
    assert.ok(Date.now() - started < 1_000, "waited on a hung bucket");
    const files = byId(out[WINTER], "files");
    assert.equal(files.state, "warn");
    assert.equal(files.detail, "Couldn't reach storage to check 9 files.");
    // Everything else still checked.
    assert.equal(byId(out[WINTER], "sessions").state, "pass");
  });
}

test("the default waits are a few seconds, not the function's whole budget", () => {
  assert.ok(READINESS_TIMEOUTS.storageMs <= 5_000);
  assert.ok(READINESS_TIMEOUTS.readMs <= 5_000);
});

// ---------------------------------------------------------------------------
// Reads that fail
// ---------------------------------------------------------------------------

test("a table that's missing, errors or hangs says couldn't load for its own checks only", BOUNDED, async (t) => {
  const logged = t.mock.method(console, "error", () => {});
  const { client } = fakeDb(tables(), {
    faults: {
      // Not migrated yet: expected, so not logged.
      course_assignments: { error: { code: "42P01", message: 'relation "course_assignments" does not exist' } },
      cohort_kickoff: { error: { message: "permission denied" } },
      modules: { hang: true },
    },
  });
  const started = Date.now();
  const out = await loadCohortReadiness(client, cohortRows(), { caps: ALL, now: NOW, timeouts: FAST });
  assert.ok(Date.now() - started < 1_000, "waited on a hung read");
  const winter = out[WINTER];
  assert.equal(byId(winter, "assignments").detail, "Couldn't load assignments.");
  assert.equal(byId(winter, "kickoff").detail, "Couldn't load the kickoff page.");
  assert.equal(byId(winter, "content").detail, "Couldn't load modules.");
  assert.equal(byId(winter, "files").detail, "Couldn't load lessons.");
  assert.equal(byId(winter, "sessions").state, "pass");
  assert.equal(byId(winter, "dates").state, "pass");
  const messages = logged.mock.calls.map((c) => String(c.arguments[0]));
  assert.ok(messages.some((m) => m.includes("cohort_kickoff")));
  assert.ok(messages.some((m) => m.includes("modules")));
  assert.ok(!messages.some((m) => m.includes("course_assignments")), "a missing table was logged as a failure");
});

test("an unexpected throw leaves the page without checklists, not without cohorts", async (t) => {
  t.mock.method(console, "error", () => {});
  const { client } = fakeDb(tables(), { throwOn: "cohort_kickoff" });
  assert.deepEqual(await loadCohortReadiness(client, cohortRows(), { caps: ALL, now: NOW }), {});
  // A rejected read is contained to its check.
  const { client: rejecting } = fakeDb(tables(), { faults: { resources: { throws: "socket hang up" } } });
  const out = await loadCohortReadiness(rejecting, cohortRows(), { caps: ALL, now: NOW });
  assert.match(byId(out[WINTER], "files").detail, /Couldn't load this cohort's resources\.$/);
});

// ---------------------------------------------------------------------------
// Events everyone signed in sees
// ---------------------------------------------------------------------------

test("'Everyone signed in' events with no cohort count as sessions for each cohort whose dates they fall in", async () => {
  const t = tables();
  t.events = [
    // Shared office hours: no cohort, visible to every signed-in student.
    ...mondayEvents(null, "shared", "public"),
    // Neither of these reaches Winter's students.
    { ...mondayEvents(null, "nobody", "enrolled")[0], id: "nobody" },
    { ...mondayEvents(null, "staff", "staff")[1], id: "staff" },
    // Fall's own public event stays on Fall's timetable.
    { ...mondayEvents(FALL, "fall", "public")[2], id: "fall-public" },
    // Long before any cohort on the page: outside the query.
    { ...mondayEvents(null, "old", "public")[0], id: "old", starts_at: "2026-01-05T01:00:00Z" },
  ];
  const { client, calls } = fakeDb(t);
  const out = await loadCohortReadiness(client, cohortRows(), { caps: ALL, now: NOW });

  const shared = calls.queries.find((q) => q.key === "events:shared")!;
  const span = sharedEventSpan(cohortRows().slice(0, 2), NOW);
  assert.deepEqual(shared.filters, [
    ["is", "cohort_id", null],
    ["eq", "visibility", "public"],
    ["gte", "starts_at", span.from],
    ["lte", "starts_at", span.to],
  ]);

  const sessions = byId(out[WINTER], "sessions");
  assert.equal(sessions.state, "pass");
  assert.equal(sessions.detail, "9 sessions, at least one in every week.");
  assert.equal(byId(out[WINTER], "kickoff").state, "pass");
  // Fall's dates end Nov 13; none of Winter's Mondays fall inside them.
  assert.equal(byId(out[FALL], "sessions").state, "fail");
});

test("if the shared events can't be read, sessions say couldn't load rather than none", async (t) => {
  t.mock.method(console, "error", () => {});
  const { client } = fakeDb(tables(), { faults: { "events:shared": { error: { message: "timeout" } } } });
  const out = await loadCohortReadiness(client, cohortRows(), { caps: ALL, now: NOW });
  assert.equal(byId(out[WINTER], "sessions").detail, "Couldn't load events.");
  assert.equal(byId(out[WINTER], "links").detail, "Couldn't load events.");
});

test("the shared-events window covers every cohort's New York days", () => {
  assert.deepEqual(sharedEventSpan(cohortRows().slice(0, 2), NOW), {
    from: "2026-09-13T00:00:00Z",
    to: "2027-02-14T00:00:00Z",
  });
  // 11:59 p.m. New York on the last day is already Feb 13 in UTC: still inside.
  assert.ok(easternToUtc(W_END, "23:59")! < "2027-02-14T00:00:00Z");
  // A cohort with no dates counts from today, with no end.
  assert.deepEqual(sharedEventSpan([{ starts_on: null, ends_on: null }], NOW), {
    from: "2026-10-16T00:00:00Z",
    to: null,
  });
});

// ---------------------------------------------------------------------------
// Permissions
// ---------------------------------------------------------------------------

test("links follow the viewer's permissions: a cohorts-only role keeps only the cohort and kickoff editors", async () => {
  const t = tables();
  t.events = [];
  t.course_assignments = [];
  t.cohort_kickoff = [];
  const { client } = fakeDb(t);
  const cohortsOnly: Capabilities = { role: "ops", permissions: ["cohorts.manage"], superAdmin: false };

  const limited = (await loadCohortReadiness(client, cohortRows(), { caps: cohortsOnly, now: NOW }))[WINTER];
  assert.equal(byId(limited, "sessions").fix, null);
  assert.equal(byId(limited, "assignments").fix, null);
  const kickoff = byId(limited, "kickoff");
  assert.deepEqual(kickoff.fix, { editor: "kickoff", href: `/admin/cohorts/${WINTER}/kickoff` });
  // The day-one session item points at Events, which this role can't open.
  assert.deepEqual(kickoff.items.map((i) => i.link?.editor ?? null), ["kickoff", null]);

  const full = (await loadCohortReadiness(client, cohortRows(), { caps: ALL, now: NOW }))[WINTER];
  assert.deepEqual(byId(full, "sessions").fix, { editor: "events", href: "/admin/events" });
  assert.deepEqual(byId(full, "assignments").fix, { editor: "assignments", href: `/admin/assignments?cohort=${WINTER}` });

  const nobody = (await loadCohortReadiness(client, cohortRows(), { caps: null, now: NOW }))[WINTER];
  for (const c of nobody.checks) {
    assert.equal(c.fix, null, c.id);
    for (const i of c.items) assert.equal(i.link, null, c.id);
  }
});

test("a role built from real grants gets the editors those grants open", async () => {
  const t = tables();
  t.events = [];
  const { client } = fakeDb(t);
  const caps = capabilitiesFrom("custom", ["cohorts.manage", "events.manage"]);
  const r = (await loadCohortReadiness(client, cohortRows(), { caps, now: NOW }))[WINTER];
  assert.deepEqual(byId(r, "sessions").fix, { editor: "events", href: "/admin/events" });
});
