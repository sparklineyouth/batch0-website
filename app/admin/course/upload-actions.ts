"use server";
import { createAdminClient } from "@/lib/supabase/admin";
import { assertStaff, assertSelf } from "@/lib/server-guards";

const STAFF_BUCKETS = new Set(["course-videos", "course-materials"]);
const SELF_BUCKETS = new Set(["submissions", "student-files"]);

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
 * professor. Self buckets (submissions, student-files) require an
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
