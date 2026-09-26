"use server";
import { revalidatePath } from "next/cache";
import { requireActor } from "@/lib/server-guards";
import { createAdminClient } from "@/lib/supabase/admin";
import { getStudentAccess } from "@/lib/access";
import { logAudit } from "@/lib/audit";
import { notifyMany } from "@/lib/notifications";
import { listInterviewTeamIds } from "@/lib/interview-requests";
import { runAction, type ActionResult } from "@/lib/action-result";
import { callCreditsForUser, loadWindowCohort } from "@/lib/scholarships";
import { callTimeProblem, scholarshipCallWindow } from "@/lib/scholarship-window";

// ---------------------------------------------------------------------------
// Booking a mentor call funded by a learner's scholarship.
//
// Deliberately NOT a variant of requestInterview(). That action is the
// pre-kickoff "getting to know you" interview and carries gates that are right
// for it and wrong here: it refuses once the cohort is underway, which is
// exactly when a learner's-scholarship call is most useful.
//
// What it DOES share is the row: a scholarship call is an ordinary
// interview_requests row with `scholarship_application_id` set (migration
// 0071). That means it lands in the team's existing queue, gets scheduled by
// the existing action, and rides the existing call_invites / Daily plumbing.
// A parallel booking system would have been a second thing to keep working.
//
// THE CREDIT IS NOT SPENT HERE. It's spent when the team actually schedules
// the call — see scheduleInterviewRequest. A student whose request is never
// picked up hasn't used anything, and charging them for it would quietly eat a
// grant they never got the benefit of.
//
// THE CALL BELONGS TO THE AWARD'S COHORT. The grant is extra mentor time for
// the cohort it was awarded in, so a request is refused once that cohort has
// ended, a proposed time after its last day is refused, and the request row is
// stamped with the award's cohort rather than whichever cohort the student is
// tied to today (getStudentAccess picks the soonest upcoming one, which for a
// student already accepted into the next cohort is not the one paying).
// ---------------------------------------------------------------------------

export async function requestScholarshipCall(input: {
  preferredAt: string;
  altAt?: string | null;
  note?: string | null;
}): Promise<ActionResult<{ id: string; remaining: number }>> {
  return runAction({ name: "requestScholarshipCall" }, async () => {
    const actor = await requireActor();

    const access = await getStudentAccess(actor.role);
    if (actor.role !== "student" || access.staff) {
      throw new Error("Only students book scholarship calls.");
    }
    // Mentor time is a cohort thing, so the grant is redeemable from enrolment
    // onward — including during the cohort, unlike the onboarding interview.
    if (!access.enrolled) {
      throw new Error("Scholarship calls open once you're enrolled.");
    }

    const admin = createAdminClient();
    const now = new Date();
    const held = await callCreditsForUser(admin, actor.userId, now);
    if (!held) {
      throw new Error("You don't hold a scholarship that includes mentor calls.");
    }
    // A legacy award with no cohort on file borrows the student's current one
    // rather than going unbounded — see scholarshipCallWindow.
    const cohortId = held.cohortId ?? access.cohortId;
    const callWindow =
      held.cohortId || !cohortId
        ? held.window
        : scholarshipCallWindow(await loadWindowCohort(admin, cohortId), now);
    if (!callWindow.open) {
      throw new Error(callWindow.reason);
    }
    if (held.credits.remaining <= 0) {
      throw new Error(
        `You've used all ${held.credits.granted} of your scholarship calls.`,
      );
    }

    const preferredAt = new Date(input.preferredAt);
    if (Number.isNaN(preferredAt.getTime())) {
      throw new Error("That preferred time isn't valid.");
    }
    if (preferredAt.getTime() < now.getTime()) {
      throw new Error("Pick a time in the future.");
    }
    const preferredProblem = callTimeProblem(preferredAt, callWindow, "preferred");
    if (preferredProblem) throw new Error(preferredProblem);
    let altAt: Date | null = null;
    if (input.altAt) {
      altAt = new Date(input.altAt);
      if (Number.isNaN(altAt.getTime())) {
        throw new Error("That alternate time isn't valid.");
      }
      if (altAt.getTime() < now.getTime()) {
        throw new Error("Your alternate time is in the past.");
      }
      const altProblem = callTimeProblem(altAt, callWindow, "backup");
      if (altProblem) throw new Error(altProblem);
    }

    const { data: created, error } = await admin
      .from("interview_requests")
      .insert({
        student_id: actor.userId,
        cohort_id: cohortId,
        preferred_at: preferredAt.toISOString(),
        alt_at: altAt ? altAt.toISOString() : null,
        note: input.note?.trim() || null,
        status: "requested",
        scholarship_application_id: held.applicationId,
      })
      .select("id")
      .single();

    if (error) {
      // interview_requests_one_open_per_student (0061). Kept rather than
      // worked around: a student with three credits still books them one at a
      // time, and stacking three open asks on the team would just mean three
      // calls nobody has scheduled.
      if (error.code === "23505") {
        throw new Error(
          "You've already got a call request waiting. Once the team books it, you can ask for the next one.",
        );
      }
      if (/scholarship_application_id/i.test(error.message)) {
        throw new Error("Scholarship calls aren't switched on yet.");
      }
      throw new Error(error.message);
    }

    const id = created!.id;

    await logAudit({
      action: "scholarship_call.requested",
      targetType: "interview_request",
      targetId: id,
      payload: {
        scholarship_application_id: held.applicationId,
        preferred_at: preferredAt.toISOString(),
      },
    });

    try {
      const { data: me } = await admin
        .from("profiles")
        .select("full_name")
        .eq("id", actor.userId)
        .maybeSingle();
      const name = (me as any)?.full_name || "A student";
      const teamIds = await listInterviewTeamIds();
      await notifyMany(
        teamIds
          .filter((uid) => uid !== actor.userId)
          .map((uid) => ({
            userId: uid,
            type: "scholarship_call_requested",
            title: `${name} is booking a ${held.scholarshipName} call`,
            body:
              input.note?.trim() ||
              `Scholarship-funded — ${held.credits.remaining} of ${held.credits.granted} left. Schedule it from 1:1 calls.`,
            link: "/admin/calls",
            dedupeKey: `scholarship_call_requested:${id}:${uid}`,
          })),
      );
    } catch (err) {
      console.error("[scholarship-call] request notify failed", err);
    }

    revalidatePath("/dashboard/calls");
    revalidatePath("/dashboard/scholarships");
    revalidatePath("/admin/calls");

    return { id, remaining: held.credits.remaining };
  });
}
