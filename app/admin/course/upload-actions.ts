"use server";
import { createAdminClient } from "@/lib/supabase/admin";
import { assertStaff, assertSelf } from "@/lib/server-guards";

const STAFF_BUCKETS = new Set(["course-videos", "course-materials"]);
const SELF_BUCKETS = new Set(["submissions", "student-files"]);

// 1 GB cap per student in their personal drive.
const STUDENT_FILES_CAP_BYTES = 1024 * 1024 * 1024;

function safeSegment(s: string) {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

/**
 * Returns a signed upload URL the browser can PUT a file to. `path` is
 * generated server-side from `folder` + filename to avoid collisions.
 *
 * Staff buckets (course-videos, course-materials) require admin OR
 * mentor. Self buckets (submissions, student-files) require an
 * authenticated user, and the path is forced into a folder named after
 * the user's id (matching the storage RLS policy).
 */
export async function getUploadToken(
  bucket: string,
  folder: string,
  filename: string,
) {
  let pathPrefix: string;

  if (STAFF_BUCKETS.has(bucket)) {
    await assertStaff();
    pathPrefix = safeSegment(folder || "misc");
  } else if (SELF_BUCKETS.has(bucket)) {
    const { userId } = await assertSelf();

    // Per-user 1GB cap on the personal drive bucket.
    if (bucket === "student-files") {
      const admin = createAdminClient();
      const { data: rows } = await admin
        .from("student_files")
        .select("size_bytes")
        .eq("user_id", userId);
      const used = (rows ?? []).reduce(
        (s: number, r: any) => s + (r.size_bytes ?? 0),
        0,
      );
      if (used >= STUDENT_FILES_CAP_BYTES) {
        throw new Error(
          "Drive is full (1 GB cap). Delete some files to upload more.",
        );
      }
    }

    // Force the user folder so storage RLS matches.
    pathPrefix = `${userId}/${safeSegment(folder || "misc")}`.replace(
      /\/+$/,
      "",
    );
  } else {
    throw new Error("Invalid bucket");
  }

  const dot = filename.lastIndexOf(".");
  const base = dot > 0 ? filename.slice(0, dot) : filename;
  const ext = dot > 0 ? filename.slice(dot + 1) : "";
  const stamp = Date.now();
  const finalName = `${safeSegment(base)}-${stamp}${ext ? "." + safeSegment(ext) : ""}`;
  const path = `${pathPrefix}/${finalName}`;

  const admin = createAdminClient();
  const { data, error } = await admin.storage
    .from(bucket)
    .createSignedUploadUrl(path);
  if (error) throw new Error(error.message);

  return { path: data.path, token: data.token, signedUrl: data.signedUrl };
}
