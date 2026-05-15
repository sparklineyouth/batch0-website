"use server";
import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { assertStaff } from "@/lib/server-guards";
import { logAudit } from "@/lib/audit";

export type ReviewInput = {
  applicationId: string;
  idea: number | null;
  founder: number | null;
  motivation: number | null;
  feasibility: number | null;
  fit: number | null;
  decision:
    | "strong_accept"
    | "accept"
    | "borderline"
    | "reject"
    | "strong_reject"
    | null;
  notes: string | null;
  submit: boolean;
};

export async function saveMyReview(input: ReviewInput) {
  await assertStaff();
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("Not signed in");

  const admin = createAdminClient();
  const payload: Record<string, any> = {
    application_id: input.applicationId,
    reviewer_id: user.id,
    idea: input.idea,
    founder: input.founder,
    motivation: input.motivation,
    feasibility: input.feasibility,
    fit: input.fit,
    decision: input.decision,
    notes: input.notes?.trim() || null,
  };
  if (input.submit) payload.submitted_at = new Date().toISOString();
  const { error } = await admin
    .from("application_reviews")
    .upsert(payload, { onConflict: "application_id,reviewer_id" });
  if (error) throw new Error(error.message);
  await logAudit({
    action: input.submit ? "application.review_submitted" : "application.review_draft",
    targetType: "application",
    targetId: input.applicationId,
    payload: { decision: input.decision },
  });
  revalidatePath(`/admin/applications/${input.applicationId}`);
  revalidatePath("/admin/applications");
}
