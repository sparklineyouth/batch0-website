import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Where a student actually is, across everything they can make progress on.
 *
 * The program's progress signals are spread over five tables that nobody
 * looks at together: `lesson_progress` (watched seconds + completion),
 * `flow_progress` (which carries `current_step` — literally the step they're
 * sitting on), `resource_views` (added in 0053), `challenge_submissions` and
 * `course_assignment_submissions` (0093). Answering "where did they stop?"
 * meant joining those by hand, so in practice nobody did.
 *
 * The headline this module exists to produce is `stoppedAt`: the single most
 * recent thing a student touched, named in words. Everything else on the
 * shape is the supporting detail for a per-student view.
 *
 * The event shapes and the ranking live in lib/progress-events.ts, apart
 * from the queries, so both views build them the same way and the rules are
 * tested without a database.
 */

import {
  assignmentEvent,
  challengeEvent,
  formatWatched,
  pickStoppedAt,
  sortRecent,
  type ProgressEvent,
} from "./progress-events";

export {
  formatWatched,
  pickStoppedAt,
  sortRecent,
  type ProgressArea,
  type ProgressEvent,
} from "./progress-events";

export type AreaProgress = {
  done: number;
  total: number;
  /** Started but not finished. */
  inProgress: number;
};

export type StudentProgress = {
  userId: string;
  course: AreaProgress;
  flows: AreaProgress;
  resources: AreaProgress;
  challenges: number;
  assignments: number;
  /**
   * The most recent thing they touched. Null means they have never done
   * anything at all, which is itself the answer worth surfacing.
   */
  stoppedAt: ProgressEvent | null;
  /** Most recent first, for a per-student timeline. */
  recent: ProgressEvent[];
  /** Days since `stoppedAt`, or null if they've never started. */
  idleDays: number | null;
};

const DAY_MS = 24 * 60 * 60 * 1000;

function daysSince(iso: string): number {
  return Math.floor((Date.now() - new Date(iso).getTime()) / DAY_MS);
}

/**
 * Build the progress picture for one student. A failed read counts as no
 * activity rather than failing the page.
 */
