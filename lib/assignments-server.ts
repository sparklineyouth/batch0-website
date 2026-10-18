import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/admin";
import { isMissingSchemaError } from "@/lib/schema-ready";
import {
  buildMatrix,
  courseWeekWindow,
  deriveStatus,
  formatEastern,
  sameInstant,
  type Audience,
  type DerivedStatus,
  type MatrixRow,
  type ReleaseMode,
  type SubmissionStatus,
  type SubmissionType,
  type AssignmentStatus,
} from "@/lib/assignments";
import type { MentorScope } from "@/lib/mentor-scope";
import type { DraftLoad, DraftRow } from "@/lib/assignment-drafts";

/**
 * Assignment reads shared by the student, mentor and admin surfaces, the
 * reminders cron and the overview tile. Every read tolerates migration 0093
 * not being applied yet: callers get `ready: false` (or 0) and render an
 * empty state instead of failing.
 */

type Db = SupabaseClient<any, any, any>;

export const ASSIGNMENT_COLUMNS =
  "id, cohort_id, module_id, lesson_id, series_id, week, title, instructions, audience, release_mode, opens_at, due_at, due_day_offset, due_local_time, submission_type, status, created_at";
export const SUBMISSION_COLUMNS =
  "id, assignment_id, user_id, body, link_url, status, submitted_at, late, feedback, reviewed_by, reviewed_at, updated_at";

export type AssignmentRow = {
  id: string;
  cohort_id: string;
  module_id: string | null;
  lesson_id: string | null;
  series_id: string | null;
  week: number | null;
  title: string;
  instructions: string;
  audience: Audience;
  release_mode: ReleaseMode;
  opens_at: string | null;
  due_at: string | null;
  due_day_offset: number | null;
  due_local_time: string | null;
  submission_type: SubmissionType;
  status: AssignmentStatus;
  created_at: string;
};

export type SubmissionRow = {
  id: string;
  assignment_id: string;
  user_id: string;
  body: string | null;
  link_url: string | null;
  status: SubmissionStatus;
  submitted_at: string | null;
  late: boolean;
  feedback: string | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
  updated_at: string;
};

export type StudentItem = {
  assignment: AssignmentRow;
  submission: SubmissionRow | null;
  status: DerivedStatus;
};

function fail(error: unknown): { ready: false } {
  if (!isMissingSchemaError(error)) console.error("[assignments] read failed", error);
  return { ready: false };
}

// ---------------------------------------------------------------------------
// Student
// ---------------------------------------------------------------------------

/**
 * What one student has been set: published, released, in a cohort they're
 * enrolled in, for the whole cohort or for them specifically. The filters are
 * explicit, so this is safe on the service-role client too (mentor and admin
 * views of a student); student pages pass their own RLS client.
 */
export async function loadStudentAssignments(
  db: Db,
  userId: string,
  opts: { now?: Date; assignmentId?: string; lessonId?: string } = {},
): Promise<{ ready: boolean; items: StudentItem[] }> {
  const now = opts.now ?? new Date();
  const { data: enrollments, error: enrollErr } = await db
    .from("enrollments")
    .select("cohort_id, enrolled_at")
    .eq("user_id", userId);
  if (enrollErr) return { ...fail(enrollErr), items: [] };
  const enrolledAt = new Map<string, string>();
  for (const e of enrollments ?? []) enrolledAt.set(e.cohort_id as string, e.enrolled_at as string);
  if (enrolledAt.size === 0) return { ready: true, items: [] };

  let q = db
    .from("course_assignments")
    .select(ASSIGNMENT_COLUMNS)
    .in("cohort_id", [...enrolledAt.keys()])
    .eq("status", "published")
    .or(`opens_at.is.null,opens_at.lte.${now.toISOString()}`)
    .order("due_at", { ascending: true, nullsFirst: false })
    .order("created_at", { ascending: true });
  if (opts.assignmentId) q = q.eq("id", opts.assignmentId);
  if (opts.lessonId) q = q.eq("lesson_id", opts.lessonId);
  const { data: rows, error } = await q;
  if (error) return { ...fail(error), items: [] };
  const assignments = (rows ?? []) as AssignmentRow[];

  let targeted = new Set<string>();
  if (assignments.some((a) => a.audience === "students")) {
    const { data: t, error: tErr } = await db
      .from("course_assignment_targets")
      .select("assignment_id")
      .eq("user_id", userId)
      .in("assignment_id", assignments.filter((a) => a.audience === "students").map((a) => a.id));
    if (tErr) return { ...fail(tErr), items: [] };
    targeted = new Set((t ?? []).map((r) => r.assignment_id as string));
  }
  const visible = assignments.filter((a) => a.audience === "cohort" || targeted.has(a.id));
  if (visible.length === 0) return { ready: true, items: [] };

  const { data: subs, error: subErr } = await db
    .from("course_assignment_submissions")
    .select(SUBMISSION_COLUMNS)
    .eq("user_id", userId)
    .in("assignment_id", visible.map((a) => a.id));
  if (subErr) return { ...fail(subErr), items: [] };
  const byAssignment = new Map((subs ?? []).map((s) => [s.assignment_id as string, s as SubmissionRow]));

  return {
    ready: true,
    items: visible.map((assignment) => {
      const submission = byAssignment.get(assignment.id) ?? null;
      return {
        assignment,
        submission,
        status: deriveStatus({
          opensAt: assignment.opens_at,
          dueAt: assignment.due_at,
          enrolledAt: enrolledAt.get(assignment.cohort_id) ?? null,
          submission,
          now,
        }),
      };
    }),
  };
}

