import { test } from "node:test";
import assert from "node:assert/strict";
import { courseWeekStart, courseWeekWindow, easternToUtc } from "./assignments.ts";
import { cohortEligibility, easternEndOfDay } from "./cohort-eligibility.ts";
import {
  cohortFileRefs,
  cohortReadiness,
  courseHref,
  readinessApplies,
  readinessSummary,
  type CheckId,
  type ReadinessAssignment,
  type ReadinessCheck,
  type ReadinessEvent,
  type ReadinessInput,
  type ReadinessModule,
} from "./cohort-readiness.ts";

// A Winter-shaped cohort: Monday Dec 14 to Friday Feb 12, nine course weeks,
// checked from mid-October while it is still upcoming.
const START = "2026-12-14";
const END = "2027-02-12";
const WEEKS = 9;
const NOW = new Date("2026-10-17T16:00:00Z");
const COHORT_ID = "c0000000-0000-4000-8000-000000000001";

function modules(): ReadinessModule[] {
  return Array.from({ length: WEEKS }, (_, i) => ({
    id: `m${i + 1}`,
    week: i + 1,
    title: `Week ${i + 1} module`,
    position: 0,
    lessons: [
      {
        id: `l${i + 1}`,
        title: `Lesson ${i + 1}`,
        position: 0,
        description: "Read this.",
        video_path: null,
        video_url: null,
        materials: [{ title: `Workbook ${i + 1}`, path: `winter/workbook-${i + 1}.pdf` }],
      },
    ],
  }));
}

