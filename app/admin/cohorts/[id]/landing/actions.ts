"use server";
import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { assertAdmin } from "@/lib/server-guards";
import { logAudit } from "@/lib/audit";

export type LandingInput = {
  id: string;
  landing_headline: string;
  landing_subhead: string;
  landing_cta_label: string;
  accent_hex: string;
  hero_image_url: string;
};

export async function saveLanding(input: LandingInput) {
  await assertAdmin();
  if (
    input.accent_hex &&
    !/^#[0-9a-fA-F]{6}$/.test(input.accent_hex.trim())
  ) {
    throw new Error("Accent must be a 6-digit hex color like #facc15.");
  }
  const admin = createAdminClient();
  const { data: before } = await admin
    .from("cohorts")
    .select(
      "landing_headline, landing_subhead, landing_cta_label, accent_hex, hero_image_url",
    )
    .eq("id", input.id)
    .maybeSingle();
  const payload = {
    landing_headline: input.landing_headline.trim() || null,
    landing_subhead: input.landing_subhead.trim() || null,
    landing_cta_label: input.landing_cta_label.trim() || null,
    accent_hex: input.accent_hex.trim() || null,
    hero_image_url: input.hero_image_url.trim() || null,
  };
  const { error } = await admin
    .from("cohorts")
    .update(payload)
    .eq("id", input.id);
  if (error) throw new Error(error.message);
  await logAudit({
    action: "cohort.landing_updated",
    targetType: "cohort",
    targetId: input.id,
    payload: { before: before ?? {}, after: payload },
  });
  revalidatePath(`/admin/cohorts/${input.id}/landing`);
  revalidatePath("/cohort", "layout");
}