export async function getStudentProgress(
  userId: string,
): Promise<StudentProgress> {
  const admin = createAdminClient();

  const [
    lessonsRes,
    lessonProgressRes,
    flowsRes,
    flowProgressRes,
    resourcesRes,
    resourceViewsRes,
    challengesRes,
    assignmentsRes,
  ] = await Promise.all([
    admin.from("lessons").select("id, title, module_id"),
    admin
      .from("lesson_progress")
      .select("lesson_id, watched_seconds, completed_at, updated_at")
      .eq("user_id", userId),
    admin.from("flows").select("id, title, slug, status"),
    admin
      .from("flow_progress")
      .select("flow_id, current_step, completed_at, updated_at")
      .eq("user_id", userId),
    admin.from("resources").select("id, title"),
    admin
      .from("resource_views")
      .select("resource_id, last_viewed_at, view_count")
      .eq("user_id", userId),
    admin
      .from("challenge_submissions")
      .select("id, challenge_id, created_at, submitted_at, challenge:challenges(title)")
      .eq("user_id", userId)
      // An autosaved draft isn't activity worth reporting.
      .neq("status", "draft"),
    admin
      .from("course_assignment_submissions")
      .select("id, status, submitted_at, updated_at, assignment:course_assignments(title)")
      .eq("user_id", userId)
      // Excused rows are a staff decision, not something the student did.
      .neq("status", "excused"),
  ]);

  const events: ProgressEvent[] = [];

  // ---- Course -------------------------------------------------------------
  const lessonTitle = new Map(
    (lessonsRes.data ?? []).map((l: any) => [l.id, l.title as string]),
  );
  const lessonRows = (lessonProgressRes.data ?? []) as any[];
  let courseDone = 0;
  let courseStarted = 0;
  for (const r of lessonRows) {
    const complete = Boolean(r.completed_at);
    if (complete) courseDone++;
    else if ((r.watched_seconds ?? 0) > 0) courseStarted++;
    events.push({
      area: "course",
      label: lessonTitle.get(r.lesson_id) ?? "a lesson",
      detail: complete
        ? "completed"
        : formatWatched(r.watched_seconds ?? 0),
      at: r.completed_at ?? r.updated_at,
      complete,
      href: "/admin/course",
    });
  }

  // ---- Flows --------------------------------------------------------------
  const flowById = new Map(
    (flowsRes.data ?? []).map((f: any) => [f.id, f]),
  );
  const flowRows = (flowProgressRes.data ?? []) as any[];
  let flowsDone = 0;
  let flowsStarted = 0;
  for (const r of flowRows) {
    const complete = Boolean(r.completed_at);
    if (complete) flowsDone++;
    else flowsStarted++;
    const flow = flowById.get(r.flow_id);
    events.push({
      area: "flow",
      label: flow?.title ?? "a pre-cohort flow",
      // `current_step` is the whole reason this is the best "where did they
      // stop" signal in the system — it's the exact step they're parked on.
      detail: complete
        ? "completed"
        : r.current_step
          ? `stopped on “${r.current_step}”`
          : "started",
      at: r.completed_at ?? r.updated_at,
      complete,
      href: flow ? `/admin/flows/${flow.id}` : undefined,
    });
  }

  // ---- Resources ----------------------------------------------------------
  const resourceTitle = new Map(
    (resourcesRes.data ?? []).map((r: any) => [r.id, r.title as string]),
  );
  const viewRows = (resourceViewsRes.data ?? []) as any[];
  for (const r of viewRows) {
    events.push({
      area: "resource",
      label: resourceTitle.get(r.resource_id) ?? "a resource",
      detail:
        (r.view_count ?? 1) > 1 ? `opened ${r.view_count}x` : "opened",
      at: r.last_viewed_at,
      // Opening a resource has no "finished" state — a download either
      // happened or it didn't — so it always counts as a completed touch.
      complete: true,
      href: "/admin/resources",
    });
  }

  // ---- Submissions --------------------------------------------------------
  const challengeRows = (challengesRes.data ?? []) as any[];
  for (const r of challengeRows) events.push(challengeEvent(r));

  let assignments = 0;
  for (const r of (assignmentsRes.data ?? []) as any[]) {
    const e = assignmentEvent(r);
    if (!e) continue;
    assignments++;
    events.push(e);
  }

  const stoppedAt = pickStoppedAt(events);

  return {
    userId,
    course: {
      done: courseDone,
      total: (lessonsRes.data ?? []).length,
      inProgress: courseStarted,
    },
    flows: {
      done: flowsDone,
      total: (flowsRes.data ?? []).filter((f: any) => f.status === "published")
        .length,
      inProgress: flowsStarted,
    },
    resources: {
      done: viewRows.length,
      total: (resourcesRes.data ?? []).length,
      inProgress: 0,
    },
    challenges: challengeRows.length,
    assignments,
    stoppedAt,
    recent: sortRecent(events),
    idleDays: stoppedAt ? daysSince(stoppedAt.at) : null,
  };
}

// ---------------------------------------------------------------------------
// Roster view
// ---------------------------------------------------------------------------

export type RosterProgress = {
  userId: string;
  name: string | null;
  email: string;
  stoppedAt: ProgressEvent | null;
  idleDays: number | null;
  lessonsDone: number;
  flowsDone: number;
  resourcesOpened: number;
  /** Assignments handed in (excused ones don't count). */
  assignmentsDone: number;
};

/**
 * The same picture for a whole cohort, in a bounded number of queries.
 *
 * Deliberately NOT `getStudentProgress` in a loop — that's eight queries per
 * student, so a 40-person cohort would be 320 round trips to render one table.
 * Each source table is read once for the whole roster and grouped in memory.
 * It reads the same sources as the per-student view, so a student who only
 * handed in assignments isn't listed as never started. A failed read (before
 * 0093, course_assignment_submissions doesn't exist) counts as no activity.
 */
