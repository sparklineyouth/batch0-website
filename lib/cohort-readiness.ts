/**
 * Cohort readiness — the launch checklist on /admin/cohorts. Pure rules: the
 * server loader (lib/cohort-readiness-server.ts) reads the rows and asks
 * storage which files exist, then everything that decides pass / warn / fail
 * lives here so lib/cohort-readiness.test.ts can run it with `node --test`.
 *
 * Not to be confused with scripts/cohort-readiness-winter.mjs
 * (docs/cohort-readiness.md), the offline Winter curriculum preparer. That
 * script builds content from a snapshot; this checks a cohort's live setup.
 *
 * Every check reads data the product already uses, and each problem names the
 * existing editor that fixes it. Nothing is inferred: "no session in week 4"
 * means no event for this cohort starts that week, not that one is overdue.
 *
 * States:
 *   fail  students would hit something broken or wrong (a lesson file that
 *         isn't in storage, an assignment already past due before day one, no
 *         sessions at all, a session with no way in)
 *   warn  incomplete or worth a look (no assignments yet, a week with no
 *         session, a kickoff page without a time), or the data didn't load
 *   pass  checked and fine
 *
 * Relative .ts imports so `node --test` loads it without a bundler.
 */
import {
  addDays,
  cohortWeekCount,
  courseWeekAt,
  courseWeekStart,
  easternDate,
  formatEastern,
} from "./assignments.ts";
import { isSafeHref, type KickoffRow } from "./kickoff.ts";
import type { Permission } from "./permissions.ts";

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

export type CheckState = "pass" | "warn" | "fail";

export type CheckId =
  | "dates"
  | "enrollment"
  | "content"
  | "files"
  | "assignments"
  | "kickoff"
  | "sessions"
  | "links";

/** The existing screens a failing check points at. */
export type Editor = "cohort" | "kickoff" | "course" | "resources" | "assignments" | "events";

/**
 * What opens each editor. A link is only shown to someone who can open it:
 * /admin/cohorts needs cohorts.manage, but its checks point into Course,
 * Events and Assignments, which a cohorts-only role can't reach.
 */
export const EDITOR_PERMISSION: Record<Editor, Permission> = {
  cohort: "cohorts.manage",
  kickoff: "cohorts.manage",
  course: "course.manage",
  resources: "resources.manage",
  assignments: "assignments.manage",
  events: "events.manage",
};

export const EDITOR_LABEL: Record<Editor, string> = {
  cohort: "Edit cohort",
  kickoff: "Kickoff page",
  course: "Course",
  resources: "Resources",
  assignments: "Assignments",
  events: "Events",
};

/** `editor: "cohort"` is the inline form on /admin/cohorts itself; the page
 *  opens it in place rather than following `href`. */
export type ReadinessLink = { editor: Editor; href: string };

export type ReadinessItem = { text: string; link: ReadinessLink | null };

export type ReadinessCheck = {
  id: CheckId;
  label: string;
  state: CheckState;
  /** One short factual line. */
  detail: string;
  /** Where the check as a whole gets fixed. */
  fix: ReadinessLink | null;
  /** The specific rows behind a warn or fail, each with its own editor. */
  items: ReadinessItem[];
};

export type CohortReadiness = {
  checks: ReadinessCheck[];
  fail: number;
  warn: number;
};

export type ReadinessCohort = {
  id: string;
  name: string;
  status: string;
  starts_on: string | null;
  ends_on: string | null;
  capacity: number | null;
  price_cents: number | null;
  applications_close_at?: string | null;
  late_entry_until?: string | null;
  catch_up_plan?: string | null;
  /** Rows in enrollments for this cohort. */
  enrolled: number;
};

export type ReadinessLesson = {
  id: string;
  title: string;
  position: number;
  description: string | null;
  video_path: string | null;
  video_url: string | null;
  /** jsonb: `{ title, path }[]` when well formed. */
  materials: unknown;
};

export type ReadinessModule = {
  id: string;
  week: number;
  title: string;
  position: number;
  lessons: ReadinessLesson[];
};

export type ReadinessResource = {
  id: string;
  title: string;
  storage_path: string | null;
};

