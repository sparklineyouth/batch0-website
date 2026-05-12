"use server";
import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { assertSelf } from "@/lib/server-guards";
import { assertMentorCanAccessStudent } from "@/lib/mentor-scope";

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
  // Defense-in-depth — the client also gates on this but a tampered
  // client can lie about size_bytes. 100MB matches the bucket policy.
  if (file.size_bytes != null && file.size_bytes > 100 * 1024 * 1024) {
    throw new Error("File exceeds the 100MB limit.");
  }
  const admin = createAdminClient();

  // Verify the object actually exists in storage. Without this a
  // tampered client could register paths it never uploaded — those
  // entries would 404 on download but still litter the index.
  const segments = file.path.split("/");
  const filename = segments.pop() ?? "";
  const folder = segments.join("/");
  const { data: listed } = await admin.storage
    .from(BUCKET)
    .list(folder, { limit: 1, search: filename });
  if (!listed?.some((o: any) => o.name === filename)) {
    throw new Error("Upload didn't complete — try again.");
  }

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

  // Self-access fast path. Otherwise the caller must be staff with a
  // legitimate cohort tie to the file owner — admins always, mentors
  // only for their own cohort. (Investors don't get personal-drive
  // access at all.)
  if (file.user_id !== userId) {
    const { data: profile } = await admin
      .from("profiles")
      .select("role")
      .eq("id", userId)
      .maybeSingle();
    const role = profile?.role ?? "student";
    if (role !== "admin" && role !== "mentor") {
      throw new Error("Forbidden");
    }
    await assertMentorCanAccessStudent({
      callerId: userId,
      callerRole: role,
      studentId: file.user_id,
    });
  }
  const { data, error: signErr } = await admin.storage
    .from(BUCKET)
    .createSignedUrl(file.path, 60 * 10); // 10 minutes
  if (signErr || !data?.signedUrl) {
    throw new Error(signErr?.message ?? "Could not generate URL");
  }
  return data.signedUrl;
}
