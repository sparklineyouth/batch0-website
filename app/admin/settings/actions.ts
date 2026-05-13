"use server";
import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { assertAdmin } from "@/lib/server-guards";
import { logAudit } from "@/lib/audit";
import { runAction, type ActionResult } from "@/lib/action-result";

export type SiteSettingsInput = {
  contact_email: string;
  applications_open: boolean;
  applications_closed_message: string;
  active_cohort_id: string | null;
  active_cohort_name: string | null;
  discord_url: string;
  demo_day_date: string | null;
  maintenance_mode: boolean;
  referrals_enabled: boolean;
};

const KEYS: (keyof SiteSettingsInput)[] = [
  "contact_email",
  "applications_open",
  "applications_closed_message",
  "active_cohort_id",
  "active_cohort_name",
  "discord_url",
  "demo_day_date",
  "maintenance_mode",
  "referrals_enabled",
];

export async function saveSiteSettings(
  input: SiteSettingsInput,
): Promise<ActionResult> {
  return runAction({ name: "saveSiteSettings" }, async () => {
    await assertAdmin();

    if (input.contact_email && !/^\S+@\S+\.\S+$/.test(input.contact_email)) {
      throw new Error("Contact email looks invalid");
    }
    if (input.discord_url && !/^https?:\/\//.test(input.discord_url)) {
      throw new Error("Discord URL must start with http(s)://");
    }

    const admin = createAdminClient();
    // We upsert one row per key. Migration 0020 makes value nullable, so
    // unset optional settings (active_cohort_id, demo_day_date) round-
    // trip as SQL NULL — readers already treat that as "use default."
    const rows = KEYS.map((key) => ({
      key,
      value: input[key] ?? null,
      updated_at: new Date().toISOString(),
    }));
    const { error } = await admin
      .from("site_settings")
      .upsert(rows, { onConflict: "key" });
    if (error) throw new Error(`Save failed: ${error.message}`);

    await logAudit({
      action: "settings.updated",
      payload: input,
    });
    revalidatePath("/admin/settings");
    revalidatePath("/");
    revalidatePath("/apply");
    revalidatePath("/opengraph-image");
  });
}