export type ReadinessAssignment = {
  id: string;
  title: string;
  status: string;
  module_id: string | null;
  lesson_id: string | null;
  week: number | null;
  opens_at: string | null;
  due_at: string | null;
};

export type ReadinessEvent = {
  id: string;
  title: string;
  visibility: string;
  live_mode: string | null;
  starts_at: string;
  ends_at: string | null;
  zoom_url: string | null;
  live_ended_at: string | null;
};

/** The three private buckets course files live in. */
export type Bucket = "course-materials" | "course-videos" | "resources";

/** Paths storage confirmed, per bucket. Null (or absent) = couldn't check. */
export type StoredFiles = Partial<Record<Bucket, ReadonlySet<string> | null>>;

/**
 * One cohort's setup. Every list is null when its query failed, so the check
 * says "couldn't load" instead of claiming the cohort has none.
 */
export type ReadinessInput = {
  cohort: ReadinessCohort;
  modules: ReadinessModule[] | null;
  resources: ReadinessResource[] | null;
  assignments: ReadinessAssignment[] | null;
  events: ReadinessEvent[] | null;
  /** `{ row: null }` = nobody filled the kickoff page in; null = couldn't load. */
  kickoff: { row: KickoffRow | null } | null;
  files: StoredFiles;
  now: Date;
  /** Strip links the viewer can't open. Default: every editor. */
  canOpen?: (editor: Editor) => boolean;
};

