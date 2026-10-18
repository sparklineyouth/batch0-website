"use server";
import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { assertPermission } from "@/lib/server-guards";
import { refuse, runAction, type ActionResult } from "@/lib/action-result";
import { logAudit } from "@/lib/audit";
import { isMissingSchemaError } from "@/lib/schema-ready";
import {
  ASSIGNMENT_COLUMNS,
  SUBMISSION_COLUMNS,
  notifyReleased,
  recomputeCourseWeekDates,
  restampLate,
  type AssignmentRow,
  type SubmissionRow,
} from "@/lib/assignments-server";
import {
  deriveStatus,
  normalizeDraft,
  sameInstant,
  seriesWeeks,
  type AssignmentStatus,
  type Audience,
  type DerivedStatus,
  type ReleaseMode,
  type SubmissionType,
} from "@/lib/assignments";

const NOT_READY = "Assignments aren't set up yet.";

function dbError(error: unknown, fallback: string): Error {
  return new Error(isMissingSchemaError(error) ? NOT_READY : fallback);
}

function revalidate() {
  revalidatePath("/admin/assignments");
  revalidatePath("/dashboard/assignments");
  revalidatePath("/app/assignments");
  revalidatePath("/mentor/assignments");
}

export type AssignmentInput = {
  id?: string;
  cohortId: string;
  title: string;
  instructions: string;
  release: ReleaseMode;
  opensDate?: string | null;
  opensTime?: string | null;
  dueDate?: string | null;
  dueTime?: string | null;
  week?: number | null;
  dueDayOffset?: number | null;
  dueLocalTime?: string | null;
  lessonId?: string | null;
  submissionType: SubmissionType;
  audience: Audience;
  studentIds?: string[];
  status: AssignmentStatus;
  /** Create + course week only: also create weeks week+1..this. */
  repeatThroughWeek?: number | null;
  /** Edit only: copy the content and due rule to later weeks of the series. */
  applyToSeries?: boolean;
};