export async function getRosterProgress(
  userIds: string[],
): Promise<RosterProgress[]> {
  if (userIds.length === 0) return [];
  const admin = createAdminClient();

  const [
    profiles,
    lessons,
    lessonProgress,
    flows,
    flowProgress,
    resources,
    views,
    challengeSubs,
    assignmentSubs,
  ] = await Promise.all([
      admin.from("profiles").select("id, full_name, email").in("id", userIds),
      admin.from("lessons").select("id, title"),
      admin
        .from("lesson_progress")
        .select("user_id, lesson_id, watched_seconds, completed_at, updated_at")
        .in("user_id", userIds),
      admin.from("flows").select("id, title"),
      admin
        .from("flow_progress")
        .select("user_id, flow_id, current_step, completed_at, updated_at")
        .in("user_id", userIds),
      admin.from("resources").select("id, title"),
      admin
        .from("resource_views")
        .select("user_id, resource_id, last_viewed_at, view_count")
        .in("user_id", userIds),
      admin
        .from("challenge_submissions")
        .select("user_id, created_at, submitted_at, challenge:challenges(title)")
        .in("user_id", userIds)
        .neq("status", "draft"),
      admin
        .from("course_assignment_submissions")
        .select("user_id, status, submitted_at, updated_at, assignment:course_assignments(title)")
        .in("user_id", userIds)
        .neq("status", "excused"),
    ]);

  const lessonTitle = new Map(
    (lessons.data ?? []).map((l: any) => [l.id, l.title as string]),
  );
  const flowTitle = new Map(
    (flows.data ?? []).map((f: any) => [f.id, f.title as string]),
  );
  const resourceTitle = new Map(
    (resources.data ?? []).map((r: any) => [r.id, r.title as string]),
  );

  const byUser = new Map<string, ProgressEvent[]>();
  const push = (userId: string, e: ProgressEvent) => {
    const list = byUser.get(userId);
    if (list) list.push(e);
    else byUser.set(userId, [e]);
  };

  for (const r of (lessonProgress.data ?? []) as any[]) {
    const complete = Boolean(r.completed_at);
    push(r.user_id, {
      area: "course",
      label: lessonTitle.get(r.lesson_id) ?? "a lesson",
      detail: complete ? "completed" : formatWatched(r.watched_seconds ?? 0),
      at: r.completed_at ?? r.updated_at,
      complete,
    });
  }
  for (const r of (flowProgress.data ?? []) as any[]) {
    const complete = Boolean(r.completed_at);
    push(r.user_id, {
      area: "flow",
      label: flowTitle.get(r.flow_id) ?? "a flow",
      detail: complete
        ? "completed"
        : r.current_step
          ? `stopped on “${r.current_step}”`
          : "started",
      at: r.completed_at ?? r.updated_at,
      complete,
    });
  }
  for (const r of (views.data ?? []) as any[]) {
    push(r.user_id, {
      area: "resource",
      label: resourceTitle.get(r.resource_id) ?? "a resource",
      detail: (r.view_count ?? 1) > 1 ? `opened ${r.view_count}x` : "opened",
      at: r.last_viewed_at,
      complete: true,
    });
  }

  for (const r of (challengeSubs.data ?? []) as any[]) {
    push(r.user_id, challengeEvent(r));
  }
  const assignmentsDone = new Map<string, number>();
  for (const r of (assignmentSubs.data ?? []) as any[]) {
    const e = assignmentEvent(r);
    if (!e) continue;
    push(r.user_id, e);
    assignmentsDone.set(r.user_id, (assignmentsDone.get(r.user_id) ?? 0) + 1);
  }

  const lessonsDone = new Map<string, number>();
  for (const r of (lessonProgress.data ?? []) as any[]) {
    if (r.completed_at) {
      lessonsDone.set(r.user_id, (lessonsDone.get(r.user_id) ?? 0) + 1);
    }
  }
  const flowsDone = new Map<string, number>();
  for (const r of (flowProgress.data ?? []) as any[]) {
    if (r.completed_at) {
      flowsDone.set(r.user_id, (flowsDone.get(r.user_id) ?? 0) + 1);
    }
  }
  const opened = new Map<string, number>();
  for (const r of (views.data ?? []) as any[]) {
    opened.set(r.user_id, (opened.get(r.user_id) ?? 0) + 1);
  }

  return (profiles.data ?? []).map((p: any) => {
    const stoppedAt = pickStoppedAt(byUser.get(p.id) ?? []);
    return {
      userId: p.id,
      name: p.full_name ?? null,
      email: p.email,
      stoppedAt,
      idleDays: stoppedAt ? daysSince(stoppedAt.at) : null,
      lessonsDone: lessonsDone.get(p.id) ?? 0,
      flowsDone: flowsDone.get(p.id) ?? 0,
      resourcesOpened: opened.get(p.id) ?? 0,
      assignmentsDone: assignmentsDone.get(p.id) ?? 0,
    };
  });
}
