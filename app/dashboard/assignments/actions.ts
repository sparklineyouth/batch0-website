"use server";
import { revalidatePath } from "next/cache";
import { unstable_rethrow } from "next/navigation";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireActor } from "@/lib/server-guards";
import { runAction, type ActionResult } from "@/lib/action-result";
import { checkRateLimit } from "@/lib/rate-limit";
import { notifyMany } from "@/lib/notifications";
import { cohortHasStarted, todayISO } from "@/lib/pre-cohort";
import { isMissingSchemaError } from "@/lib/schema-ready";
import { canEditSubmission, validateSubmission, type SubmissionType } from "@/lib/assignments";
import { checkDraft, interpretDraftSave, type DraftSaveResult } from "@/lib/assignment-drafts";

const NOT_READY = "Assignments aren't set up yet.";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Hand in (or edit) an assignment. Shared by /dashboard/assignments and the
 * installed app. Everything is re-checked here: the assignment is published
 * and open, the student is enrolled in its cohort (and targeted, for a
 * students-only assignment), the cohort has started, and the work fits its
 * submission type. Late work is accepted and flagged.
 *
 * `draftVersion` is the version of the private draft (0105) the form's text
 * was last saved as. Once the work is handed in, that draft has done its job
 * and is cleared — but only up to that version: a newer one was written in
 * another tab after this one last saved, and isn't this text. Returns the
 * draft version the form should save on top of next (0 once it's cleared).
 */
export async function submitAssignment(input: {
  assignmentId: string;
  body?: string | null;
  linkUrl?: string | null;
  draftVersion?: number | null;
}): Promise<ActionResult<{ draftVersion: number }>> {
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

    // Best-effort, after the submission is safely stored: a draft left behind
    // is harmless (the pages show a draft only if it's newer than the last
    // submit), a failed hand-in is not. Missing table = 0105 not run yet.
    const knownDraft =
      Number.isInteger(input.draftVersion) && (input.draftVersion as number) > 0
        ? (input.draftVersion as number)
        : 0;
    let draftVersion = knownDraft;
    if (knownDraft > 0) {
      const { data: cleared, error: draftErr } = await admin
        .from("course_assignment_drafts")
        .delete()
        .eq("assignment_id", a.id)
        .eq("user_id", userId)
        .lte("version", knownDraft)
        .select("version");
      if (draftErr) {
        if (!isMissingSchemaError(draftErr)) console.error("[assignments] draft not cleared", a.id, draftErr.message);
      } else if ((cleared ?? []).length > 0) {
        draftVersion = 0;
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
    return { draftVersion };
  });
}

/**
 * Autosave the student's unsubmitted work as a private draft (migration
 * 0105). Never a submission: nothing here touches
 * course_assignment_submissions, notifies anyone, or revalidates a staff page.
 *
 * Access is re-checked on every save inside save_course_assignment_draft()
 * (open, enrolled, targeted, cohort started, not reviewed or excused), so a
 * student who loses access stops being able to save on the next keystroke.
 * `baseVersion` is the draft version this text was typed on top of; a tab
 * holding an older one gets `stale` and nothing is written.
 *
 * Returns a reason code rather than throwing, and never redirects: this runs
 * in the background while someone types, so a signed-out session must come
 * back as "signed_out" for the form to say so — not navigate away from the
 * text it couldn't save.
 */
export async function saveAssignmentDraft(input: {
  assignmentId: string;
  body?: string | null;
  linkUrl?: string | null;
  baseVersion?: number | null;
}): Promise<DraftSaveResult> {
  let userId: string;
  try {
    ({ userId } = await requireActor());
  } catch (err) {
    unstable_rethrow(err);
    return { ok: false, reason: "signed_out" };
  }
  if (typeof input.assignmentId !== "string" || !UUID.test(input.assignmentId)) {
    return { ok: false, reason: "forbidden" };
  }
  const checked = checkDraft({ body: input.body, link: input.linkUrl });
  if (!checked.ok) return { ok: false, reason: "too_long" };
  const base =
    Number.isInteger(input.baseVersion) && (input.baseVersion as number) > 0 ? (input.baseVersion as number) : 0;

  // Generous: a save waits for a two-second pause in typing, so a person
  // can't come near this. It stops a runaway client, not a fast typist.
  const rl = await checkRateLimit({
    kind: "assignment-draft",
    identifier: userId,
    limit: 2000,
    windowSeconds: 3600,
  });
  if (!rl.ok) return { ok: false, reason: "rate_limited" };

  try {
    const { data, error } = await createAdminClient().rpc("save_course_assignment_draft", {
      p_user_id: userId,
      p_assignment_id: input.assignmentId,
      p_body: checked.body,
      p_link_url: checked.link,
      p_base_version: base,
    });
    if (error) {
      // 0105 not run yet (no function / table in the schema cache).
      if (isMissingSchemaError(error)) return { ok: false, reason: "not_ready" };
      console.error("[assignments] draft save failed", input.assignmentId, error.message);
      return { ok: false, reason: "error" };
    }
    return interpretDraftSave(data);
  } catch (err) {
    console.error("[assignments] draft save failed", input.assignmentId, err);
    return { ok: false, reason: "error" };
  }
}