/** Completed and cancelled cohorts have nothing left to launch. */
export function readinessApplies(status: string | null | undefined): boolean {
  return status === "upcoming" || status === "active";
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

const DEFAULT_SESSION_MS = 60 * 60_000;

const dayFmt = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", day: "numeric" });
const dayYearFmt = new Intl.DateTimeFormat("en-US", {
  timeZone: "UTC",
  month: "short",
  day: "numeric",
  year: "numeric",
});

/** "Dec 14" for a `YYYY-MM-DD` calendar date. */
function day(date: string): string {
  return dayFmt.format(new Date(`${date}T12:00:00Z`));
}

/** "Sep 14 – Nov 13, 2026", or both years when the range crosses one. */
function dateRange(from: string, to: string): string {
  if (from.slice(0, 4) === to.slice(0, 4)) return `${day(from)} – ${dayYearFmt.format(new Date(`${to}T12:00:00Z`))}`;
  return `${dayYearFmt.format(new Date(`${from}T12:00:00Z`))} – ${dayYearFmt.format(new Date(`${to}T12:00:00Z`))}`;
}

/** The New York calendar day an instant falls on, as "Dec 14". */
function easternDay(iso: string): string {
  return day(easternDate(iso));
}

function money(cents: number): string {
  const dollars = cents / 100;
  return Number.isInteger(dollars) ? `$${dollars}` : `$${dollars.toFixed(2)}`;
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** "week 3" / "weeks 3 and 5" / "weeks 3, 5 and 7". */
function weekList(weeks: number[]): string {
  if (weeks.length === 1) return `week ${weeks[0]}`;
  return `weeks ${weeks.slice(0, -1).join(", ")} and ${weeks[weeks.length - 1]}`;
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

type Ctx = ReadinessInput & {
  today: string;
  started: boolean;
  weekCount: number | null;
};

function to(editor: Editor, href: string): ReadinessLink {
  return { editor, href };
}

/** The cohort form on /admin/cohorts itself. */
const COHORT_FORM = to("cohort", "/admin/cohorts");

function check(
  id: CheckId,
  label: string,
  state: CheckState,
  detail: string,
  fix: ReadinessLink | null = null,
  items: ReadinessItem[] = [],
): ReadinessCheck {
  return { id, label, state, detail, fix, items };
}

/** Program time: a cohort has begun once it's flipped active (or done) or its first day has come in New York. */
function hasStarted(c: ReadinessCohort, today: string): boolean {
  if (c.status === "active" || c.status === "completed") return true;
  return !!c.starts_on && c.starts_on <= today;
}

function sortedModules(modules: readonly ReadinessModule[]): ReadinessModule[] {
  return [...modules]
    .sort((a, b) => a.week - b.week || a.position - b.position)
    .map((m) => ({ ...m, lessons: [...(m.lessons ?? [])].sort((a, b) => a.position - b.position) }));
}

/** Material rows exactly as the lesson page reads them: an array of objects. */
function materialsOf(lesson: ReadinessLesson): { title: string | null; path: string | null }[] {
  if (!Array.isArray(lesson.materials)) return [];
  return lesson.materials
    .filter((m): m is Record<string, unknown> => !!m && typeof m === "object")
    .map((m) => ({
      title: typeof m.title === "string" && m.title.trim() ? m.title.trim() : null,
      path: typeof m.path === "string" && m.path.trim() ? m.path.trim() : null,
    }));
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

export type FileRef = { bucket: Bucket; path: string; text: string; link: ReadinessLink };

/**
 * Every storage object this cohort's students are meant to open: lesson
 * videos, lesson materials and the cohort's own resources. The loader signs
 * exactly these paths; the files check reads the answer. Shared resources
 * (no cohort) belong to every cohort and aren't counted against any one.
 */
export function cohortFileRefs(
  modules: readonly ReadinessModule[] | null,
  resources: readonly ReadinessResource[] | null,
): { refs: FileRef[]; unattached: ReadinessItem[] } {
  const refs: FileRef[] = [];
  const unattached: ReadinessItem[] = [];
  for (const m of sortedModules(modules ?? [])) {
    const link = to("course", courseHref(m.id));
    for (const l of m.lessons) {
      const where = `Week ${m.week} · ${l.title}`;
      const video = l.video_path?.trim();
      if (video) refs.push({ bucket: "course-videos", path: video, text: `${where}: video`, link });
      for (const mat of materialsOf(l)) {
        if (mat.path) {
          refs.push({ bucket: "course-materials", path: mat.path, text: `${where}: ${mat.title ?? mat.path}`, link });
        } else {
          // The lesson page drops these without a word.
          unattached.push({ text: `${where}: ${mat.title ?? "a material"} has no file`, link });
        }
      }
    }
  }
  for (const r of resources ?? []) {
    const path = r.storage_path?.trim();
    if (path) {
      refs.push({
        bucket: "resources",
        path,
        text: `Resource · ${r.title}`,
        link: to("resources", `/admin/resources/${r.id}`),
      });
    }
  }
  return { refs, unattached };
}

/** Opens that module on /admin/course and scrolls to it. */
export function courseHref(moduleId: string): string {
  return `/admin/course?module=${moduleId}#module-${moduleId}`;
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

function datesCheck(c: Ctx): ReadinessCheck {
  const { starts_on: start, ends_on: end, status } = c.cohort;
  const missing = [!start && "start date", !end && "end date"].filter(Boolean) as string[];
  if (missing.length) {
    return check("dates", "Dates", "fail", `No ${missing.join(" or ")}.`, COHORT_FORM);
  }
  if (end! < start!) return check("dates", "Dates", "fail", "Ends before it starts.", COHORT_FORM);
  const span = `${dateRange(start!, end!)} · ${plural(c.weekCount ?? 0, "week")}`;
  if (status === "upcoming" && start! <= c.today) {
    return check("dates", "Dates", "warn", `${span}. Started ${day(start!)}, still marked Upcoming.`, COHORT_FORM);
  }
  if (status === "active" && end! < c.today) {
    return check("dates", "Dates", "warn", `${span}. Ended ${day(end!)}, still marked Active.`, COHORT_FORM);
  }
  return check("dates", "Dates", "pass", `${span}.`);
}

function enrollmentCheck(c: Ctx): ReadinessCheck {
  const k = c.cohort;
  const capacity = Number(k.capacity ?? 0);
  const price = Number(k.price_cents ?? 0);
  const seats = `${k.enrolled} of ${capacity} seats`;
  const items: ReadinessItem[] = [];
  let state: CheckState = "pass";
  const flag = (s: CheckState, text: string) => {
    if (s === "fail" || state === "pass") state = s;
    items.push({ text, link: COHORT_FORM });
  };

  if (!Number.isFinite(capacity) || capacity < 1) flag("fail", "No seats: capacity is 0.");
  else if (k.enrolled > capacity) flag("warn", `${k.enrolled} enrolled, over the ${capacity}-seat capacity.`);
  if (!Number.isFinite(price) || price <= 0) flag("warn", "Price is $0.");
  // Late entry is two halves of one switch (lib/cohort-eligibility.ts): either
  // alone reads as "enrollment closed" once the cohort starts.
  const hasDeadline = !!k.late_entry_until;
  const hasPlan = !!k.catch_up_plan?.trim();
  if (hasDeadline !== hasPlan) {
    flag("warn", hasDeadline ? "Late entry has a deadline but no catch-up plan." : "Late entry has a catch-up plan but no deadline.");
  }
  // Once a cohort starts, admissions read late_entry_until, not
  // applications_close_at — a close date after day one is never reached.
  // Only worth saying beforehand: a running cohort's close date is history.
  if (!c.started && k.applications_close_at && k.starts_on && Number.isFinite(Date.parse(k.applications_close_at))) {
    if (easternDate(k.applications_close_at) > k.starts_on) {
      flag("warn", `Applications close ${easternDay(k.applications_close_at)}, after the ${day(k.starts_on)} start; from day one only late entry admits.`);
    }
  }

  const parts = [price > 0 ? `${money(price)} list` : null, seats, admissionsNote(c)].filter(Boolean);
  return check("enrollment", "Enrollment and price", state, `${parts.join(" · ")}.`, state === "pass" ? null : COHORT_FORM, items);
}

/** Where admissions stand, in the terms lib/cohort-eligibility.ts decides them. */
function admissionsNote(c: Ctx): string | null {
  const k = c.cohort;
  const now = c.now.getTime();
  if (k.ends_on && c.today > k.ends_on) return null;
  if (c.started) {
    const until = k.late_entry_until;
    if (until && k.catch_up_plan?.trim() && Date.parse(until) > now) return `late entry until ${easternDay(until)}`;
    return "enrollment closed";
  }
  if (k.applications_close_at && Number.isFinite(Date.parse(k.applications_close_at))) {
    return Date.parse(k.applications_close_at) > now
      ? `applications close ${easternDay(k.applications_close_at)}`
      : `applications closed ${easternDay(k.applications_close_at)}`;
  }
  return null;
}

function contentCheck(c: Ctx): ReadinessCheck {
  const course = to("course", "/admin/course");
  if (!c.modules) return check("content", "Course content", "warn", "Couldn't load modules.", course);
  if (c.modules.length === 0) return check("content", "Course content", "fail", "No modules.", course);
  const modules = sortedModules(c.modules);
  const lessons = modules.reduce((n, m) => n + m.lessons.length, 0);
  if (lessons === 0) {
    return check("content", "Course content", "fail", `${plural(modules.length, "module")}, no lessons.`, course);
  }

  const items: ReadinessItem[] = [];
  const weeks = c.weekCount;
  if (weeks) {
    const covered = new Set(modules.map((m) => m.week));
    for (let w = 1; w <= weeks; w++) {
      if (!covered.has(w)) items.push({ text: `Week ${w}: no module.`, link: course });
    }
  }
  for (const m of modules) {
    const link = to("course", courseHref(m.id));
    if (weeks && m.week > weeks) {
      items.push({ text: `Week ${m.week} · ${m.title}: after the cohort's last week (${weeks}).`, link });
    }
    if (m.lessons.length === 0) items.push({ text: `Week ${m.week} · ${m.title}: no lessons.`, link });
    for (const l of m.lessons) {
      const empty =
        !l.description?.trim() && !l.video_path?.trim() && !l.video_url?.trim() && materialsOf(l).length === 0;
      if (empty) items.push({ text: `Week ${m.week} · ${l.title}: empty lesson.`, link });
    }
  }
  const summary = `${plural(modules.length, "module")}, ${plural(lessons, "lesson")}`;
  if (items.length) return check("content", "Course content", "warn", `${summary}.`, course, items);
  return check("content", "Course content", "pass", weeks ? `${summary}, every week covered.` : `${summary}.`);
}

function filesCheck(c: Ctx): ReadinessCheck {
  const label = "Course files";
  const course = to("course", "/admin/course");
  if (!c.modules) return check("files", label, "warn", "Couldn't load lessons.", course);
  const { refs, unattached } = cohortFileRefs(c.modules, c.resources);
  const unchecked = refs.filter((r) => !c.files[r.bucket]);
  const missing: ReadinessItem[] = refs
    .filter((r) => c.files[r.bucket] && !c.files[r.bucket]!.has(r.path))
    .map((r) => ({ text: r.text, link: r.link }));
  if (missing.length || unattached.length) {
    const parts = [
      missing.length ? `${missing.length} of ${plural(refs.length, "file")} not in storage` : null,
      unattached.length ? `${plural(unattached.length, "material")} with no file` : null,
    ].filter(Boolean);
    // The lesson page skips a material it can't sign and shows no video for a
    // missing one; the resource download fails on click.
    return check("files", label, "fail", `${parts.join("; ")}. Students don't get them.`, course, [...unattached, ...missing]);
  }
  if (unchecked.length) {
    return check("files", label, "warn", `Couldn't reach storage to check ${plural(unchecked.length, "file")}.`, course);
  }
  const found = refs.length === 0 ? "No uploaded files to check." : refs.length === 1 ? "The 1 file is in storage." : `All ${refs.length} files are in storage.`;
  if (!c.resources) {
    return check("files", label, "warn", `${found} Couldn't load this cohort's resources.`, to("resources", "/admin/resources"));
  }
  return check("files", label, "pass", found);
}

function assignmentsCheck(c: Ctx): ReadinessCheck {
  const board = to("assignments", `/admin/assignments?cohort=${c.cohort.id}`);
  if (!c.assignments) return check("assignments", "Assignment dates", "warn", "Couldn't load assignments.", board);
  const published = c.assignments.filter((a) => a.status === "published");
  const drafts = c.assignments.filter((a) => a.status === "draft").length;
  const draftNote = drafts ? `, ${plural(drafts, "draft")}` : "";
  if (published.length === 0) {
    return check("assignments", "Assignment dates", "warn", `No published assignments${draftNote}.`, board);
  }

  // A module's week, for assignments anchored to a module or a lesson.
  const weekOfModule = new Map<string, number>();
  const weekOfLesson = new Map<string, number>();
  for (const m of c.modules ?? []) {
    weekOfModule.set(m.id, m.week);
    for (const l of m.lessons ?? []) weekOfLesson.set(l.id, m.week);
  }

  const { starts_on: start, ends_on: end } = c.cohort;
  const items: ReadinessItem[] = [];
  let state: CheckState = "pass";
  const flag = (s: CheckState, text: string) => {
    if (s === "fail" || state === "pass") state = s;
    items.push({ text, link: board });
  };
  const sorted = [...published].sort((a, b) => (a.due_at ?? "9999").localeCompare(b.due_at ?? "9999"));
  for (const a of sorted) {
    if (!a.due_at || !Number.isFinite(Date.parse(a.due_at))) continue;
    const due = easternDate(a.due_at);
    const label = `${a.title}: due ${formatEastern(a.due_at)}`;
    // Before day one every published deadline is still ahead; one that has
    // passed already shows enrolled students a missing assignment.
    if (!c.started && Date.parse(a.due_at) < c.now.getTime()) {
      flag("fail", `${label}, already past.`);
      continue;
    }
    if (start && due < start) {
      flag("fail", `${label}, before the cohort starts ${day(start)}.`);
      continue;
    }
    if (end && due > end) {
      flag("fail", `${label}, after the cohort ends ${day(end)}.`);
      continue;
    }
    // Ordered against the curriculum: work tied to week N's module or lesson
    // can't be due before week N opens.
    const anchor = (a.lesson_id && weekOfLesson.get(a.lesson_id)) || (a.module_id && weekOfModule.get(a.module_id)) || null;
    const opens = anchor && start ? courseWeekStart(start, anchor) : null;
    if (opens && due < opens) flag("warn", `${label}, before week ${anchor} opens ${day(opens)}.`);
  }
  const summary = `${plural(published.length, "published assignment")}${draftNote}`;
  if (items.length) return check("assignments", "Assignment dates", state, `${summary}.`, board, items);
  return check("assignments", "Assignment dates", "pass", start && end ? `${summary}, all due inside the cohort's dates.` : `${summary}.`);
}

/** Events that are this cohort's sessions: shown to students, starting inside its dates. */
function cohortSessions(c: Ctx): ReadinessEvent[] {
  const { starts_on: start, ends_on: end } = c.cohort;
  return (c.events ?? [])
    .filter((e) => e.visibility !== "staff" && Number.isFinite(Date.parse(e.starts_at)))
    .filter((e) => {
      const d = easternDate(e.starts_at);
      return (!start || d >= start) && (!end || d <= end);
    })
    .sort((a, b) => Date.parse(a.starts_at) - Date.parse(b.starts_at));
}

function kickoffCheck(c: Ctx): ReadinessCheck {
  const page = to("kickoff", `/admin/cohorts/${c.cohort.id}/kickoff`);
  const start = c.cohort.starts_on;
  if (c.started && start) return check("kickoff", "Kickoff", "pass", `Kicked off ${dayYearFmt.format(new Date(`${start}T12:00:00Z`))}.`);
  if (c.started) return check("kickoff", "Kickoff", "pass", "Already started.");
  if (!start) return check("kickoff", "Kickoff", "warn", "No kickoff date: the cohort has no start date.", COHORT_FORM);
  if (!c.kickoff) return check("kickoff", "Kickoff", "warn", "Couldn't load the kickoff page.", page);

  const items: ReadinessItem[] = [];
  let state: CheckState = "pass";
  const flag = (s: CheckState, text: string, link: ReadinessLink | null = page) => {
    if (s === "fail" || state === "pass") state = s;
    items.push({ text, link });
  };
  const row = c.kickoff.row;
  const trimmed = (v: string | null | undefined) => (v ?? "").trim();
  const joinUrl = trimmed(row?.join_url);
  if (!row) {
    flag("warn", "Kickoff page not filled in: students see the defaults, with no time or place.");
  } else {
    if (!trimmed(row.time_label)) flag("warn", "No kickoff time.");
    if (!trimmed(row.location_label) && !joinUrl) flag("warn", "No place or join link.");
    // resolveKickoff hides a link that isn't https:// or an in-app path.
    if (joinUrl && !isSafeHref(joinUrl)) flag("fail", "Join link isn't https:// or an in-app path, so students don't see it.");
  }
  if (c.events) {
    const onDayOne = cohortSessions(c).some((e) => easternDate(e.starts_at) === start);
    if (!onDayOne) flag("warn", `No live session on ${day(start)}.`, to("events", "/admin/events"));
  }
  if (items.length) return check("kickoff", "Kickoff", state, `Kicks off ${day(start)}.`, page, items);
  return check("kickoff", "Kickoff", "pass", `${day(start)}: time and place set${c.events ? ", session scheduled" : ""}.`);
}

function sessionsCheck(c: Ctx): ReadinessCheck {
  const events = to("events", "/admin/events");
  if (!c.events) return check("sessions", "Live sessions", "warn", "Couldn't load events.", events);
  const { starts_on: start, ends_on: end } = c.cohort;
  if (!start || !end || !c.weekCount) {
    return check("sessions", "Live sessions", "warn", "Needs start and end dates to check each week.", COHORT_FORM);
  }
  const sessions = cohortSessions(c);
  if (sessions.length === 0) return check("sessions", "Live sessions", "fail", "No live sessions scheduled.", events);

  const byWeek = new Set<number>();
  for (const e of sessions) {
    const w = courseWeekAt(start, new Date(e.starts_at));
    if (w) byWeek.add(w);
  }
  // A running cohort's past weeks are history; only the rest can be fixed.
  const from = c.started ? Math.max(1, courseWeekAt(start, c.now) ?? 1) : 1;
  const empty: number[] = [];
  for (let w = from; w <= c.weekCount; w++) if (!byWeek.has(w)) empty.push(w);
  const scope = from > 1 ? "every remaining week" : "every week";
  if (from > c.weekCount) return check("sessions", "Live sessions", "pass", `${plural(sessions.length, "session")}; no weeks left.`);
  if (empty.length) {
    const items = empty.map((w) => {
      const first = courseWeekStart(start, w)!;
      const last = addDays(first, 6) < end ? addDays(first, 6) : end;
      return { text: `Week ${w} (${day(first)} – ${day(last)}): no session.`, link: events };
    });
    return check("sessions", "Live sessions", "warn", `${plural(sessions.length, "session")}; none in ${weekList(empty)}.`, events, items);
  }
  return check("sessions", "Live sessions", "pass", `${plural(sessions.length, "session")}, at least one in ${scope}.`);
}

function linksCheck(c: Ctx): ReadinessCheck {
  if (!c.events) return check("links", "Session links", "warn", "Couldn't load events.", to("events", "/admin/events"));
  const now = c.now.getTime();
  const ahead = cohortSessions(c).filter((e) => {
    if (e.live_ended_at) return false;
    const endsAt = e.ends_at ? Date.parse(e.ends_at) : Date.parse(e.starts_at) + DEFAULT_SESSION_MS;
    return endsAt > now;
  });
  if (ahead.length === 0) return check("links", "Session links", "pass", "No upcoming sessions to check.");
  // Hosted rooms (and legacy premieres, which run as hosted) open inside
  // batch0; an external session is only reachable through its link.
  const hosted = (e: ReadinessEvent) => e.live_mode === "hosted" || e.live_mode === "premiere";
  const noLink = ahead.filter((e) => !hosted(e) && !e.zoom_url?.trim());
  if (noLink.length) {
    const items = noLink.map((e) => ({
      text: `${formatEastern(e.starts_at)} · ${e.title}: external, no link.`,
      link: to("events", `/admin/events?edit=${e.id}`),
    }));
    return check(
      "links",
      "Session links",
      "fail",
      `${noLink.length} of ${plural(ahead.length, "upcoming session")} ${noLink.length === 1 ? "has" : "have"} no join link.`,
      to("events", "/admin/events"),
      items,
    );
  }
  const inRoom = ahead.filter(hosted).length;
  const external = ahead.length - inRoom;
  const how = [inRoom ? `${inRoom} in the batch0 room` : null, external ? `${external} by link` : null].filter(Boolean).join(", ");
  return check("links", "Session links", "pass", `${plural(ahead.length, "upcoming session")}: ${how}.`);
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

/** Every check for one cohort, in the order a launch runs. */
export function cohortReadiness(input: ReadinessInput): CohortReadiness {
  const today = easternDate(input.now);
  const canOpen = input.canOpen ?? (() => true);
  const ctx: Ctx = {
    ...input,
    today,
    started: hasStarted(input.cohort, today),
    weekCount: cohortWeekCount(input.cohort.starts_on, input.cohort.ends_on),
  };
  const permitted = (l: ReadinessLink | null) => (l && canOpen(l.editor) ? l : null);
  const checks = [
    datesCheck,
    enrollmentCheck,
    contentCheck,
    filesCheck,
    assignmentsCheck,
    kickoffCheck,
    sessionsCheck,
    linksCheck,
  ].map((run) => {
    const r = run(ctx);
    return { ...r, fix: permitted(r.fix), items: r.items.map((i) => ({ ...i, link: permitted(i.link) })) };
  });
  return {
    checks,
    fail: checks.filter((x) => x.state === "fail").length,
    warn: checks.filter((x) => x.state === "warn").length,
  };
}

/** The one-word summary on the cohort's row. */
export function readinessSummary(r: Pick<CohortReadiness, "fail" | "warn">): { tone: CheckState; label: string } {
  if (r.fail) return { tone: "fail", label: `${r.fail} to fix` };
  if (r.warn) return { tone: "warn", label: `${r.warn} to check` };
  return { tone: "pass", label: "Ready" };
}
