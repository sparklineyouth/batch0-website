/**
 * Assignment tracker — pure rules. No imports, so `node --test` runs it as-is
 * (lib/assignments.test.ts) and client components can share it.
 *
 * Dates: the program runs on New York time. A course week opens Monday 00:00
 * ET and is due Sunday 23:59 ET by default, resolved against the offset on
 * that day so it stays right across daylight-saving changes.
 */

export const PROGRAM_TZ = "America/New_York";

export const RELEASE_MODES = ["now", "date", "course_week"] as const;
export type ReleaseMode = (typeof RELEASE_MODES)[number];

export const SUBMISSION_TYPES = ["text_or_link", "link", "text"] as const;
export type SubmissionType = (typeof SUBMISSION_TYPES)[number];

export const ASSIGNMENT_STATUSES = ["published", "draft", "archived"] as const;
export type AssignmentStatus = (typeof ASSIGNMENT_STATUSES)[number];

export const AUDIENCES = ["cohort", "students"] as const;
export type Audience = (typeof AUDIENCES)[number];

export type SubmissionStatus = "submitted" | "reviewed" | "returned" | "excused";

/** What a student/assignment pair looks like right now. */
export type DerivedStatus =
  | "upcoming"
  | "open"
  | "due_today"
  | "missing"
  | "submitted"
  | "late"
  | "returned"
  | "reviewed"
  | "excused";

export const DEFAULT_DUE_DAY_OFFSET = 6; // Monday + 6 = Sunday
export const DEFAULT_DUE_LOCAL_TIME = "23:59";
export const MAX_WEEK = 52;
export const LIMITS = {
  title: 200,
  instructions: 20000,
  body: 10000,
  link: 2048,
  feedback: 4000,
} as const;

const DAY_MS = 86_400_000;

// ---------------------------------------------------------------------------
// New York wall time
// ---------------------------------------------------------------------------

