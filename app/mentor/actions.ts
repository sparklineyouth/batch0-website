"use server";
import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { assertSelf } from "@/lib/server-guards";
import { createClient } from "@/lib/supabase/server";

export async function saveMentorNote(assignmentId: string, notes: string) {
  const { userId } = await assertSelf();
  const supabase = createClient();
  const { data: profile } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", userId)
    .single();
  if (!profile || (profile.role !== "mentor" && profile.role !== "admin")) {
    throw new Error("Forbidden");
  }
  const admin = createAdminClient();
  const { error } = await admin
    .from("mentor_assignments")
    .update({ notes: notes.trim() || null })
    .eq("id", assignmentId)
    .eq("mentor_id", userId);
  if (error) throw new Error(error.message);
  revalidatePath("/mentor/students");
}
