"use server";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

async function ensureAdmin() {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error("Not signed in");
  const { data: profile } = await supabase.from("profiles").select("role").eq("id", user.id).single();
  if (!profile || profile.role !== "admin") throw new Error("Forbidden");
}

export type SiteSettingsInput = {
  contact_email: string;
  applications_open: boolean;
  applications_closed_message: string;
  active_cohort_id: string | null;
  active_cohort_name: string | null;
  discord_url: string;
  demo_day_date: string | null;
  maintenance_mode: boolean;
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
];

export async function saveSiteSettings(input: SiteSettingsInput) {
  await ensureAdmin();

  // Light validation. Email + URL fields just need to be non-pathological.
  if (input.contact_email && !/^\S+@\S+\.\S+$/.test(input.contact_email)) {
    throw new Error("Contact email looks invalid");
  }
  if (input.discord_url && !/^https?:\/\//.test(input.discord_url)) {
    throw new Error("Discord URL must start with http(s)://");
  }

  const admin = createAdminClient();
  const rows = KEYS.map((key) => ({
    key,
    value: input[key] ?? null,
    updated_at: new Date().toISOString(),
  }));
  const { error } = await admin
    .from("site_settings")
    .upsert(rows, { onConflict: "key" });
  if (error) throw new Error(error.message);
  revalidatePath("/admin/settings");
  revalidatePath("/");
}