const nyParts = new Intl.DateTimeFormat("en-US", {
  timeZone: PROGRAM_TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

function wallClock(instant: number): Record<string, string> {
  return Object.fromEntries(
    nyParts.formatToParts(new Date(instant)).map((p) => [p.type, p.value]),
  );
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

export function isDate(v: unknown): v is string {
  if (typeof v !== "string" || !DATE_RE.test(v)) return false;
  const t = Date.parse(`${v}T00:00:00Z`);
  // Round-trip: V8 rolls "2026-11-31" over to Dec 1 instead of rejecting it.
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === v;
}

export function isTime(v: unknown): v is string {
  return typeof v === "string" && TIME_RE.test(v);
}

/**
 * New York wall time → UTC ISO. Same fixed-point technique as
 * easternEndOfDay in lib/cohort-eligibility.ts: guess UTC, read the New York
 * wall clock at that instant, shift by the difference, repeat.
 */
export function easternToUtc(date: string, time: string = "00:00"): string | null {
  if (!isDate(date) || !isTime(time)) return null;
  const [y, m, d] = date.split("-").map(Number);
  const [hh, mm] = time.split(":").map(Number);
  const target = Date.UTC(y, m - 1, d, hh, mm, 0);
  let instant = target;
  for (let i = 0; i < 3; i++) {
    const p = wallClock(instant);
    const wall = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
    const correction = target - wall;
    if (correction === 0) break;
    instant += correction;
  }
  return new Date(instant).toISOString();
}

/** The New York calendar date an instant falls on ("YYYY-MM-DD"). */
export function easternDate(iso: string | Date): string {
  const p = wallClock(new Date(iso).getTime());
  return `${p.year}-${p.month}-${p.day}`;
}

/** The New York wall time of an instant ("HH:MM"). */
export function easternTime(iso: string | Date): string {
  const p = wallClock(new Date(iso).getTime());
  return `${p.hour}:${p.minute}`;
}

/** Two timestamps name the same instant (Postgres and JS spell them differently). */
export function sameInstant(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return !a && !b;
  return Date.parse(a) === Date.parse(b);
}

export function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

const dueFormat = new Intl.DateTimeFormat("en-US", {
  timeZone: PROGRAM_TZ,
  weekday: "short",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

/** "Sun, Oct 18, 11:59 PM ET" — deadlines are stated in program time. */
export function formatEastern(iso: string | null | undefined): string {
  if (!iso || !Number.isFinite(Date.parse(iso))) return "";
  return `${dueFormat.format(new Date(iso))} ET`;
}

const dayFormat = new Intl.DateTimeFormat("en-US", { timeZone: PROGRAM_TZ, month: "short", day: "numeric" });

/** "Oct 18" in program time. */
export function formatEasternDay(iso: string | null | undefined): string {
  if (!iso || !Number.isFinite(Date.parse(iso))) return "";
  return dayFormat.format(new Date(iso));
}

// ---------------------------------------------------------------------------
// Course weeks
// ---------------------------------------------------------------------------

/** First day (a date) of week N, counting from the cohort's start date. */
export function courseWeekStart(startsOn: string, week: number): string | null {
  if (!isDate(startsOn) || !Number.isInteger(week) || week < 1 || week > MAX_WEEK) return null;
  return addDays(startsOn, 7 * (week - 1));
}

/**
 * Opens 00:00 ET on the week's first day; due `dueLocalTime` ET `dueDayOffset`
 * days later, but never after the cohort's last day: a cohort that ends on a
 * Friday has its last week due that Friday. `dueDayOffset` in the result is
 * the day actually used, so storing it keeps a recompute stable.
 */
export function courseWeekWindow(args: {
  startsOn: string;
  endsOn?: string | null;
  week: number;
  dueDayOffset?: number | null;
  dueLocalTime?: string | null;
}): { opensAt: string; dueAt: string; dueDayOffset: number } | null {
  const start = courseWeekStart(args.startsOn, args.week);
  if (!start) return null;
  let offset = args.dueDayOffset ?? DEFAULT_DUE_DAY_OFFSET;
  if (!Number.isInteger(offset) || offset < 0 || offset > 13) return null;
  if (isDate(args.endsOn) && args.endsOn >= start) {
    offset = Math.min(offset, daysBetween(start, args.endsOn));
  }
  const time = args.dueLocalTime ? args.dueLocalTime.slice(0, 5) : DEFAULT_DUE_LOCAL_TIME;
  const opensAt = easternToUtc(start, "00:00");
  const dueAt = easternToUtc(addDays(start, offset), time);
  if (!opensAt || !dueAt || Date.parse(dueAt) <= Date.parse(opensAt)) return null;
  return { opensAt, dueAt, dueDayOffset: offset };
}

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
}

/** How many course weeks a cohort spans: Sep 14 – Nov 13 is 9. */
export function cohortWeekCount(startsOn: string | null, endsOn: string | null): number | null {
  if (!isDate(startsOn) || !isDate(endsOn) || endsOn < startsOn) return null;
  return Math.min(MAX_WEEK, Math.ceil((daysBetween(startsOn, endsOn) + 1) / 7));
}

/** Week of the cohort a moment falls in (New York calendar), or null before day one. */
export function courseWeekAt(startsOn: string | null, now: Date = new Date()): number | null {
  if (!isDate(startsOn)) return null;
  const days = (Date.parse(`${easternDate(now)}T00:00:00Z`) - Date.parse(`${startsOn}T00:00:00Z`)) / DAY_MS;
  return days < 0 ? null : Math.floor(days / 7) + 1;
}

/** Weeks k..W for "Repeat weekly". Empty when the range is invalid. */
export function seriesWeeks(fromWeek: number, throughWeek: number): number[] {
  if (!Number.isInteger(fromWeek) || !Number.isInteger(throughWeek)) return [];
  if (fromWeek < 1 || throughWeek > MAX_WEEK || throughWeek < fromWeek) return [];
  return Array.from({ length: throughWeek - fromWeek + 1 }, (_, i) => fromWeek + i);
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

export type StatusInput = {
  opensAt: string | null;
  dueAt: string | null;
  /** When this student joined the cohort. Work due before that is excused. */
  enrolledAt?: string | null;
  submission?: { status: SubmissionStatus; late: boolean } | null;
  now?: Date;
};

export function deriveStatus(input: StatusInput): DerivedStatus {
  const now = (input.now ?? new Date()).getTime();
  const s = input.submission;
  if (s) {
    if (s.status === "excused") return "excused";
    if (s.status === "reviewed") return "reviewed";
    if (s.status === "returned") return "returned";
    return s.late ? "late" : "submitted";
  }
  if (input.opensAt && Date.parse(input.opensAt) > now) return "upcoming";
  if (input.dueAt) {
    const due = Date.parse(input.dueAt);
    if (input.enrolledAt && due < Date.parse(input.enrolledAt)) return "excused";
    if (now > due) return "missing";
    if (easternDate(input.dueAt) === easternDate(new Date(now))) return "due_today";
  }
  return "open";
}

const STUDENT_LABELS: Record<DerivedStatus, string> = {
  upcoming: "Upcoming",
  open: "Open",
  due_today: "Due today",
  missing: "Late",
  submitted: "Submitted",
  late: "Submitted late",
  returned: "Needs changes",
  reviewed: "Reviewed",
  excused: "Excused",
};

export function statusLabel(status: DerivedStatus, audience: "student" | "staff" = "student"): string {
  if (audience === "staff" && status === "missing") return "Missing";
  return STUDENT_LABELS[status];
}

export type StatusTone = "accent" | "warn" | "bad" | "good" | "muted";

export function statusTone(status: DerivedStatus): StatusTone {
  switch (status) {
    case "due_today":
    case "returned":
      return "warn";
    case "missing":
      return "bad";
    case "submitted":
    case "late":
    case "reviewed":
      return "good";
    case "open":
      return "accent";
    default:
      return "muted";
  }
}

/** Nothing left for the student to do (handed in, or excused). */
export function isDone(status: DerivedStatus): boolean {
  return isHandedIn(status) || status === "excused";
}

/** Work is in and not sent back. The numerator of "N of M in". */
export function isHandedIn(status: DerivedStatus): boolean {
  return status === "submitted" || status === "late" || status === "reviewed";
}

/** Counts toward "M" in "N of M in": released and not excused. */
export function isOwed(status: DerivedStatus): boolean {
  return status !== "upcoming" && status !== "excused";
}

/** The student list: what needs doing soon, what's further out, what's done. */
export function studentGroup(
  status: DerivedStatus,
  dueAt: string | null,
  now: Date = new Date(),
): "due" | "upcoming" | "done" {
  if (isDone(status)) return "done";
  if (status === "missing" || status === "returned" || status === "due_today") return "due";
  if (dueAt && Date.parse(dueAt) - now.getTime() <= 7 * DAY_MS) return "due";
  return "upcoming";
}

/** A submission can be edited until a reviewer signs it off (or it's excused). */
export function canEditSubmission(status: SubmissionStatus | null | undefined): boolean {
  return status !== "reviewed" && status !== "excused";
}

// ---------------------------------------------------------------------------
// Submissions
// ---------------------------------------------------------------------------

/** https only, no whitespace, sane length. Null for an empty field. */
export function normalizeLink(raw: string | null | undefined): { ok: true; url: string | null } | { ok: false; error: string } {
  const value = (raw ?? "").trim();
  if (!value) return { ok: true, url: null };
  if (value.length > LIMITS.link || /\s/.test(value)) return { ok: false, error: "That link isn't valid." };
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { ok: false, error: "That link isn't valid." };
  }
  if (url.protocol !== "https:") return { ok: false, error: "Use an https:// link." };
  if (!url.hostname.includes(".") || url.username || url.password) {
    return { ok: false, error: "That link isn't valid." };
  }
  return { ok: true, url: url.toString() };
}

export function isGoogleLink(url: string | null | undefined): boolean {
  if (!url) return false;
  try {
    const host = new URL(url).hostname;
    return host === "drive.google.com" || host === "docs.google.com";
  } catch {
    return false;
  }
}

export function validateSubmission(args: {
  type: SubmissionType;
  body?: string | null;
  link?: string | null;
}): { ok: true; body: string | null; link: string | null } | { ok: false; error: string } {
  const body = (args.body ?? "").trim();
  if (body.length > LIMITS.body) return { ok: false, error: `Keep it under ${LIMITS.body} characters.` };
  const link = args.type === "text" ? ({ ok: true, url: null } as const) : normalizeLink(args.link);
  if (!link.ok) return link;
  if (args.type === "link" && !link.url) return { ok: false, error: "Add a link." };
  if (args.type === "text" && !body) return { ok: false, error: "Write your answer." };
  if (!body && !link.url) return { ok: false, error: "Add a link or some text." };
  return { ok: true, body: body || null, link: link.url };
}

// ---------------------------------------------------------------------------
// Completion matrix
// ---------------------------------------------------------------------------

export type MatrixAssignment = {
  id: string;
  opensAt: string | null;
  dueAt: string | null;
  audience: Audience;
};

export type MatrixStudent = { userId: string; enrolledAt: string | null };

export type MatrixSubmission = {
  assignmentId: string;
  userId: string;
  status: SubmissionStatus;
  late: boolean;
};

export type MatrixRow = {
  userId: string;
  /** null = this assignment isn't for this student. */
  cells: Record<string, DerivedStatus | null>;
  missing: number;
  /** Handed in, of `due`. */
  done: number;
  /** Released and not excused. */
  due: number;
};

/** One row per student, one cell per assignment. */
export function buildMatrix(args: {
  assignments: MatrixAssignment[];
  students: MatrixStudent[];
  submissions: MatrixSubmission[];
  /** assignment id → user ids, for audience = "students". */
  targets: Map<string, Set<string>>;
  now?: Date;
}): MatrixRow[] {
  const subs = new Map<string, MatrixSubmission>();
  for (const s of args.submissions) subs.set(`${s.assignmentId}:${s.userId}`, s);
  return args.students.map((student) => {
    const cells: Record<string, DerivedStatus | null> = {};
    let missing = 0;
    let done = 0;
    let due = 0;
    for (const a of args.assignments) {
      if (a.audience === "students" && !args.targets.get(a.id)?.has(student.userId)) {
        cells[a.id] = null;
        continue;
      }
      const status = deriveStatus({
        opensAt: a.opensAt,
        dueAt: a.dueAt,
        enrolledAt: student.enrolledAt,
        submission: subs.get(`${a.id}:${student.userId}`) ?? null,
        now: args.now,
      });
      cells[a.id] = status;
      if (status === "missing") missing++;
      if (isHandedIn(status)) done++;
      if (isOwed(status)) due++;
    }
    return { userId: student.userId, cells, missing, done, due };
  });
}

export type TeamCompletion = {
  /** Handed in, summed over the team's enrolled members. */
  done: number;
  /** Released and not excused, summed the same way. */
  due: number;
  /** Past due with nothing in, summed. */
  missing: number;
  /** Whole-number done/due, or null while nothing has come due. */
  percent: number | null;
  /** Members with a row on the cohort's board — enrolled in the team's cohort. */
  counted: number;
};

/**
 * One team's share of its cohort's completion matrix: the number on the
 * admin team page that says how far along the team is, for whoever is
 * judging readiness before Demo Day.
 *
 * Summed over pairs, not averaged over people: three of four in for one
 * student and none of four for another is three of eight, which is what the
 * team has actually handed in. A member with no row (a mentor added to the
 * team, or someone not enrolled in its cohort) owes nothing and is left out
 * rather than counted as zero.
 */
export function teamCompletion(rows: readonly MatrixRow[], memberIds: readonly string[]): TeamCompletion {
  const members = new Set(memberIds);
  let done = 0;
  let due = 0;
  let missing = 0;
  let counted = 0;
  for (const row of rows) {
    if (!members.has(row.userId)) continue;
    counted++;
    done += row.done;
    due += row.due;
    missing += row.missing;
  }
  return { done, due, missing, counted, percent: due > 0 ? Math.round((done / due) * 100) : null };
}

// ---------------------------------------------------------------------------
// Admin form
// ---------------------------------------------------------------------------

export type AssignmentDraft = {
  title: string;
  instructions?: string | null;
  release: ReleaseMode;
  /** release = "date" */
  opensDate?: string | null;
  opensTime?: string | null;
  /** release = "now" | "date"; optional */
  dueDate?: string | null;
  dueTime?: string | null;
  /** release = "course_week" */
  week?: number | null;
  dueDayOffset?: number | null;
  dueLocalTime?: string | null;
  submissionType: SubmissionType;
  audience: Audience;
  status: AssignmentStatus;
};

export type NormalizedDraft = {
  title: string;
  instructions: string;
  release: ReleaseMode;
  opensAt: string | null;
  dueAt: string | null;
  week: number | null;
  dueDayOffset: number | null;
  dueLocalTime: string | null;
  submissionType: SubmissionType;
  audience: Audience;
  status: AssignmentStatus;
};

/**
 * Validate the admin form. Course-week dates need the cohort's start (and
 * end) date, so they're resolved here; `now` stamps a "now" release.
 */
export function normalizeDraft(
  d: AssignmentDraft,
  ctx: { startsOn: string | null; endsOn?: string | null; now?: Date },
): { ok: true; value: NormalizedDraft } | { ok: false; error: string } {
  const title = (d.title ?? "").trim();
  if (!title) return { ok: false, error: "Add a title." };
  if (title.length > LIMITS.title) return { ok: false, error: `Keep the title under ${LIMITS.title} characters.` };
  const instructions = (d.instructions ?? "").trim();
  if (instructions.length > LIMITS.instructions) return { ok: false, error: "Instructions are too long." };
  if (!RELEASE_MODES.includes(d.release)) return { ok: false, error: "Pick when it opens." };
  if (!SUBMISSION_TYPES.includes(d.submissionType)) return { ok: false, error: "Pick a submission type." };
  if (!AUDIENCES.includes(d.audience)) return { ok: false, error: "Pick who it's for." };
  if (!ASSIGNMENT_STATUSES.includes(d.status)) return { ok: false, error: "Pick a status." };

  const base = { title, instructions, release: d.release, submissionType: d.submissionType, audience: d.audience, status: d.status };

  if (d.release === "course_week") {
    if (!ctx.startsOn) return { ok: false, error: "This cohort has no start date." };
    const week = Number(d.week);
    if (!Number.isInteger(week) || week < 1 || week > MAX_WEEK) return { ok: false, error: "Pick a week." };
    const offset = d.dueDayOffset == null ? DEFAULT_DUE_DAY_OFFSET : Number(d.dueDayOffset);
    const time = d.dueLocalTime || DEFAULT_DUE_LOCAL_TIME;
    if (!Number.isInteger(offset) || offset < 0 || offset > 13) return { ok: false, error: "Pick a due day." };
    if (!isTime(time)) return { ok: false, error: "Pick a due time." };
    const w = courseWeekWindow({ startsOn: ctx.startsOn, endsOn: ctx.endsOn, week, dueDayOffset: offset, dueLocalTime: time });
    if (!w) return { ok: false, error: "Those dates don't work." };
    return {
      ok: true,
      value: { ...base, opensAt: w.opensAt, dueAt: w.dueAt, week, dueDayOffset: w.dueDayOffset, dueLocalTime: time },
    };
  }

  let opensAt: string | null = null;
  if (d.release === "date") {
    opensAt = d.opensDate ? easternToUtc(d.opensDate, d.opensTime || "00:00") : null;
    if (!opensAt) return { ok: false, error: "Pick an open date." };
  } else {
    opensAt = (ctx.now ?? new Date()).toISOString();
  }
  let dueAt: string | null = null;
  if (d.dueDate) {
    dueAt = easternToUtc(d.dueDate, d.dueTime || DEFAULT_DUE_LOCAL_TIME);
    if (!dueAt) return { ok: false, error: "Pick a valid due date." };
    if (Date.parse(dueAt) <= Date.parse(opensAt)) return { ok: false, error: "Due date must be after it opens." };
  }
  return { ok: true, value: { ...base, opensAt, dueAt, week: null, dueDayOffset: null, dueLocalTime: null } };
}
