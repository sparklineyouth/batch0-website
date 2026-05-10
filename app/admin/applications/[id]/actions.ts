"use server";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

async function ensureAdmin() {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error("Not signed in");
  const { data: profile } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .single();
  if (!profile || profile.role !== "admin") {
    throw new Error("Forbidden");
  }
  return user.id;
}

export async function decideApplication(
  applicationId: string,
  decision: "accepted" | "rejected",
  notes: string,
) {
  const reviewerId = await ensureAdmin();
  const admin = createAdminClient();
  const { error } = await admin
    .from("applications")
    .update({
      status: decision,
      review_notes: notes || null,
      reviewed_at: new Date().toISOString(),
      reviewed_by: reviewerId,
    })
    .eq("id", applicationId);
  if (error) throw new Error(error.message);
  revalidatePath(`/admin/applications/${applicationId}`);
  revalidatePath("/admin/applications");
  revalidatePath("/admin");
}

export async function reopenApplication(applicationId: string) {
  await ensureAdmin();
  const admin = createAdminClient();
  const { error } = await admin
    .from("applications")
    .update({
      status: "submitted",
      reviewed_at: null,
      reviewed_by: null,
      review_notes: null,
    })
    .eq("id", applicationId);
  if (error) throw new Error(error.message);
  revalidatePath(`/admin/applications/${applicationId}`);
  revalidatePath("/admin/applications");
}
