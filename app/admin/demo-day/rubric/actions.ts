"use server";
import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { assertPermission } from "@/lib/server-guards";
import { logAudit } from "@/lib/audit";
import {
  DEFAULT_PITCH_RUBRIC,
  coerceAnchors,
  type RubricAnchor,
} from "@/lib/demo-day-rubric";

export type RubricCriterion = {
  id?: string;
  cohort_id: string | null;
  label: string;
  description: string | null;
  weight: number;
  max_score: number;
  position: number;
  anchors?: RubricAnchor[] | null;
};

export async function saveRubric(rows: RubricCriterion[]) {
  await assertPermission("demoday.manage");
  const admin = createAdminClient();
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (!r.label.trim()) throw new Error("Every criterion needs a label");
    if (r.weight < 0) throw new Error("Weights must be positive");
    if (r.max_score < 1) throw new Error("Max score must be ≥ 1");
    // Anchors are narrowed here as well as in the editor: this action is the
    // only writer, and an anchor above the criterion's own ceiling would
    // describe a score no judge can give.
    const anchors = coerceAnchors(r.anchors).filter(
      (a) => a.level >= 0 && a.level <= Math.round(r.max_score),
    );
    const payload = {
      cohort_id: r.cohort_id || null,
      label: r.label.trim(),
      description: r.description?.trim() || null,
      weight: r.weight,
      max_score: Math.round(r.max_score),
      position: i,
      anchors,
    };
    if (r.id) {
      const { error } = await admin
        .from("demo_day_rubric_criteria")
        .update(payload)
        .eq("id", r.id);
      if (error) throw new Error(error.message);
    } else {
      const { error } = await admin
        .from("demo_day_rubric_criteria")
        .insert(payload);
      if (error) throw new Error(error.message);
    }
  }
  await logAudit({
    action: "demo_day.rubric_updated",
    payload: { count: rows.length },
  });
  revalidatePath("/admin/demo-day/rubric");
  revalidatePath("/admin/demo-day");
}

/**
 * Writes the five standard pitch criteria (lib/demo-day-rubric.ts) into a
 * cohort's rubric.
 *
 * This, rather than a seed in the migration, is how the rubric gets into the
 * database: the copy lives in one place in the repo, and an admin who rewords
 * an anchor and wants the shipped wording back can press this again.
 *
 * It refuses to run over an existing rubric for the same scope. Overwriting
 * would silently rewrite criteria that judges have already scored against —
 * the scores would survive, attached to criteria that no longer say what they
 * said when the score was given. Clearing the rubric by hand first is the
 * deliberate version of that, and it tells the admin what they are doing.
 */
export async function installDefaultRubric(cohortId: string | null): Promise<{
  inserted: number;
}> {
  await assertPermission("demoday.manage");
  const admin = createAdminClient();

  const existing = admin
    .from("demo_day_rubric_criteria")
    .select("id", { count: "exact", head: true });
  const { count, error: countErr } = await (cohortId
    ? existing.eq("cohort_id", cohortId)
    : existing.is("cohort_id", null));
  if (countErr) throw new Error(countErr.message);
  if ((count ?? 0) > 0) {
    throw new Error(
      "This scope already has criteria. Remove them first if you want the standard rubric back.",
    );
  }

  const { error } = await admin.from("demo_day_rubric_criteria").insert(
    DEFAULT_PITCH_RUBRIC.map((c, i) => ({
      cohort_id: cohortId,
      label: c.label,
      description: c.description,
      weight: c.weight,
      max_score: c.max_score,
      position: i,
      anchors: c.anchors,
    })),
  );
  if (error) throw new Error(error.message);

  await logAudit({
    action: "demo_day.rubric_default_installed",
    payload: { cohort_id: cohortId, count: DEFAULT_PITCH_RUBRIC.length },
  });
  revalidatePath("/admin/demo-day/rubric");
  revalidatePath("/admin/demo-day");
  return { inserted: DEFAULT_PITCH_RUBRIC.length };
}

export async function deleteCriterion(id: string) {
  await assertPermission("demoday.manage");
  const admin = createAdminClient();
  const { error } = await admin
    .from("demo_day_rubric_criteria")
    .delete()
    .eq("id", id);
  if (error) throw new Error(error.message);
  await logAudit({
    action: "demo_day.rubric_criterion_deleted",
    payload: { id },
  });
  revalidatePath("/admin/demo-day/rubric");
}

export type ScoreInput = {
  team_id: string;
  criterion_id: string;
  score: number;
  comment?: string | null;
};

export async function submitScores(rows: ScoreInput[]) {
  const { userId } = await assertPermission("demoday.manage").catch(async () => {
    // Investors + mentors are also allowed by RLS; just fetch userId.
    const { createClient } = await import("@/lib/supabase/server");
    const supa = createClient();
    const {
      data: { user },
    } = await supa.auth.getUser();
    if (!user) throw new Error("Not signed in");
    return { userId: user.id };
  });
  const admin = createAdminClient();
  for (const r of rows) {
    const { error } = await admin
      .from("demo_day_scores")
      .upsert(
        {
          team_id: r.team_id,
          judge_id: userId,
          criterion_id: r.criterion_id,
          score: Math.round(r.score),
          comment: r.comment ?? null,
        },
        { onConflict: "team_id,judge_id,criterion_id" },
      );
    if (error) throw new Error(error.message);
  }
  revalidatePath("/admin/demo-day");
}
