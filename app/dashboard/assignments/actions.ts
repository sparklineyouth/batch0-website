"use server";
import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireActor } from "@/lib/server-guards";
import { runAction, type ActionResult } from "@/lib/action-result";
import { checkRateLimit } from "@/lib/rate-limit";
import { notifyMany } from "@/lib/notifications";
import { cohortHasStarted, todayISO } from "@/lib/pre-cohort";
import { isMissingSchemaError } from "@/lib/schema-ready";
import { canEditSubmission, validateSubmission, type SubmissionType } from "@/lib/assignments";

const NOT_READY = "Assignments aren't set up yet.";

/**
 * Hand in (or edit) an assignment. Shared by /dashboard/assignments and the
 * installed app. Everything is re-checked here: the assignment is published
 * and open, the student is enrolled in its cohort (and targeted, for a
 * students-only assignment), the cohort has started, and the work fits its
 * submission type. Late work is accepted and flagged.
 */
export async function submitAssignment(input: {
  assignmentId: string;
  body?: string | null;
  linkUrl?: string | null;
}): Promise<ActionResult> {
  return runAction({ name: "submitAssignment" }, async () => {
    const { userId } = await requireActor();
    const rl = await checkRateLimit({
      kind: "assignment-submit",
      identifier: userId,
      limit: 30,
      windowSeconds: 3600,
    });
    if (!rl.ok) throw new Error("Too many saves. Try again in a bit.");

    const admin = createAdminClient();
    const { data: a, error } = await admin
      .from("course_assignments")
      .select("id, cohort_id, title, audience, opens_at, due_at, submission_type, status")
      .eq("id", input.assignmentId)
      .maybeSingle();
    if (error) throw new Error(isMissingSchemaError(error) ? NOT_READY : "Couldn't load that assignment.");
    const now = new Date();
    if (!a || a.status !== "published" || (a.opens_at && Date.parse(a.opens_at) > now.getTime())) {
      throw new Error("That assignment isn't open.");
    }

    const [{ data: enrollment }, { data: cohort }, target, { data: existing }] = await Promise.all([
      admin
        .from("enrollments")
        .select("enrolled_at")
        .eq("user_id", userId)
        .eq("cohort_id", a.cohort_id)
        .maybeSingle(),
      admin.from("cohorts").select("starts_on, status").eq("id", a.cohort_id).maybeSingle(),
      a.audience === "students"
        ? admin
            .from("course_assignment_targets")
            .select("user_id")
            .eq("assignment_id", a.id)
            .eq("user_id", userId)
            .maybeSingle()
        : Promise.resolve({ data: { user_id: userId } }),
      admin
        .from("course_assignment_submissions")
        .select("id, status")
        .eq("assignment_id", a.id)
        .eq("user_id", userId)
        .maybeSingle(),
    ]);
    if (!enrollment || !target.data) throw new Error("This assignment isn't for you.");
    if (!cohort || !cohortHasStarted(cohort, todayISO())) {
      throw new Error("Assignments open when your cohort starts.");
    }
    if (existing && !canEditSubmission(existing.status)) {
      throw new Error(existing.status === "excused" ? "You're excused from this one." : "Already reviewed.");
    }

    const checked = validateSubmission({
      type: a.submission_type as SubmissionType,
      body: input.body,
      link: input.linkUrl,
    });
    if (!checked.ok) throw new Error(checked.error);

    const { error: saveErr } = await admin.from("course_assignment_submissions").upsert(
      {
        assignment_id: a.id,
        user_id: userId,
        body: checked.body,
        link_url: checked.link,
        status: "submitted",
        submitted_at: now.toISOString(),
        late: !!a.due_at && now.getTime() > Date.parse(a.due_at),
      },
      { onConflict: "assignment_id,user_id" },
    );
    if (saveErr) throw new Error("Couldn't save. Try again.");

    // New work (or a resubmission after "needs changes") goes to the student's
    // own mentors — not to all staff. Edits to work already waiting don't.
    if (!existing || existing.status === "returned") {
      const [{ data: mentors }, { data: me }] = await Promise.all([
        admin.from("mentor_assignments").select("mentor_id").eq("student_id", userId),
        admin.from("profiles").select("full_name, email").eq("id", userId).maybeSingle(),
      ]);
      const who = me?.full_name || me?.email || "A student";
      await notifyMany(
        [...new Set((mentors ?? []).map((m) => m.mentor_id as string))].map((mentorId) => ({
          userId: mentorId,
          type: "assignment_submitted",
          title: `${who} submitted ${a.title}`,
          link: "/mentor/assignments",
        })),
      );
    }

    revalidatePath("/dashboard/assignments");
    revalidatePath("/app/assignments");
    revalidatePath("/mentor/assignments");
    revalidatePath("/admin/assignments");
  });
}
