"use server";
import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { assertSelf } from "@/lib/server-guards";

const BUCKET = "student-files";

export type RegisteredFile = {
  name: string;
  path: string;
  size_bytes: number | null;
  mime_type: string | null;
};

/** After a client-side direct upload, register the file in the index table. */
export async function registerStudentFile(file: RegisteredFile) {
  const { userId } = await assertSelf();
  // Path was generated server-side and is forced into the user's folder by
  // upload-actions, so nothing more to validate beyond a sanity prefix check.
  if (!file.path.startsWith(`${userId}/`)) {
    throw new Error("Path doesn't belong to you.");
  }
  const admin = createAdminClient();
  const { error } = await admin.from("student_files").insert({
    user_id: userId,
    name: file.name.slice(0, 200),
    path: file.path,
    size_bytes: file.size_bytes,
    mime_type: file.mime_type,
  });
  if (error) throw new Error(error.message);
  revalidatePath("/dashboard/files");
}

export async function deleteStudentFile(id: string) {
  const { userId } = await assertSelf();
  const admin = createAdminClient();
  const { data: existing, error: fetchErr } = await admin
    .from("student_files")
    .select("id, path, user_id")
    .eq("id", id)
    .single();
  if (fetchErr) throw new Error(fetchErr.message);
  if (existing.user_id !== userId) throw new Error("Forbidden");

  // Best-effort delete from storage; index row removal is the source of truth.
  await admin.storage.from(BUCKET).remove([existing.path]);
  const { error } = await admin.from("student_files").delete().eq("id", id);
  if (error) throw new Error(error.message);
  revalidatePath("/dashboard/files");
}

export async function renameStudentFile(id: string, name: string) {
  const { userId } = await assertSelf();
  const trimmed = name.trim().slice(0, 200);
  if (!trimmed) throw new Error("Name cannot be empty");
  const admin = createAdminClient();
  const { data: existing, error: fetchErr } = await admin
    .from("student_files")
    .select("user_id")
    .eq("id", id)
    .single();
  if (fetchErr) throw new Error(fetchErr.message);
  if (existing.user_id !== userId) throw new Error("Forbidden");
  const { error } = await admin
    .from("student_files")
    .update({ name: trimmed })
    .eq("id", id);
  if (error) throw new Error(error.message);
  revalidatePath("/dashboard/files");
}

export async function getDownloadUrl(id: string): Promise<string> {
  const { userId } = await assertSelf();
  const admin = createAdminClient();
  const { data: file, error } = await admin
    .from("student_files")
    .select("user_id, path")
    .eq("id", id)
    .single();
  if (error) throw new Error(error.message);
  if (file.user_id !== userId) throw new Error("Forbidden");
  const { data, error: signErr } = await admin.storage
    .from(BUCKET)
    .createSignedUrl(file.path, 60 * 60); // 1 hour
  if (signErr || !data?.signedUrl) {
    throw new Error(signErr?.message ?? "Could not generate URL");
  }
  return data.signedUrl;
}