/**
 * The student's own unsubmitted draft of one assignment (migration 0105).
 * Pass the student's RLS client: the policy is owner-only, which is the
 * point — no staff surface ever calls this (the assignment pages and the
 * draft route, app/api/assignments/[id]/draft, do). Before 0105 runs the
 * table is missing and the form simply works without autosave, as it did
 * before.
 */
export async function loadAssignmentDraft(db: Db, userId: string, assignmentId: string): Promise<DraftLoad> {
  const { data, error } = await db
    .from("course_assignment_drafts")
    .select("body, link_url, version, updated_at, cleared_at")
    .eq("user_id", userId)
    .eq("assignment_id", assignmentId)
    .maybeSingle();
  if (error) {
    if (isMissingSchemaError(error)) return { state: "not_ready" };
    console.error("[assignments] draft read failed", assignmentId, error.message);
    return { state: "failed" };
  }
  return { state: "ready", row: (data as DraftRow | null) ?? null };
}

// ---------------------------------------------------------------------------
// Audience + notifications
// ---------------------------------------------------------------------------

export type AudienceMember = { userId: string; enrolledAt: string | null };

/** Who an assignment is for: its cohort's enrollments, narrowed to targets when audience = students. */
export async function audienceFor(
  admin: Db,
  a: Pick<AssignmentRow, "id" | "cohort_id" | "audience">,
): Promise<AudienceMember[]> {
  const { data: enrolled } = await admin
    .from("enrollments")
    .select("user_id, enrolled_at")
    .eq("cohort_id", a.cohort_id);
  let members = (enrolled ?? []).map((e) => ({ userId: e.user_id as string, enrolledAt: e.enrolled_at as string }));
  if (a.audience === "students") {
    const { data: t } = await admin.from("course_assignment_targets").select("user_id").eq("assignment_id", a.id);
    const ids = new Set((t ?? []).map((r) => r.user_id as string));
    members = members.filter((m) => ids.has(m.userId));
  }
  return members;
}

/**
 * Insert notifications once per (user, dedupe key) and report who actually got
 * a new row — the reminders cron emails exactly those, so a retried run never
 * emails twice.
 */
export async function notifyOnce(
  admin: Db,
  rows: { userId: string; type: string; title: string; body?: string | null; link: string; dedupeKey: string }[],
): Promise<Set<string>> {
  if (rows.length === 0) return new Set();
  const { data, error } = await admin
    .from("notifications")
    .upsert(
      rows.map((r) => ({
        user_id: r.userId,
        type: r.type,
        title: r.title,
        body: r.body ?? null,
        link: r.link,
        dedupe_key: r.dedupeKey,
      })),
      { onConflict: "user_id,dedupe_key", ignoreDuplicates: true },
    )
    .select("user_id");
  if (error) {
    console.error("[assignments] notify failed", rows[0]?.type, error.message);
    return new Set();
  }
  return new Set((data ?? []).map((r) => r.user_id as string));
}

/** "New assignment" bell for everyone it's for. Deduped per assignment. */
export async function notifyReleased(admin: Db, a: AssignmentRow): Promise<number> {
  const audience = await audienceFor(admin, a);
  const sent = await notifyOnce(
    admin,
    audience.map((m) => ({
      userId: m.userId,
      type: "assignment_released",
      title: `New assignment: ${a.title}`,
      body: a.due_at ? `Due ${formatEastern(a.due_at)}` : null,
      link: `/dashboard/assignments/${a.id}`,
      dedupeKey: `assignment_released:${a.id}`,
    })),
  );
  return sent.size;
}

