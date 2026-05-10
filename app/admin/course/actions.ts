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

export type ModuleInput = {
  id?: string;
  cohort_id: string;
  week: number;
  title: string;
  summary?: string | null;
  position: number;
};

export type LessonInput = {
  id?: string;
  module_id: string;
  title: string;
  description?: string | null;
  video_path?: string | null;
  video_url?: string | null;
  duration_seconds?: number | null;
  position: number;
  materials?: { title: string; path: string }[];
};

export async function saveModule(input: ModuleInput) {
  await ensureAdmin();
  const admin = createAdminClient();
  const payload = { ...input, summary: input.summary || null };
  if (input.id) {
    const { error } = await admin.from("modules").update(payload).eq("id", input.id);
    if (error) throw new Error(error.message);
  } else {
    const { error } = await admin.from("modules").insert(payload);
    if (error) throw new Error(error.message);
  }
  revalidatePath("/admin/course");
}

export async function deleteModule(id: string) {
  await ensureAdmin();
  const admin = createAdminClient();
  const { error } = await admin.from("modules").delete().eq("id", id);
  if (error) throw new Error(error.message);
  revalidatePath("/admin/course");
}

export async function saveLesson(input: LessonInput) {
  await ensureAdmin();
  const admin = createAdminClient();
  const payload = {
    module_id: input.module_id,
    title: input.title,
    description: input.description || null,
    video_path: input.video_path || null,
    video_url: input.video_url || null,
    duration_seconds: input.duration_seconds || null,
    materials: input.materials ?? [],
    position: input.position,
  };
  if (input.id) {
    const { error } = await admin.from("lessons").update(payload).eq("id", input.id);
    if (error) throw new Error(error.message);
  } else {
    const { error } = await admin.from("lessons").insert(payload);
    if (error) throw new Error(error.message);
  }
  revalidatePath("/admin/course");
}

export async function deleteLesson(id: string) {
  await ensureAdmin();
  const admin = createAdminClient();
  const { error } = await admin.from("lessons").delete().eq("id", id);
  if (error) throw new Error(error.message);
  revalidatePath("/admin/course");
}
