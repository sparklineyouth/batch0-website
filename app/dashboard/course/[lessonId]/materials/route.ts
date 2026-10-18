import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getUser } from "@/lib/auth";
import { MATERIAL_URL_TTL_SECONDS, findMaterial } from "@/lib/lesson-assets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Open one lesson material: /dashboard/course/<lesson>/materials?path=<path>
 * → a redirect to a URL signed now, after the check.
 *
 * The lesson page used to put ten-minute signed URLs in its links at render,
 * so a worksheet clicked after a long lesson (or a tab left open overnight)
 * was already dead. This is the move /dashboard/resources/open/[id] made: the
 * click comes here, and the URL is always seconds old.
 *
 * Who may: whoever can read the lesson. It's read through the caller's own
 * client, so the "lessons read enrolled" policy decides (enrolled in its
 * cohort, or staff) — the same rule as the lesson page — and only a path the
 * lesson itself lists is signed, so this can't be used to sign an arbitrary
 * object in the bucket. Being under /dashboard, middleware's sign-in, fine
 * and pre-cohort gates apply here exactly as they do to the lesson page.
 *
 * Failures come back to the lesson with `?material=…` (it says what happened)
 * on the host the click came from: the installed app's subdomain has its own
 * session cookie, so sending it to the apex would sign the student out.
 */
export async function GET(req: Request, props: { params: Promise<{ lessonId: string }> }) {
  const { lessonId } = await props.params;
  const path = new URL(req.url).searchParams.get("path");
  const back = (to: string) =>
    NextResponse.redirect(new URL(to, req.url), { headers: { "Cache-Control": "no-store" } });

  if (!UUID.test(lessonId)) return back("/dashboard/course");

  const user = await getUser();
  if (!user) {
    const here = `/dashboard/course/${lessonId}/materials?path=${encodeURIComponent(path ?? "")}`;
    return back(`/login?next=${encodeURIComponent(here)}`);
  }

  const supabase = await createClient();
  const { data: lesson } = await supabase
    .from("lessons")
    .select("id, materials")
    .eq("id", lessonId)
    .maybeSingle();
  if (!lesson) return back("/dashboard/course");

  const material = findMaterial(lesson.materials, path);
  if (!material) return back(`/dashboard/course/${lessonId}?material=missing`);

  const { data: signed, error } = await createAdminClient()
    .storage.from("course-materials")
    .createSignedUrl(material.path, MATERIAL_URL_TTL_SECONDS);
  if (!signed?.signedUrl) {
    console.error("[course] material not signed", lessonId, material.path, error?.message);
    return back(`/dashboard/course/${lessonId}?material=unavailable`);
  }
  // no-store: a cached redirect would replay a signed URL after it expires.
  return NextResponse.redirect(signed.signedUrl, { headers: { "Cache-Control": "no-store" } });
}