// ---------------------------------------------------------------------------
// Admin board
// ---------------------------------------------------------------------------

export type BoardStudent = { userId: string; name: string | null; email: string | null; enrolledAt: string | null };

export type CohortBoard = {
  ready: boolean;
  /**
   * With `ready: false`: true when a read failed for any reason but 0093 not
   * being applied (say "couldn't load"), false when it isn't applied (say
   * "not set up yet"). Never true with `ready: true`.
   */
  failed: boolean;
  assignments: AssignmentRow[];
  /** Released, published — the matrix columns, by due date. */
  columns: AssignmentRow[];
  students: BoardStudent[];
  targets: Map<string, Set<string>>;
  submissions: SubmissionRow[];
  rows: MatrixRow[];
};

/**
 * A cohort's completion matrix: its assignments, enrolled students, targets
 * and submissions. Every read's error counts. One that was ignored used to
 * read as an answer — a failed enrollments read as "no member is enrolled",
 * a failed submissions read as everyone missing everything — and a failed
 * assignments read as "not set up yet". Now any failure but a missing table
 * is `failed: true`, so the matrix, the CSV and a team's Readiness card can
 * say "couldn't load" instead.
 */
export async function loadCohortBoard(admin: Db, cohortId: string, now: Date = new Date()): Promise<CohortBoard> {
  const empty = (error: unknown): CohortBoard => ({
    ...fail(error),
    failed: !isMissingSchemaError(error),
    assignments: [], columns: [], students: [], targets: new Map(), submissions: [], rows: [],
  });
  const [{ data: rows, error }, { data: enrolled, error: enrolledError }] = await Promise.all([
    admin
      .from("course_assignments")
      .select(ASSIGNMENT_COLUMNS)
      .eq("cohort_id", cohortId)
      .order("due_at", { ascending: true, nullsFirst: false })
      .order("created_at", { ascending: true }),
    admin
      .from("enrollments")
      .select("user_id, enrolled_at, profile:profiles!enrollments_user_id_fkey(full_name, email)")
      .eq("cohort_id", cohortId),
  ]);
  if (error) return empty(error);
  if (enrolledError) return empty(enrolledError);
  const assignments = (rows ?? []) as AssignmentRow[];
  const students: BoardStudent[] = (enrolled ?? [])
    .map((e: any) => {
      const p = Array.isArray(e.profile) ? e.profile[0] : e.profile;
      return { userId: e.user_id, name: p?.full_name ?? null, email: p?.email ?? null, enrolledAt: e.enrolled_at };
    })
    .sort((a, b) => (a.name ?? a.email ?? "").localeCompare(b.name ?? b.email ?? ""));
  const ids = assignments.map((a) => a.id);
  const [{ data: t, error: targetsError }, { data: subs, error: subsError }] = ids.length
    ? await Promise.all([
        admin.from("course_assignment_targets").select("assignment_id, user_id").in("assignment_id", ids),
        admin.from("course_assignment_submissions").select(SUBMISSION_COLUMNS).in("assignment_id", ids),
      ])
    : [{ data: [], error: null }, { data: [], error: null }];
  if (targetsError) return empty(targetsError);
  if (subsError) return empty(subsError);
  const targets = new Map<string, Set<string>>();
  for (const r of t ?? []) {
    const set = targets.get(r.assignment_id as string) ?? new Set<string>();
    set.add(r.user_id as string);
    targets.set(r.assignment_id as string, set);
  }
  const submissions = (subs ?? []) as SubmissionRow[];
  const columns = assignments.filter(
    (a) => a.status === "published" && (!a.opens_at || Date.parse(a.opens_at) <= now.getTime()),
  );
  return {
    ready: true,
    failed: false,
    assignments,
    columns,
    students,
    targets,
    submissions,
    rows: buildMatrix({
      assignments: columns.map((a) => ({ id: a.id, opensAt: a.opens_at, dueAt: a.due_at, audience: a.audience })),
      students: students.map((s) => ({ userId: s.userId, enrolledAt: s.enrolledAt })),
      submissions: submissions.map((s) => ({ assignmentId: s.assignment_id, userId: s.user_id, status: s.status, late: s.late })),
      targets,
      now,
    }),
  };
}

/**
 * Student/assignment pairs past due with nothing handed in, across active
 * cohorts. The overview and the phone admin show this one number.
 */
