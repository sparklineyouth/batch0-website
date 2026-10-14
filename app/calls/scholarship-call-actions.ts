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

/**
 * Ask for a mentor call funded by a learner's scholarship: an ordinary
 * "Request a 1:1" row with `scholarship_application_id` set (migration 0071),
 * so it lands in the same queue and is booked by scheduleInterviewRequest.
 * The credit is spent when the team books it, not here. The calls belong to
 * the award's cohort: refused once it has ended, and times after its last day
 * are refused.
 */
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
    if (!access.enrolled) {
      throw new Error("Scholarship calls open once you're enrolled.");
    }

    const admin = createAdminClient();
    const now = new Date();
    const held = await callCreditsForUser(admin, actor.userId, now);
    if (!held) {
      throw new Error("You don't hold a scholarship that includes mentor calls.");
    }
    // A legacy award with no cohort borrows the student's current one.
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
      throw new Error("Pick a time that works for you.");
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
        throw new Error("That backup time isn't valid.");
      }
      if (altAt.getTime() < now.getTime()) {
        throw new Error("Your backup time is in the past.");
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
      // interview_requests_one_open_per_student (0061): one ask at a time.
      if (error.code === "23505") {
        throw new Error("You already have a request waiting. Withdraw it to ask again.");
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
            title: `${name} asked for a ${held.scholarshipName} call`,
            body:
              input.note?.trim() ||
              `Scholarship call · ${held.credits.remaining} of ${held.credits.granted} left. Book it from 1:1 calls.`,
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
