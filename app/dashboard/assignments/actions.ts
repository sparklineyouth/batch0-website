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
import { submitConflict, type DraftRow, type SubmitOutcome } from "@/lib/assignment-drafts";

const NOT_READY = "Assignments aren't set up yet.";

/**
 * Hand in (or edit) an assignment. Shared by /dashboard/assignments and the
 * installed app. Everything is re-checked here: the assignment is published
 * and open, the student is enrolled in its cohort (and targeted, for a
 * students-only assignment), the cohort has started, and the work fits its
 * submission type. Late work is accepted and flagged.
 *
 * `draftVersion` is the version of the private draft (0105) the form's text
 * was last saved as or opened with; null when autosave isn't running in that
 * tab (before 0105, or the draft couldn't be read), which skips everything
 * below about drafts. If the draft has moved past it — newer text saved, or
 * another submit, from another tab or device — handing this text in would
 * overwrite work this tab never saw, so nothing is written and the answer is
 * `stale`; the form asks, and `force` is the student saying yes
 * (submitConflict, lib/assignment-drafts.ts). A retry of this same submit
 * after a lost answer isn't stale: the draft then holds, or was cleared for,
 * exactly this text.
 *
 * Once the work is handed in, the draft has done its job and is cleared, up
 * to the newest version this submit accounted for: one saved after it isn't
 * this text and is left alone. Returns the draft version the form should save
 * on top of next.
 */
export async function submitAssignment(input: {
  assignmentId: string;
  body?: string | null;
  linkUrl?: string | null;
  draftVersion?: number | null;
  force?: boolean;
}): Promise<ActionResult<SubmitOutcome>> {
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
        .select("id, status, body, link_url, submitted_at")
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

    // Has the draft moved on since this tab last saved? Missing table = 0105
    // not run yet, and then the form never sends a version anyway. A read
    // that fails otherwise skips the check rather than the hand-in: a missed
    // warning costs less than work that can't be submitted.
    const known =
      Number.isInteger(input.draftVersion) && (input.draftVersion as number) >= 0
        ? (input.draftVersion as number)
        : null;
    let draft: DraftRow | null = null;
    let drafts = known !== null;
    if (drafts) {
      const { data: row, error: draftErr } = await admin
        .from("course_assignment_drafts")
        .select("body, link_url, version, updated_at, cleared_at")
        .eq("assignment_id", a.id)
        .eq("user_id", userId)
        .maybeSingle();
      if (draftErr) {
        if (!isMissingSchemaError(draftErr)) console.error("[assignments] draft not read", a.id, draftErr.message);
        drafts = false;
      }
      draft = (row as DraftRow | null) ?? null;
    }
    const conflict = submitConflict({
      known: drafts ? known : null,
      draft,
      submission: existing ?? null,
      input: { body: checked.body ?? "", link: checked.link ?? "" },
      force: input.force === true,
    });
    if (conflict.stale) return { outcome: "stale" as const };

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

    // Best-effort, after the submission is safely stored: a draft left behind
    // is harmless (the pages show a draft only if it's newer than the last
    // submit), a failed hand-in is not. Emptied, not deleted, so its version
    // keeps counting up (0105 says why).
    let draftVersion = known ?? 0;
    if (drafts && draft) {
      const { data: cleared, error: clearErr } = await admin.rpc("clear_course_assignment_draft", {
        p_user_id: userId,
        p_assignment_id: a.id,
        p_up_to_version: conflict.upTo,
      });
      const r = (cleared ?? {}) as { cleared?: unknown; version?: unknown };
      if (clearErr) {
        console.error("[assignments] draft not cleared", a.id, clearErr.message);
      } else if (r.cleared === true && typeof r.version === "number") {
        draftVersion = r.version;
      }
    }

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
    return { outcome: "submitted" as const, draftVersion };
  });
}
