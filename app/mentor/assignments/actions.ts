"use server";
import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireActor } from "@/lib/server-guards";
import { can } from "@/lib/permissions";
import { assertMentorCanAccessStudent } from "@/lib/mentor-scope";
import { runAction, type ActionResult } from "@/lib/action-result";
import { notify } from "@/lib/notifications";
import { logAudit } from "@/lib/audit";
import { LIMITS } from "@/lib/assignments";

/**
 * Sign off a submission, or send it back for changes. Admins holding
 * `assignments.manage` review anyone's work; mentors (`mentor.panel`) only
 * students in their scope — the same rule as lib/mentor-scope.ts.
 */
export async function reviewSubmission(input: {
  submissionId: string;
  feedback: string;
  outcome: "reviewed" | "returned";
}): Promise<ActionResult> {
  return runAction({ name: "reviewSubmission" }, async () => {
    const actor = await requireActor();
    const manager = can(actor.caps, "assignments.manage");
    if (!manager && !can(actor.caps, "mentor.panel")) throw new Error("Forbidden");
    if (input.outcome !== "reviewed" && input.outcome !== "returned") throw new Error("Pick an outcome.");
    const feedback = (input.feedback ?? "").trim();
    if (feedback.length > LIMITS.feedback) throw new Error(`Keep feedback under ${LIMITS.feedback} characters.`);
    if (input.outcome === "returned" && !feedback) throw new Error("Say what to change.");

    const admin = createAdminClient();
    const { data: sub } = await admin
      .from("course_assignment_submissions")
      .select("id, user_id, status, assignment:course_assignments(id, title)")
      .eq("id", input.submissionId)
      .maybeSingle();
    if (!sub) throw new Error("Submission not found.");
    if (!manager) {
      await assertMentorCanAccessStudent({ callerId: actor.userId, caps: actor.caps, studentId: sub.user_id });
    }
    if (sub.status === "excused") throw new Error("Excused — nothing to review.");

    const { error } = await admin
      .from("course_assignment_submissions")
      .update({
        status: input.outcome,
        feedback: feedback || null,
        reviewed_by: actor.userId,
        reviewed_at: new Date().toISOString(),
      })
      .eq("id", sub.id);
    if (error) throw new Error("Couldn't save the review.");

    const a = (Array.isArray(sub.assignment) ? sub.assignment[0] : sub.assignment) as { id: string; title: string } | null;
    await notify({
      userId: sub.user_id,
      type: input.outcome === "returned" ? "assignment_returned" : "assignment_reviewed",
      title: input.outcome === "returned" ? `Changes requested: ${a?.title ?? "assignment"}` : `Reviewed: ${a?.title ?? "assignment"}`,
      body: feedback ? feedback.slice(0, 200) : null,
      link: a ? `/dashboard/assignments/${a.id}` : "/dashboard/assignments",
    });
    await logAudit({
      action: `assignment.${input.outcome}`,
      targetType: "assignment_submission",
      targetId: sub.id,
      payload: { student_id: sub.user_id, assignment_id: a?.id ?? null },
    });

    revalidatePath("/mentor/assignments");
    revalidatePath("/admin/assignments");
  });
}