function weeklyUpdates(): ReadinessAssignment[] {
  return Array.from({ length: WEEKS }, (_, i) => {
    const w = courseWeekWindow({ startsOn: START, endsOn: END, week: i + 1 })!;
    return {
      id: `a${i + 1}`,
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

function session(id: string, date: string, extra: Partial<ReadinessEvent> = {}): ReadinessEvent {
  const startsAt = easternToUtc(date, "20:00")!;
  return {
    id,
    title: "Workshop",
    visibility: "enrolled",
    live_mode: "hosted",
    starts_at: startsAt,
    ends_at: new Date(Date.parse(startsAt) + 60 * 60_000).toISOString(),
    zoom_url: null,
    live_ended_at: null,
    ...extra,
  };
}

/** One Monday workshop per course week, the first on kickoff day. */
function mondays(): ReadinessEvent[] {
  return Array.from({ length: WEEKS }, (_, i) => session(`e${i + 1}`, courseWeekStart(START, i + 1)!));
}

function storedFor(mods: ReadinessModule[]) {
  const paths = new Set(cohortFileRefs(mods, []).refs.map((r) => r.path));
  return { "course-materials": paths, "course-videos": new Set<string>(), resources: new Set<string>() };
}

function readyInput(overrides: Partial<ReadinessInput> = {}): ReadinessInput {
  const mods = modules();
  return {
    cohort: {
      id: COHORT_ID,
      name: "Winter 2026",
      status: "upcoming",
      starts_on: START,
      ends_on: END,
      capacity: 24,
      price_cents: 13000,
      applications_close_at: "2026-12-12T23:59:00Z",
      late_entry_until: null,
      catch_up_plan: null,
      enrolled: 6,
    },
    modules: mods,
    resources: [],
    assignments: weeklyUpdates(),
    events: mondays(),
    kickoff: {
      row: {
        headline: null,
        intro: null,
        time_label: "Mondays, 8–9 p.m. Eastern",
        location_label: "Live inside Batch0",
        join_url: "/dashboard/events",
        agenda: null,
        checklist: null,
        note: null,
      },
    },
    files: storedFor(mods),
    now: NOW,
    ...overrides,
  };
}

function byId(checks: ReadinessCheck[], id: CheckId): ReadinessCheck {
  const c = checks.find((x) => x.id === id);
  assert.ok(c, `missing check ${id}`);
  return c;
}

// ---------------------------------------------------------------------------
// A ready cohort
// ---------------------------------------------------------------------------

test("a fully set up upcoming cohort passes every check and reads Ready", () => {
  const r = cohortReadiness(readyInput());
  for (const c of r.checks) assert.equal(c.state, "pass", `${c.id}: ${c.detail}`);
  assert.equal(r.fail, 0);
  assert.equal(r.warn, 0);
  assert.deepEqual(readinessSummary(r), { tone: "pass", label: "Ready" });
  assert.deepEqual(
    r.checks.map((c) => c.id),
    ["dates", "enrollment", "content", "files", "assignments", "kickoff", "sessions", "links"],
  );
  assert.equal(byId(r.checks, "dates").detail, "Dec 14, 2026 – Feb 12, 2027 · 9 weeks.");
  assert.equal(byId(r.checks, "enrollment").detail, "$130 list · 6 of 24 seats · applications close Dec 12.");
  assert.equal(byId(r.checks, "files").detail, "All 9 files are in storage.");
  assert.equal(byId(r.checks, "sessions").detail, "9 sessions, at least one in every week.");
  assert.equal(byId(r.checks, "links").detail, "9 upcoming sessions: 9 in the batch0 room.");
  // Passing checks carry no fix link and no items: nothing to click.
  for (const c of r.checks) {
    assert.equal(c.fix, null, c.id);
    assert.deepEqual(c.items, [], c.id);
  }
});

test("only upcoming and active cohorts get a checklist", () => {
  assert.equal(readinessApplies("upcoming"), true);
  assert.equal(readinessApplies("active"), true);
  assert.equal(readinessApplies("completed"), false);
  assert.equal(readinessApplies("cancelled"), false);
  assert.equal(readinessApplies(null), false);
});

// ---------------------------------------------------------------------------
// Missing materials
// ---------------------------------------------------------------------------

test("a lesson file that isn't in storage fails, naming the lesson and linking its module", () => {
  const input = readyInput();
  const stored = new Set(input.files["course-materials"]!);
  stored.delete("winter/workbook-3.pdf");
  input.files = { ...input.files, "course-materials": stored };
  const files = byId(cohortReadiness(input).checks, "files");
  assert.equal(files.state, "fail");
  assert.equal(files.detail, "1 of 9 files not in storage. Students don't get them.");
  assert.deepEqual(files.items, [
    { text: "Week 3 · Lesson 3: Workbook 3", link: { editor: "course", href: courseHref("m3") } },
  ]);
  assert.deepEqual(files.fix, { editor: "course", href: "/admin/course" });
  assert.equal(courseHref("m3"), "/admin/course?module=m3#module-m3");
});

test("a material row with no file, a missing video and a missing resource file all fail", () => {
  const mods = modules();
  mods[1].lessons[0].materials = [{ title: "Slides" }, { title: "Workbook 2", path: "winter/workbook-2.pdf" }];
  mods[4].lessons[0].video_path = "winter/week-5.mp4";
  const input = readyInput({
    modules: mods,
    resources: [
      { id: "r1", title: "Pitch template", storage_path: "cohort/pitch.pptx" },
      { id: "r2", title: "Reading list", storage_path: null },
    ],
  });
  const files = byId(cohortReadiness(input).checks, "files");
  assert.equal(files.state, "fail");
  assert.equal(files.detail, "2 of 11 files not in storage; 1 material with no file. Students don't get them.");
  assert.deepEqual(
    files.items.map((i) => [i.text, i.link?.href]),
    [
      ["Week 2 · Lesson 2: Slides has no file", courseHref("m2")],
      ["Week 5 · Lesson 5: video", courseHref("m5")],
      ["Resource · Pitch template", "/admin/resources/r1"],
    ],
  );
});

test("storage that couldn't be reached is a warning, not a claim that files are missing", () => {
  const input = readyInput();
  input.files = { ...input.files, "course-materials": null };
  const files = byId(cohortReadiness(input).checks, "files");
  assert.equal(files.state, "warn");
  assert.equal(files.detail, "Couldn't reach storage to check 9 files.");
  assert.deepEqual(files.items, []);
});

test("no modules fails course content; a week with no module or an empty lesson warns", () => {
  const none = cohortReadiness(readyInput({ modules: [] }));
  assert.equal(byId(none.checks, "content").state, "fail");
  assert.equal(byId(none.checks, "content").detail, "No modules.");

  const mods = modules().filter((m) => m.week !== 4);
  mods[0].lessons.push({
    id: "l1b",
    title: "Placeholder",
    position: 1,
    description: "  ",
    video_path: null,
    video_url: null,
    materials: [],
  });
  mods.push({ id: "m11", week: 11, title: "Bonus", position: 0, lessons: [] });
  const content = byId(cohortReadiness(readyInput({ modules: mods, files: storedFor(mods) })).checks, "content");
  assert.equal(content.state, "warn");
  assert.deepEqual(
    content.items.map((i) => i.text),
    [
      "Week 4: no module.",
      "Week 1 · Placeholder: empty lesson.",
      "Week 11 · Bonus: after the cohort's last week (9).",
      "Week 11 · Bonus: no lessons.",
    ],
  );
});

// ---------------------------------------------------------------------------
// Assignment dates
// ---------------------------------------------------------------------------

test("past-dated and out-of-window assignments fail on an upcoming cohort", () => {
  const assignments: ReadinessAssignment[] = [
    ...weeklyUpdates(),
    // Left over from a copied cohort: already past before day one.
    {
      id: "old",
      title: "Problem statement",
      status: "published",
      module_id: null,
      lesson_id: null,
      week: null,
      opens_at: null,
      due_at: "2026-10-01T03:59:00Z",
    },
    {
      id: "early",
      title: "Intro video",
      status: "published",
      module_id: null,
      lesson_id: null,
      week: null,
      opens_at: null,
      due_at: easternToUtc("2026-12-10", "23:59"),
    },
    {
      id: "late",
      title: "Retro",
      status: "published",
      module_id: null,
      lesson_id: null,
      week: null,
      opens_at: null,
      due_at: easternToUtc("2027-02-20", "23:59"),
    },
    // Drafts and archived rows aren't shown to students, so their dates don't count.
    {
      id: "draft",
      title: "Old draft",
      status: "draft",
      module_id: null,
      lesson_id: null,
      week: null,
      opens_at: null,
      due_at: "2026-09-01T03:59:00Z",
    },
  ];
  const a = byId(cohortReadiness(readyInput({ assignments })).checks, "assignments");
  assert.equal(a.state, "fail");
  assert.equal(a.detail, "12 published assignments, 1 draft.");
  assert.deepEqual(
    a.items.map((i) => i.text),
    [
      "Problem statement: due Wed, Sep 30, 11:59 PM ET, already past.",
      "Intro video: due Thu, Dec 10, 11:59 PM ET, before the cohort starts Dec 14.",
      "Retro: due Sat, Feb 20, 11:59 PM ET, after the cohort ends Feb 12.",
    ],
  );
  for (const item of a.items) {
    assert.deepEqual(item.link, { editor: "assignments", href: `/admin/assignments?cohort=${COHORT_ID}` });
  }
});

test("work tied to week 3's lesson but due in week 2 warns that it's out of order", () => {
  const assignments: ReadinessAssignment[] = [
    {
      id: "x",
      title: "Interview notes",
      status: "published",
      module_id: null,
      lesson_id: "l3",
      week: null,
      opens_at: null,
      due_at: easternToUtc("2026-12-24", "23:59"),
    },
  ];
  const a = byId(cohortReadiness(readyInput({ assignments })).checks, "assignments");
  assert.equal(a.state, "warn");
  assert.deepEqual(a.items.map((i) => i.text), [
    "Interview notes: due Thu, Dec 24, 11:59 PM ET, before week 3 opens Dec 28.",
  ]);
});

test("a running cohort's past deadlines are history, not a failure", () => {
  const input = readyInput({
    cohort: { ...readyInput().cohort, status: "active" },
    // Two weeks in.
    now: new Date("2026-12-29T15:00:00Z"),
  });
  const a = byId(cohortReadiness(input).checks, "assignments");
  assert.equal(a.state, "pass");
  assert.equal(a.detail, "9 published assignments, all due inside the cohort's dates.");
});

test("no published assignments warns", () => {
  const a = byId(cohortReadiness(readyInput({ assignments: [] })).checks, "assignments");
  assert.equal(a.state, "warn");
  assert.equal(a.detail, "No published assignments.");
  assert.deepEqual(a.fix, { editor: "assignments", href: `/admin/assignments?cohort=${COHORT_ID}` });
});

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

test("no sessions fails, and kickoff day has nothing on the calendar", () => {
  const r = cohortReadiness(readyInput({ events: [] }));
  const sessions = byId(r.checks, "sessions");
  assert.equal(sessions.state, "fail");
  assert.equal(sessions.detail, "No live sessions scheduled.");
  assert.deepEqual(sessions.fix, { editor: "events", href: "/admin/events" });
  const kickoff = byId(r.checks, "kickoff");
  assert.equal(kickoff.state, "warn");
  assert.deepEqual(kickoff.items.map((i) => i.text), ["No live session on Dec 14."]);
  assert.equal(byId(r.checks, "links").detail, "No upcoming sessions to check.");
  assert.deepEqual(readinessSummary(r), { tone: "fail", label: "1 to fix" });
});

test("staff-only rehearsals and sessions outside the cohort's dates don't count", () => {
  const events = [
    session("rehearsal", START, { visibility: "staff" }),
    session("info", "2026-11-20", { visibility: "public" }),
  ];
  assert.equal(byId(cohortReadiness(readyInput({ events })).checks, "sessions").state, "fail");
});

test("weeks with no session are listed with their dates", () => {
  const events = mondays().filter((_, i) => i !== 2 && i !== 8);
  const sessions = byId(cohortReadiness(readyInput({ events })).checks, "sessions");
  assert.equal(sessions.state, "warn");
  assert.equal(sessions.detail, "7 sessions; none in weeks 3 and 9.");
  assert.deepEqual(sessions.items.map((i) => i.text), [
    "Week 3 (Dec 28 – Jan 3): no session.",
    "Week 9 (Feb 8 – Feb 12): no session.",
  ]);
});

test("a running cohort only needs sessions in the weeks still ahead", () => {
  const events = mondays().filter((_, i) => i >= 2);
  const input = readyInput({
    cohort: { ...readyInput().cohort, status: "active" },
    events,
    now: new Date("2026-12-29T15:00:00Z"), // week 3
  });
  const sessions = byId(cohortReadiness(input).checks, "sessions");
  assert.equal(sessions.state, "pass");
  assert.equal(sessions.detail, "7 sessions, at least one in every remaining week.");
});

test("an upcoming external session with no link fails and opens that event's editor", () => {
  const events = mondays();
  events[1] = { ...events[1], live_mode: "external", zoom_url: null, title: "Guest workshop" };
  events[2] = { ...events[2], live_mode: "external", zoom_url: "https://zoom.us/j/1" };
  const links = byId(cohortReadiness(readyInput({ events })).checks, "links");
  assert.equal(links.state, "fail");
  assert.equal(links.detail, "1 of 9 upcoming sessions has no join link.");
  assert.deepEqual(links.items, [
    {
      text: "Mon, Dec 21, 8:00 PM ET · Guest workshop: external, no link.",
      link: { editor: "events", href: "/admin/events?edit=e2" },
    },
  ]);
});

test("a session link students' pages won't show (not https) counts as no link, and says why", () => {
  const events = mondays();
  events[1] = { ...events[1], live_mode: "external", zoom_url: "http://zoom.us/j/1", title: "Guest workshop" };
  events[2] = { ...events[2], live_mode: "external", zoom_url: "javascript:alert(1)", title: "Office hour" };
  const links = byId(cohortReadiness(readyInput({ events })).checks, "links");
  assert.equal(links.state, "fail");
  assert.equal(links.detail, "2 of 9 upcoming sessions have no join link.");
  assert.deepEqual(
    links.items.map((i) => i.text),
    [
      "Mon, Dec 21, 8:00 PM ET · Guest workshop: external, its link isn't https://, so students don't see it.",
      "Mon, Dec 28, 8:00 PM ET · Office hour: external, its link isn't https://, so students don't see it.",
    ],
  );
});

// ---------------------------------------------------------------------------
// Kickoff, dates, enrollment
// ---------------------------------------------------------------------------

test("an unfilled kickoff page warns; a script link fails because students never see it", () => {
  const empty = byId(cohortReadiness(readyInput({ kickoff: { row: null } })).checks, "kickoff");
  assert.equal(empty.state, "warn");
  assert.deepEqual(empty.fix, { editor: "kickoff", href: `/admin/cohorts/${COHORT_ID}/kickoff` });

  const row = { ...readyInput().kickoff!.row!, time_label: "", join_url: "javascript:alert(1)" };
  const bad = byId(cohortReadiness(readyInput({ kickoff: { row } })).checks, "kickoff");
  assert.equal(bad.state, "fail");
  assert.deepEqual(bad.items.map((i) => i.text), [
    "No kickoff time.",
    "Join link isn't https:// or an in-app path, so students don't see it.",
  ]);
});

test("a cohort that has started passes kickoff without re-checking the page", () => {
  const input = readyInput({
    cohort: { ...readyInput().cohort, status: "active" },
    kickoff: { row: null },
    now: new Date("2026-12-29T15:00:00Z"),
  });
  const kickoff = byId(cohortReadiness(input).checks, "kickoff");
  assert.equal(kickoff.state, "pass");
  assert.equal(kickoff.detail, "Kicked off Dec 14, 2026.");
});

test("missing dates fail and point at the cohort's own editor", () => {
  const cohort = { ...readyInput().cohort, starts_on: null, ends_on: null };
  const r = cohortReadiness(readyInput({ cohort }));
  const dates = byId(r.checks, "dates");
  assert.equal(dates.state, "fail");
  assert.equal(dates.detail, "No start date or end date.");
  assert.deepEqual(dates.fix, { editor: "cohort", href: "/admin/cohorts" });
  assert.equal(byId(r.checks, "sessions").state, "warn");
  assert.equal(byId(r.checks, "kickoff").detail, "No kickoff date: the cohort has no start date.");
});

test("a start date that has passed while the cohort still says Upcoming warns", () => {
  const dates = byId(cohortReadiness(readyInput({ now: new Date("2026-12-15T15:00:00Z") })).checks, "dates");
  assert.equal(dates.state, "warn");
  assert.match(dates.detail, /Started Dec 14, still marked Upcoming\.$/);
});

test("enrollment flags a $0 price, half-set late entry and a close date after day one", () => {
  const cohort = {
    ...readyInput().cohort,
    price_cents: 0,
    late_entry_until: "2026-12-21T04:59:59Z",
    catch_up_plan: null,
    applications_close_at: "2026-12-18T23:59:00Z",
  };
  const e = byId(cohortReadiness(readyInput({ cohort })).checks, "enrollment");
  assert.equal(e.state, "warn");
  assert.deepEqual(e.items.map((i) => i.text), [
    "Price is $0.",
    "Late entry has a deadline but no catch-up plan.",
    "Applications close Dec 18, after the Dec 14 start; from day one only late entry admits.",
  ]);
  assert.deepEqual(e.fix, { editor: "cohort", href: "/admin/cohorts" });
  // The note says when applications really close, not the stored date.
  assert.equal(e.detail, "6 of 24 seats · applications open until the Dec 14 start.");
});

test("a close time later on day one is flagged too: admissions switch to late entry at midnight", () => {
  // Admissions read late_entry_until from 00:00 New York on Dec 14, so a
  // 6 p.m. Dec 14 close is never reached either.
  const cohort = { ...readyInput().cohort, applications_close_at: easternToUtc(START, "18:00") };
  const e = byId(cohortReadiness(readyInput({ cohort })).checks, "enrollment");
  assert.equal(e.state, "warn");
  assert.deepEqual(e.items.map((i) => i.text), [
    "Applications close Dec 14, the day it starts; from day one only late entry admits.",
  ]);
  assert.equal(e.detail, "$130 list · 6 of 24 seats · applications open until the Dec 14 start.");

  // The end of Dec 13 is the last moment that close date can mean anything.
  const eve = { ...readyInput().cohort, applications_close_at: easternEndOfDay("2026-12-13") };
  const ok = byId(cohortReadiness(readyInput({ cohort: eve })).checks, "enrollment");
  assert.equal(ok.state, "pass");
  assert.equal(ok.detail, "$130 list · 6 of 24 seats · applications close Dec 13.");
});

test("a cohort with no close date is open until day one", () => {
  const cohort = { ...readyInput().cohort, applications_close_at: null };
  const e = byId(cohortReadiness(readyInput({ cohort })).checks, "enrollment");
  assert.equal(e.state, "pass");
  assert.equal(e.detail, "$130 list · 6 of 24 seats · applications open until the Dec 14 start.");
});

test("a running cohort's old applications close date isn't flagged", () => {
  // Fall 2026's shape: applications closed Oct 9, weeks after the Sep 14 start,
  // with late entry (deadline and plan) running until Oct 16.
  const cohort = {
    ...readyInput().cohort,
    status: "active",
    starts_on: "2026-09-14",
    ends_on: "2026-11-13",
    applications_close_at: "2026-10-09T23:59:00Z",
    late_entry_until: "2026-10-17T03:59:59.999Z",
    catch_up_plan: "Watch the week 1–4 recordings and book a call.",
  };
  const e = byId(cohortReadiness(readyInput({ cohort, now: new Date("2026-10-15T16:00:00Z") })).checks, "enrollment");
  assert.equal(e.state, "pass");
  assert.equal(e.detail, "$130 list · 6 of 24 seats · late entry until Oct 16.");
});

// ---------------------------------------------------------------------------
// Active before day one
// ---------------------------------------------------------------------------

/** Winter flipped to Active on Oct 17, eight weeks before its Dec 14 start. */
function activeEarly(overrides: Partial<ReadinessInput> = {}): ReadinessInput {
  return readyInput({ cohort: { ...readyInput().cohort, status: "active" }, ...overrides });
}

test("a cohort marked Active before its start date still runs on its dates", () => {
  const r = cohortReadiness(activeEarly());
  // Admissions decide by date, so applications are still open until Dec 12.
  const e = byId(r.checks, "enrollment");
  assert.equal(e.state, "pass");
  assert.equal(e.detail, "$130 list · 6 of 24 seats · applications close Dec 12.");
  // The kickoff is still ahead and still checked.
  const kickoff = byId(r.checks, "kickoff");
  assert.equal(kickoff.state, "pass");
  assert.equal(kickoff.detail, "Dec 14: time and place set, session scheduled.");
  // The status is what's worth a look: it opens the app and the kickoff page
  // reads "Kickoff was Dec 14" in October.
  const dates = byId(r.checks, "dates");
  assert.equal(dates.state, "warn");
  assert.equal(
    dates.detail,
    "Dec 14, 2026 – Feb 12, 2027 · 9 weeks. Marked Active before its Dec 14 start: students get the full app now, and the kickoff page reads as past.",
  );
  assert.deepEqual(dates.fix, { editor: "cohort", href: "/admin/cohorts" });
  assert.deepEqual(readinessSummary(r), { tone: "warn", label: "1 to check" });
});

test("Active before day one still gets the kickoff, close-date and past-deadline checks", () => {
  const r = cohortReadiness(
    activeEarly({
      cohort: { ...readyInput().cohort, status: "active", applications_close_at: "2026-12-18T23:59:00Z" },
      kickoff: { row: null },
      assignments: [
        ...weeklyUpdates(),
        {
          id: "old",
          title: "Problem statement",
          status: "published",
          module_id: null,
          lesson_id: null,
          week: null,
          opens_at: null,
          due_at: "2026-10-01T03:59:00Z",
        },
      ],
    }),
  );
  assert.deepEqual(byId(r.checks, "enrollment").items.map((i) => i.text), [
    "Applications close Dec 18, after the Dec 14 start; from day one only late entry admits.",
  ]);
  const kickoff = byId(r.checks, "kickoff");
  assert.equal(kickoff.state, "warn");
  assert.deepEqual(kickoff.items.map((i) => i.text), [
    "Kickoff page not filled in: students see the defaults, with no time or place.",
  ]);
  assert.deepEqual(byId(r.checks, "assignments").items.map((i) => i.text), [
    "Problem statement: due Wed, Sep 30, 11:59 PM ET, already past.",
  ]);
});

test("the admissions note agrees with cohortEligibility, whatever the status", () => {
  const base = readyInput().cohort;
  const plan = "Watch the recordings and book a call.";
  const cases: { status: string; now: string; patch?: Partial<typeof base> }[] = [
    { status: "upcoming", now: "2026-10-17T16:00:00Z" },
    { status: "active", now: "2026-10-17T16:00:00Z" },
    { status: "active", now: "2026-12-13T16:00:00Z" }, // past the Dec 12 close
    { status: "active", now: "2026-12-15T16:00:00Z" }, // day two, no late entry
    {
      status: "active",
      now: "2026-12-15T16:00:00Z",
      patch: { late_entry_until: easternEndOfDay("2026-12-20"), catch_up_plan: plan },
    },
    { status: "upcoming", now: "2026-12-15T16:00:00Z", patch: { late_entry_until: easternEndOfDay("2026-12-20") } },
  ];
  for (const { status, now, patch } of cases) {
    const cohort = { ...base, status, ...patch };
    const note = byId(cohortReadiness(readyInput({ cohort, now: new Date(now) })).checks, "enrollment").detail;
    // Capacity is the seat count's business, not the note's.
    const { mode } = cohortEligibility({ ...cohort, capacity: undefined }, new Date(now));
    const expected =
      mode === "open" ? /applications (close|open until)/ : mode === "late_entry" ? /late entry until/ : /(enrollment|applications) closed/;
    assert.match(note, expected, `${status} at ${now}: ${note} (${mode})`);
  }
});

// ---------------------------------------------------------------------------
// File fallbacks
// ---------------------------------------------------------------------------

test("a missing uploaded video with a video link is a warning: students get the link", () => {
  const mods = modules();
  mods[4].lessons[0].video_path = "winter/week-5.mp4";
  mods[4].lessons[0].video_url = "https://youtu.be/x";
  const files = byId(cohortReadiness(readyInput({ modules: mods })).checks, "files");
  assert.equal(files.state, "warn");
  assert.equal(files.detail, "1 of 10 files not in storage; students get a link instead.");
  assert.deepEqual(files.items, [
    {
      text: "Week 5 · Lesson 5: video isn't in storage; students get the video link instead",
      link: { editor: "course", href: courseHref("m5") },
    },
  ]);

  // Alongside a file nobody gets, the check fails and lists both.
  const input = readyInput({ modules: mods });
  const stored = new Set(input.files["course-materials"]!);
  stored.delete("winter/workbook-1.pdf");
  input.files = { ...input.files, "course-materials": stored };
  const both = byId(cohortReadiness(input).checks, "files");
  assert.equal(both.state, "fail");
  assert.equal(both.detail, "1 of 10 files not in storage. Students don't get them.");
  assert.equal(both.items.length, 2);
});

test("a resource with an external link isn't checked for its upload: students are sent to the link", () => {
  const resources = [
    { id: "r1", title: "Pitch template", storage_path: "cohort/stale.pptx", external_url: "https://docs.google.com/x" },
    { id: "r2", title: "Reading list", storage_path: "cohort/reading.pdf", external_url: null },
  ];
  assert.deepEqual(
    cohortFileRefs([], resources).refs.map((r) => r.path),
    ["cohort/reading.pdf"],
  );
  const input = readyInput({ resources });
  input.files = { ...input.files, resources: new Set(["cohort/reading.pdf"]) };
  const files = byId(cohortReadiness(input).checks, "files");
  assert.equal(files.state, "pass");
  assert.equal(files.detail, "All 10 files are in storage.");
});

test("non-whole prices keep their cents", () => {
  const cohort = { ...readyInput().cohort, price_cents: 15099 };
  assert.match(byId(cohortReadiness(readyInput({ cohort })).checks, "enrollment").detail, /^\$150\.99 list/);
});

// ---------------------------------------------------------------------------
// Loading and permissions
// ---------------------------------------------------------------------------

test("data that didn't load says so instead of reporting the cohort as empty", () => {
  const r = cohortReadiness(readyInput({ modules: null, assignments: null, events: null, kickoff: null }));
  assert.equal(byId(r.checks, "content").detail, "Couldn't load modules.");
  assert.equal(byId(r.checks, "files").detail, "Couldn't load lessons.");
  assert.equal(byId(r.checks, "assignments").detail, "Couldn't load assignments.");
  assert.equal(byId(r.checks, "kickoff").detail, "Couldn't load the kickoff page.");
  assert.equal(byId(r.checks, "sessions").detail, "Couldn't load events.");
  for (const id of ["content", "files", "assignments", "kickoff", "sessions", "links"] as const) {
    assert.equal(byId(r.checks, id).state, "warn", id);
  }
  assert.equal(r.fail, 0);
});

test("links to editors the viewer can't open are dropped; the text stays", () => {
  const events = mondays();
  events[1] = { ...events[1], live_mode: "external", zoom_url: null };
  const r = cohortReadiness(
    readyInput({ events, assignments: [], canOpen: (editor) => editor === "cohort" || editor === "kickoff" }),
  );
  const links = byId(r.checks, "links");
  assert.equal(links.fix, null);
  assert.equal(links.items.length, 1);
  assert.equal(links.items[0].link, null);
  assert.equal(byId(r.checks, "assignments").fix, null);
});
