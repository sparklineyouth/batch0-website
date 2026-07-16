"use server";
import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { assertAdmin } from "@/lib/server-guards";
import { logAudit } from "@/lib/audit";

export type ResourceInput = {
  id?: string;
  cohort_id: string | null;
  category: string;
  title: string;
  description: string | null;
  storage_path: string | null;
  external_url: string | null;
  size_bytes: number | null;
  mime_type: string | null;
  /** Visible to accepted students before their cohort starts. */
  pre_cohort: boolean;
};

function validate(input: ResourceInput) {
  if (!input.title.trim()) throw new Error("Title is required");
  if (!input.storage_path && !input.external_url) {
    throw new Error("Add a file upload OR an external URL");
  }
  if (
    input.external_url &&
    !/^https?:\/\/.+/.test(input.external_url.trim())
  ) {
    throw new Error("External URL must start with http(s)://");
  }
}

export async function saveResource(input: ResourceInput): Promise<string> {
  const { userId } = await assertAdmin();
  validate(input);

  const admin = createAdminClient();
  const payload = {
    cohort_id: input.cohort_id || null,
    category: input.category.trim() || "general",
    title: input.title.trim(),
    description: input.description?.trim() || null,
    storage_path: input.storage_path?.trim() || null,
    external_url: input.external_url?.trim() || null,
    size_bytes: input.size_bytes,
    mime_type: input.mime_type,
    pre_cohort: !!input.pre_cohort,
  };
  let id = input.id;
  if (id) {
    const { error } = await admin
      .from("resources")
      .update(payload)
      .eq("id", id);
    if (error) throw new Error(error.message);
  } else {
    const { data: created, error } = await admin
      .from("resources")
      .insert({ ...payload, created_by: userId })
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    id = created!.id;
  }

  await logAudit({
    action: input.id ? "resource.updated" : "resource.created",
    targetType: "resource",
    targetId: id ?? null,
    payload: { title: payload.title, cohort_id: payload.cohort_id },
  });

  revalidatePath("/admin/resources");
  revalidatePath("/dashboard/resources");
  return id!;
}

export async function deleteResource(id: string) {
  await assertAdmin();
  const admin = createAdminClient();
  const { data: existing } = await admin
    .from("resources")
    .select("storage_path, title")
    .eq("id", id)
    .maybeSingle();
  if (existing?.storage_path) {
    await admin.storage.from("resources").remove([existing.storage_path]);
  }
  const { error } = await admin.from("resources").delete().eq("id", id);
  if (error) throw new Error(error.message);
  await logAudit({
    action: "resource.deleted",
    targetType: "resource",
    targetId: id,
    payload: { title: existing?.title ?? null },
  });
  revalidatePath("/admin/resources");
  revalidatePath("/dashboard/resources");
}
