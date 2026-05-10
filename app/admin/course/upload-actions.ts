"use server";
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
}

const ALLOWED_BUCKETS = new Set(["course-videos", "course-materials"]);

function safeSegment(s: string) {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

/**
 * Returns a signed upload URL the browser can PUT a file to.
 * `path` is generated server-side from `folder` + filename to avoid collisions.
 */
export async function getUploadToken(
  bucket: string,
  folder: string,
  filename: string,
) {
  await ensureAdmin();
  if (!ALLOWED_BUCKETS.has(bucket)) throw new Error("Invalid bucket");

  const safeFolder = safeSegment(folder || "misc");
  const dot = filename.lastIndexOf(".");
  const base = dot > 0 ? filename.slice(0, dot) : filename;
  const ext = dot > 0 ? filename.slice(dot + 1) : "";
  const stamp = Date.now();
  const finalName = `${safeSegment(base)}-${stamp}${ext ? "." + safeSegment(ext) : ""}`;
  const path = `${safeFolder}/${finalName}`;

  const admin = createAdminClient();
  const { data, error } = await admin.storage
    .from(bucket)
    .createSignedUploadUrl(path);
  if (error) throw new Error(error.message);

  return { path: data.path, token: data.token, signedUrl: data.signedUrl };
}
