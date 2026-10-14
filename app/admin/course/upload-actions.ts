"use server";
import { createAdminClient } from "@/lib/supabase/admin";
import { assertPermission } from "@/lib/server-guards";

const STAFF_BUCKETS = new Set([
  "course-videos",
  "course-materials",
  "resources",
]);

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
 * Staff only (course.manage): course videos, course materials, resources.
 */
export async function getUploadToken(
  bucket: string,
  folder: string,
  filename: string,
) {
  await assertPermission("course.manage");
  if (!STAFF_BUCKETS.has(bucket)) throw new Error("Invalid bucket");
  const pathPrefix = safeSegment(folder || "misc");

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