export async function countOverdueAssignments(
  admin: Db = createAdminClient(),
  now: Date = new Date(),
): Promise<number> {
  try {
    const { data: cohorts } = await admin.from("cohorts").select("id").eq("status", "active");
    const cohortIds = (cohorts ?? []).map((c) => c.id as string);
    if (cohortIds.length === 0) return 0;
    const { data: rows, error } = await admin
      .from("course_assignments")
      .select("id, cohort_id, audience, opens_at, due_at")
      .in("cohort_id", cohortIds)
      .eq("status", "published")
      .lt("due_at", now.toISOString());
    if (error) {
      fail(error);
      return 0;
    }
    const assignments = rows ?? [];
    if (assignments.length === 0) return 0;
    const ids = assignments.map((a) => a.id as string);
    const [{ data: enrolled }, { data: t }, { data: subs }] = await Promise.all([
      admin.from("enrollments").select("user_id, cohort_id, enrolled_at").in("cohort_id", cohortIds),
      admin.from("course_assignment_targets").select("assignment_id, user_id").in("assignment_id", ids),
      admin.from("course_assignment_submissions").select("assignment_id, user_id, status, late").in("assignment_id", ids),
    ]);
    const targets = new Map<string, Set<string>>();
    for (const r of t ?? []) {
      const set = targets.get(r.assignment_id as string) ?? new Set<string>();
      set.add(r.user_id as string);
      targets.set(r.assignment_id as string, set);
    }
    let total = 0;
    for (const cohortId of cohortIds) {
      const matrix = buildMatrix({
        assignments: assignments
          .filter((a) => a.cohort_id === cohortId)
          .map((a) => ({ id: a.id, opensAt: a.opens_at, dueAt: a.due_at, audience: a.audience })),
        students: (enrolled ?? [])
          .filter((e) => e.cohort_id === cohortId)
          .map((e) => ({ userId: e.user_id as string, enrolledAt: e.enrolled_at as string })),
        submissions: (subs ?? []).map((s) => ({
          assignmentId: s.assignment_id as string,
          userId: s.user_id as string,
          status: s.status as SubmissionStatus,
          late: !!s.late,
        })),
        targets,
        now,
      });
      for (const r of matrix) total += r.missing;
    }
    return total;
  } catch (err) {
    fail(err);
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Mentor review queue
// ---------------------------------------------------------------------------

export type QueueItem = SubmissionRow & {
  assignment: { id: string; title: string; week: number | null; due_at: string | null; cohort_id: string };
  student: { full_name: string | null; email: string | null };
};

/**
 * The PostgREST `or` filter that narrows submissions to a mentor's scope —
 * their cohorts' assignments, or their own students. `null` = program-wide
 * (`scope` null); "none" = an empty scope, which sees nothing. Shared by the
 * review queue and the Overview's attention list, so the two can't disagree
 * about whose work a mentor is waiting on.
 */
async function reviewScopeFilter(
  admin: Db,
  scope: MentorScope | null,
): Promise<{ ok: true; filter: string | null | "none" } | { ok: false; error: unknown }> {
  if (!scope) return { ok: true, filter: null };
  let assignmentIds: string[] = [];
  if (scope.cohortIds.length) {
    const { data, error } = await admin.from("course_assignments").select("id").in("cohort_id", scope.cohortIds);
    if (error) return { ok: false, error };
    assignmentIds = (data ?? []).map((r) => r.id as string);
  }
  const halves = [
    assignmentIds.length ? `assignment_id.in.(${assignmentIds.join(",")})` : null,
    scope.studentIds.length ? `user_id.in.(${scope.studentIds.join(",")})` : null,
  ].filter(Boolean);
  return { ok: true, filter: halves.length ? halves.join(",") : "none" };
}

/**
 * Submitted work waiting on a reviewer, plus the latest reviewed. `scope`
 * null = program-wide (admin-area viewers); an empty scope sees nothing.
 * `pendingTotal` is every waiting submission; `pending` the oldest 200.
 */
export async function loadReviewQueue(
  admin: Db,
  scope: MentorScope | null,
): Promise<{ ready: boolean; pending: QueueItem[]; pendingTotal: number; recent: QueueItem[] }> {
  const scoped = await reviewScopeFilter(admin, scope);
  if (!scoped.ok) return { ...fail(scoped.error), pending: [], pendingTotal: 0, recent: [] };
  const filter = scoped.filter;
  if (filter === "none") return { ready: true, pending: [], pendingTotal: 0, recent: [] };
  const select = `${SUBMISSION_COLUMNS}, assignment:course_assignments!inner(id, title, week, due_at, cohort_id), student:profiles!course_assignment_submissions_user_id_fkey(full_name, email)`;
  let pendingQ = admin
    .from("course_assignment_submissions")
    .select(select, { count: "exact" })
    .eq("status", "submitted")
    .order("submitted_at", { ascending: true })
    .limit(200);
  let recentQ = admin
    .from("course_assignment_submissions")
    .select(select)
    .in("status", ["reviewed", "returned"])
    .order("reviewed_at", { ascending: false })
    .limit(20);
  if (filter) {
    pendingQ = pendingQ.or(filter);
    recentQ = recentQ.or(filter);
  }
  const [pending, recent] = await Promise.all([pendingQ, recentQ]);
  if (pending.error) return { ...fail(pending.error), pending: [], pendingTotal: 0, recent: [] };
  const norm = (rows: any[] | null): QueueItem[] =>
    (rows ?? []).map((r) => ({
      ...r,
      assignment: Array.isArray(r.assignment) ? r.assignment[0] : r.assignment,
      student: (Array.isArray(r.student) ? r.student[0] : r.student) ?? { full_name: null, email: null },
    }));
  const items = norm(pending.data);
  return { ready: true, pending: items, pendingTotal: pending.count ?? items.length, recent: norm(recent.data) };
}

/** A submission waiting for feedback, as the attention list shows it: no body. */
export type FeedbackWaiting = {
  id: string;
  assignmentId: string;
  userId: string;
  submittedAt: string | null;
  late: boolean;
  assignment: { title: string; week: number | null; cohortId: string };
  studentName: string | null;
};

/**
 * The oldest `limit` submissions waiting for feedback in this scope, and how
 * many there are — the same rows, in the same order, as the review queue's
 * "To review" (loadReviewQueue), without reading anyone's work.
 *
 * `failed` tells the two kinds of `ready: false` apart: false when 0093 isn't
 * applied (say nothing), true for any other error (say "couldn't load") — so
 * a timeout never reads as an empty queue.
 */
export async function loadFeedbackQueue(
  admin: Db,
  scope: MentorScope | null,
  opts: { limit: number },
): Promise<{ ready: boolean; failed: boolean; total: number; items: FeedbackWaiting[] }> {
  const failed = (error: unknown) => ({ ...fail(error), failed: !isMissingSchemaError(error), total: 0, items: [] });
  const scoped = await reviewScopeFilter(admin, scope);
  if (!scoped.ok) return failed(scoped.error);
  if (scoped.filter === "none") return { ready: true, failed: false, total: 0, items: [] };
  let q = admin
    .from("course_assignment_submissions")
    .select(
      "id, assignment_id, user_id, submitted_at, late, assignment:course_assignments!inner(title, week, cohort_id), student:profiles!course_assignment_submissions_user_id_fkey(full_name, email)",
      { count: "exact" },
    )
    .eq("status", "submitted")
    .order("submitted_at", { ascending: true })
    .limit(Math.max(1, opts.limit));
  if (scoped.filter) q = q.or(scoped.filter);
  const { data, error, count } = await q;
  if (error) return failed(error);
  const items = ((data ?? []) as any[]).map((r): FeedbackWaiting => {
    const a = Array.isArray(r.assignment) ? r.assignment[0] : r.assignment;
    const st = Array.isArray(r.student) ? r.student[0] : r.student;
    return {
      id: r.id,
      assignmentId: r.assignment_id,
      userId: r.user_id,
      submittedAt: r.submitted_at ?? null,
      late: !!r.late,
      assignment: { title: a?.title ?? "Assignment", week: a?.week ?? null, cohortId: a?.cohort_id ?? "" },
      studentName: st?.full_name?.trim() || st?.email || null,
    };
  });
  return { ready: true, failed: false, total: count ?? items.length, items };
}

// ---------------------------------------------------------------------------
// Course-week dates follow the course
// ---------------------------------------------------------------------------

/**
 * Re-derive week/opens_at/due_at for course_week rows after a cohort's dates
 * or a module's week change. Rows with work already handed in keep their
 * dates: moving them could hide a submitted assignment or contradict its late
 * flag. Passing `ids` (an admin editing exactly those rows) moves them anyway
 * and re-stamps their late flags. Best-effort: logs and returns on failure,
 * so the save it rides on never fails because of it.
 */
export async function recomputeCourseWeekDates(
  admin: Db,
  scope: { cohortId: string } | { moduleId: string },
  opts: { ids?: string[] } = {},
): Promise<{ moved: number; kept: number }> {
  const result = { moved: 0, kept: 0 };
  try {
    let cohortId: string;
    let moduleWeek: number | null = null;
    if ("moduleId" in scope) {
      const { data: mod } = await admin.from("modules").select("week, cohort_id").eq("id", scope.moduleId).maybeSingle();
      if (!mod?.cohort_id) return result;
      cohortId = mod.cohort_id as string;
      moduleWeek = mod.week as number;
    } else {
      cohortId = scope.cohortId;
    }
    let q = admin
      .from("course_assignments")
      .select("id, week, due_day_offset, due_local_time, opens_at, due_at")
      .eq("cohort_id", cohortId)
      .eq("release_mode", "course_week");
    if ("moduleId" in scope) q = q.eq("module_id", scope.moduleId);
    if (opts.ids) q = q.in("id", opts.ids);
    const [{ data: cohort }, { data: rows, error }] = await Promise.all([
      admin.from("cohorts").select("starts_on, ends_on").eq("id", cohortId).maybeSingle(),
      q,
    ]);
    if (error) {
      fail(error);
      return result;
    }
    if (!cohort?.starts_on || !rows?.length) return result;

    const locked = new Set<string>();
    if (!opts.ids) {
      const { data: subs, error: subErr } = await admin
        .from("course_assignment_submissions")
        .select("assignment_id")
        .in("assignment_id", rows.map((r) => r.id as string))
        .neq("status", "excused");
      if (subErr) {
        fail(subErr);
        return result;
      }
      for (const r of subs ?? []) locked.add(r.assignment_id as string);
    }

    const moved: string[] = [];
    for (const r of rows) {
      const week = moduleWeek ?? (r.week as number);
      const w = courseWeekWindow({
        startsOn: cohort.starts_on as string,
        endsOn: cohort.ends_on as string | null,
        week,
        dueDayOffset: r.due_day_offset as number | null,
        dueLocalTime: r.due_local_time as string | null,
      });
      if (!w) continue;
      if (
        week === r.week &&
        w.dueDayOffset === r.due_day_offset &&
        sameInstant(w.opensAt, r.opens_at as string | null) &&
        sameInstant(w.dueAt, r.due_at as string | null)
      ) {
        continue;
      }
      if (locked.has(r.id as string)) {
        result.kept++;
        continue;
      }
      const { error: upErr } = await admin
        .from("course_assignments")
        .update({ week, opens_at: w.opensAt, due_at: w.dueAt, due_day_offset: w.dueDayOffset })
        .eq("id", r.id);
      if (upErr) {
        console.error("[assignments] recompute failed", r.id, upErr.message);
        continue;
      }
      result.moved++;
      moved.push(r.id as string);
    }
    if (opts.ids && moved.length) await restampLate(admin, moved);
  } catch (err) {
    fail(err);
  }
  return result;
}

/** late = handed in after the deadline. Re-stamped when a deadline moves. */
export async function restampLate(admin: Db, assignmentIds: string[]): Promise<void> {
  if (assignmentIds.length === 0) return;
  const [{ data: rows, error }, { data: subs, error: subErr }] = await Promise.all([
    admin.from("course_assignments").select("id, due_at").in("id", assignmentIds),
    admin
      .from("course_assignment_submissions")
      .select("id, assignment_id, submitted_at, late")
      .in("assignment_id", assignmentIds)
      .not("submitted_at", "is", null),
  ]);
  if (error || subErr) {
    fail(error ?? subErr);
    return;
  }
  const dueAt = new Map((rows ?? []).map((r) => [r.id as string, r.due_at as string | null]));
  const flip: Record<"late" | "onTime", string[]> = { late: [], onTime: [] };
  for (const s of subs ?? []) {
    const due = dueAt.get(s.assignment_id as string);
    const late = !!due && Date.parse(s.submitted_at as string) > Date.parse(due);
    if (late !== !!s.late) flip[late ? "late" : "onTime"].push(s.id as string);
  }
  for (const [key, ids] of Object.entries(flip)) {
    if (ids.length === 0) continue;
    const { error: upErr } = await admin
      .from("course_assignment_submissions")
      .update({ late: key === "late" })
      .in("id", ids);
    if (upErr) console.error("[assignments] late re-stamp failed", upErr.message);
  }
}
