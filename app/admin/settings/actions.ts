"use server";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

async function ensureAdmin() {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error("Not signed in");
  const { data: profile } = await supabase.from("profiles").select("role").eq("id", user.id).single();
  if (!profile || (profile.role !== "admin" && profile.role !== "teacher")) throw new Error("Forbidden");
}

export async function saveSetting(key: string, valueJson: string) {
  await ensureAdmin();
  let parsed: any;
  try {
    parsed = JSON.parse(valueJson);
  } catch {
    throw new Error(`Invalid JSON for ${key}`);
  }
  const admin = createAdminClient();
  const { error } = await admin
    .from("site_settings")
    .upsert({ key, value: parsed, updated_at: new Date().toISOString() });
  if (error) throw new Error(error.message);
  revalidatePath("/admin/settings");
}