/** Create (optionally a weekly series) or edit one assignment. */
export async function saveAssignment(input: AssignmentInput): Promise<ActionResult<{ id: string }>> {
  return runAction({ name: "saveAssignment" }, async () => {
    const { userId } = await assertPermission("assignments.manage");
    const admin = createAdminClient();

    let existing: AssignmentRow | null = null;
    if (input.id) {
      const { data, error } = await admin.from("course_assignments").select(ASSIGNMENT_COLUMNS).eq("id", input.id).maybeSingle();
      if (error) throw dbError(error, "Couldn't load that assignment.");
      if (!data) throw new Error("Assignment not found.");
      existing = data as AssignmentRow;
      if (existing.cohort_id !== input.cohortId) throw new Error("An assignment can't move to another cohort.");
    }

    const { data: cohort } = await admin
      .from("cohorts")
      .select("id, starts_on, ends_on")
      .eq("id", input.cohortId)
      .maybeSingle();
    if (!cohort) throw new Error("Pick a cohort.");

    // Optional lesson anchor: it must be in this cohort's course, and a
    // course-week assignment then follows that lesson's module week.
    let moduleId: string | null = null;
    let week = input.week ?? null;
    if (input.lessonId) {
      const { data: lesson } = await admin
        .from("lessons")
        .select("id, module:modules(id, week, cohort_id)")
        .eq("id", input.lessonId)
        .maybeSingle();
      const mod = lesson ? ((Array.isArray(lesson.module) ? lesson.module[0] : lesson.module) as any) : null;
      if (!mod || mod.cohort_id !== cohort.id) throw new Error("That lesson isn't in this cohort's course.");
      moduleId = mod.id;
      if (input.release === "course_week") week = mod.week;
    }

    const keepOpensAt = existing?.release_mode === "now" && input.release === "now" && existing.opens_at;
    const draft = normalizeDraft(
      {
        title: input.title,
        instructions: input.instructions,
        release: input.release,
        opensDate: input.opensDate,
        opensTime: input.opensTime,
        dueDate: input.dueDate,
        dueTime: input.dueTime,
        week,
        dueDayOffset: input.dueDayOffset,
        dueLocalTime: input.dueLocalTime,
        submissionType: input.submissionType,
        audience: input.audience,
        status: input.status,
      },
      {
        startsOn: cohort.starts_on,
        endsOn: cohort.ends_on,
        now: keepOpensAt ? new Date(existing!.opens_at!) : new Date(),
      },
    );
    if (!draft.ok) throw new Error(draft.error);
    const d = draft.value;

    let studentIds: string[] = [];
    if (d.audience === "students") {
      studentIds = [...new Set((input.studentIds ?? []).filter((v) => typeof v === "string"))];
      if (studentIds.length === 0) throw new Error("Pick at least one student.");
      const { data: enrolled } = await admin
        .from("enrollments")
        .select("user_id")
        .eq("cohort_id", cohort.id)
        .in("user_id", studentIds);
      if ((enrolled ?? []).length !== studentIds.length) throw new Error("Every student must be enrolled in this cohort.");
    }

    let weeks: (number | null)[] = [d.week];
    if (!existing && d.release === "course_week" && input.repeatThroughWeek && input.repeatThroughWeek > d.week!) {
      if (input.lessonId) throw new Error("A weekly series can't be tied to one lesson.");
      weeks = seriesWeeks(d.week!, Number(input.repeatThroughWeek));
      if (weeks.length === 0) throw new Error("Pick a valid last week.");
    }

    const base = {
      cohort_id: cohort.id,
      module_id: moduleId,
      lesson_id: input.lessonId || null,
      title: d.title,
      instructions: d.instructions,
      audience: d.audience,
      release_mode: d.release,
      due_day_offset: d.dueDayOffset,
      due_local_time: d.dueLocalTime,
      submission_type: d.submissionType,
      status: d.status,
    };

    let saved: AssignmentRow[] = [];
    if (existing) {
      const { data, error } = await admin
        .from("course_assignments")
        .update({ ...base, week: d.week, opens_at: d.opensAt, due_at: d.dueAt })
        .eq("id", existing.id)
        .select(ASSIGNMENT_COLUMNS);
      if (error) throw dbError(error, "Couldn't save.");
      saved = (data ?? []) as AssignmentRow[];
      if (!sameInstant(existing.due_at, d.dueAt)) await restampLate(admin, [existing.id]);
      // Targets follow the audience: replaced wholesale, cleared for a cohort-wide one.
      const { error: delErr } = await admin.from("course_assignment_targets").delete().eq("assignment_id", existing.id);
      if (delErr) throw dbError(delErr, "Couldn't save the student list.");
      if (studentIds.length) {
        const { error: tErr } = await admin
          .from("course_assignment_targets")
          .insert(studentIds.map((user_id) => ({ assignment_id: existing!.id, user_id })));
        if (tErr) throw dbError(tErr, "Couldn't save the student list.");
      }
      if (input.applyToSeries && existing.series_id && d.release === "course_week") {
        const { data: later, error: sErr } = await admin
          .from("course_assignments")
          .update({
            title: d.title,
            instructions: d.instructions,
            submission_type: d.submissionType,
            status: d.status,
            due_day_offset: d.dueDayOffset,
            due_local_time: d.dueLocalTime,
          })
          .eq("series_id", existing.series_id)
          .eq("release_mode", "course_week")
          .gt("week", d.week!)
          .select(ASSIGNMENT_COLUMNS);
        if (sErr) throw dbError(sErr, "Couldn't update the rest of the series.");
        // The admin asked for these rows, so they move even with work handed in.
        await recomputeCourseWeekDates(admin, { cohortId: cohort.id }, { ids: (later ?? []).map((r) => r.id as string) });
        saved = saved.concat((later ?? []) as AssignmentRow[]);
      }
    } else {
      const seriesId = weeks.length > 1 ? randomUUID() : null;
      const rows = weeks.map((w) => {
        // Each week of a series gets its own window from the same rule.
        const win =
          d.release === "course_week" && w !== d.week
            ? normalizeDraft(
                { ...input, week: w, release: "course_week", title: d.title, instructions: d.instructions },
                { startsOn: cohort.starts_on, endsOn: cohort.ends_on },
              )
            : draft;
        if (!win.ok) throw new Error(win.error);
        return {
          ...base,
          series_id: seriesId,
          week: w,
          opens_at: win.value.opensAt,
          due_at: win.value.dueAt,
          // The last week can end early (cohort end date), so per row.
          due_day_offset: win.value.dueDayOffset,
          created_by: userId,
        };
      });
      const { data, error } = await admin.from("course_assignments").insert(rows).select(ASSIGNMENT_COLUMNS);
      if (error) throw dbError(error, "Couldn't save.");
      saved = (data ?? []) as AssignmentRow[];
      if (studentIds.length) {
        const { error: tErr } = await admin
          .from("course_assignment_targets")
          .insert(saved.flatMap((a) => studentIds.map((user_id) => ({ assignment_id: a.id, user_id }))));
        if (tErr) throw dbError(tErr, "Couldn't save the student list.");
      }
    }

    // Anything already open goes out now; the hourly cron picks up the rest
    // when they open. Deduped per assignment, so an edit never re-notifies.
    const now = Date.now();
    for (const a of saved) {
      if (a.status === "published" && (!a.opens_at || Date.parse(a.opens_at) <= now)) {
        await notifyReleased(admin, a);
      }
    }

    const first = saved[0];
    if (!first) throw new Error("Couldn't save.");
    await logAudit({
      action: existing ? "assignment.updated" : "assignment.created",
      targetType: "assignment",
      targetId: first.id,
      payload: { title: d.title, cohort_id: cohort.id, weeks: weeks.filter(Boolean), status: d.status },
    });
    revalidate();
    return { id: first.id };
  });
}

