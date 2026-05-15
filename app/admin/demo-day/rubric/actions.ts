"use server";
import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { assertAdmin } from "@/lib/server-guards";
import { logAudit } from "@/lib/audit";

export type RubricCriterion = {
  id?: string;
  cohort_id: string | null;
  label: string;
  description: string | null;
  weight: number;
  max_score: number;
  position: number;
};

export async function saveRubric(rows: RubricCriterion[]) {
  await assertAdmin();
  const admin = createAdminClient();
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (!r.label.trim()) throw new Error("Every criterion needs a label");
    if (r.weight < 0) throw new Error("Weights must be positive");
    if (r.max_score < 1) throw new Error("Max score must be ≥ 1");
    const payload = {
      cohort_id: r.cohort_id || null,
      label: r.label.trim(),
      description: r.description?.trim() || null,
      weight: r.weight,
      max_score: Math.round(r.max_score),
      position: i,
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

export async function deleteCriterion(id: string) {
  await assertAdmin();
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
  const { userId } = await assertAdmin().catch(async () => {
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
