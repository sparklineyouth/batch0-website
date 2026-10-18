import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getUser } from "@/lib/auth";
import { VIDEO_URL_TTL_SECONDS } from "@/lib/lesson-assets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A lesson's video: the player's `src`, redirected to a URL signed now.
 *
 * Signing at page render (as the lesson page used to, for ten minutes) broke
 * the common case: read the lesson and do the exercises first, press play
 * later, and the token is already dead. Here the browser asks for the file
 * when it actually needs it, and the player asks again if a long video
 * outlives the signature (lesson-player.tsx).
 *
 * Who may: the same rule as the lesson page and its materials route — the
 * lesson is read through the caller's own client, so RLS ("lessons read
 * enrolled": enrolled in its cohort, or staff) decides. A media element can't
 * show an HTML error page, so failures are a bare 404/503 and the player
 * shows its own message.
 */
export async function GET(_req: Request, props: { params: Promise<{ lessonId: string }> }) {
  const { lessonId } = await props.params;
  const noStore = { "Cache-Control": "no-store" };
  if (!UUID.test(lessonId)) return new NextResponse(null, { status: 404, headers: noStore });
  if (!(await getUser())) return new NextResponse(null, { status: 401, headers: noStore });

  const supabase = await createClient();
  const { data: lesson } = await supabase
    .from("lessons")
    .select("id, video_path, video_url")
    .eq("id", lessonId)
    .maybeSingle();
  if (!lesson?.video_path) return new NextResponse(null, { status: 404, headers: noStore });

  const { data: signed, error } = await createAdminClient()
    .storage.from("course-videos")
    .createSignedUrl(lesson.video_path as string, VIDEO_URL_TTL_SECONDS);
  if (signed?.signedUrl) return NextResponse.redirect(signed.signedUrl, { headers: noStore });

  console.error("[course] video not signed", lessonId, error?.message);
  // The page used to fall back to the lesson's external URL when signing
  // failed; keep doing that.
  if (typeof lesson.video_url === "string" && /^https:\/\//i.test(lesson.video_url)) {
    return NextResponse.redirect(lesson.video_url, { headers: noStore });
  }
  return new NextResponse(null, { status: 503, headers: noStore });
}