/** Delete an assignment nobody has handed in. Otherwise archive it. */
export async function deleteAssignment(id: string): Promise<ActionResult> {
  return runAction({ name: "deleteAssignment" }, async () => {
    await assertPermission("assignments.manage");
    const admin = createAdminClient();
    const { count, error } = await admin
      .from("course_assignment_submissions")
      .select("id", { count: "exact", head: true })
      .eq("assignment_id", id)
      .neq("status", "excused");
    if (error) throw dbError(error, "Couldn't check submissions.");
    if ((count ?? 0) > 0) throw new Error("Students have handed this in. Archive it instead.");
    const { data, error: delErr } = await admin.from("course_assignments").delete().eq("id", id).select("title");
    if (delErr) throw dbError(delErr, "Couldn't delete.");
    if (!data?.length) throw new Error("Assignment not found.");
    await logAudit({ action: "assignment.deleted", targetType: "assignment", targetId: id, payload: { title: data[0].title } });
    revalidate();
  });
}

/** Excuse one student from one assignment, or undo it. */
export async function setExcused(input: {
  assignmentId: string;
  userId: string;
  excused: boolean;
}): Promise<ActionResult> {
  return runAction({ name: "setExcused" }, async () => {
    await assertPermission("assignments.manage");
    const admin = createAdminClient();
    const { data: a, error } = await admin
      .from("course_assignments")
      .select("id, cohort_id")
      .eq("id", input.assignmentId)
      .maybeSingle();
    if (error) throw dbError(error, "Couldn't load that assignment.");
    if (!a) throw new Error("Assignment not found.");
    const [{ data: enrolled }, { data: sub }] = await Promise.all([
      admin.from("enrollments").select("user_id").eq("cohort_id", a.cohort_id).eq("user_id", input.userId).maybeSingle(),
      admin
        .from("course_assignment_submissions")
        .select("id, status, body, link_url")
        .eq("assignment_id", a.id)
        .eq("user_id", input.userId)
        .maybeSingle(),
    ]);
    if (!enrolled) throw new Error("That student isn't in this cohort.");

    let res;
    if (input.excused) {
      res = sub
        ? await admin.from("course_assignment_submissions").update({ status: "excused" }).eq("id", sub.id)
        : await admin
            .from("course_assignment_submissions")
            .insert({ assignment_id: a.id, user_id: input.userId, status: "excused" });
    } else if (sub?.status === "excused") {
      res =
        sub.body || sub.link_url
          ? await admin.from("course_assignment_submissions").update({ status: "submitted" }).eq("id", sub.id)
          : await admin.from("course_assignment_submissions").delete().eq("id", sub.id);
    }
    if (res?.error) throw dbError(res.error, "Couldn't save.");
    await logAudit({
      action: input.excused ? "assignment.excused" : "assignment.unexcused",
      targetType: "assignment",
      targetId: a.id,
      payload: { student_id: input.userId },
    });
    revalidate();
  });
}

export type ReviewCell = {
  student: { id: string; name: string | null; email: string | null };
  assignment: { id: string; title: string; week: number | null; due_at: string | null };
  submission: SubmissionRow | null;
  status: DerivedStatus;
  /**
   * False when the student has left this assignment's cohort (moved, or
   * removed from the program) after handing the work in. It still waits for
   * feedback — the review queues count it — so the drawer shows and reviews
   * it; only excusing, a matter for the cohort, is off.
   */
  enrolled: boolean;
};

/** What the review drawer shows for one matrix cell. */
export async function loadReviewCell(input: {
  assignmentId: string;
  userId: string;
}): Promise<ActionResult<ReviewCell>> {
  return runAction({ name: "loadReviewCell" }, async () => {
    await assertPermission("assignments.manage");
    const admin = createAdminClient();
    const { data: a, error } = await admin
      .from("course_assignments")
      .select("id, cohort_id, title, week, opens_at, due_at")
      .eq("id", input.assignmentId)
      .maybeSingle();
    if (error) throw dbError(error, "Couldn't load that assignment.");
    if (!a) refuse("Assignment not found.");
    const [
      { data: enrollment, error: enrollmentError },
      { data: profile, error: profileError },
      { data: sub, error: subError },
    ] = await Promise.all([
      admin.from("enrollments").select("enrolled_at").eq("cohort_id", a.cohort_id).eq("user_id", input.userId).maybeSingle(),
      admin.from("profiles").select("id, full_name, email").eq("id", input.userId).maybeSingle(),
      admin
        .from("course_assignment_submissions")
        .select(SUBMISSION_COLUMNS)
        .eq("assignment_id", a.id)
        .eq("user_id", input.userId)
        .maybeSingle(),
    ]);
    // A failed read is "couldn't load", never an answer. These errors used
    // to be dropped, so a timeout on any of the three read as no enrollment
    // and no work, and the drawer said the student "isn't in this cohort".
    const readError = enrollmentError ?? profileError ?? subError;
    if (readError) throw dbError(readError, "Couldn't load this student's work just now. Close the drawer and try again.");
    const submission = (sub ?? null) as SubmissionRow | null;
    // Handed-in work outlives the enrollment it was handed in under: the
    // Overview's "Waiting for feedback" rows link here for it, and refusing
    // would leave it waiting with no way to clear it.
    if (!profile || (!enrollment && !submission)) refuse("That student isn't in this cohort.");
    return {
      student: { id: profile.id, name: profile.full_name, email: profile.email },
      assignment: { id: a.id, title: a.title, week: a.week, due_at: a.due_at },
      submission,
      status: deriveStatus({ opensAt: a.opens_at, dueAt: a.due_at, enrolledAt: enrollment?.enrolled_at ?? null, submission }),
      enrolled: !!enrollment,
    };
  });
}
