import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Download one file from the retired in-app uploads (personal Files, the
 * team drive, and uploaded pitch decks/videos). Read-only: these stores are
 * frozen by migration 0094 and nothing new lands in them.
 *
 *   /dashboard/team/older-uploads/mine/<student_files.id>   — the owner only
 *   /dashboard/team/older-uploads/team/<team_drive_files.id> — team members
 *   /dashboard/team/older-uploads/pitch-deck/<team id>       — team members
 *   /dashboard/team/older-uploads/pitch-video/<team id>      — team members
 *
 * The stored path is checked against the owner's folder before signing. Rows
 * used to be insertable through the API with any path, so a row is not proof
 * the object belongs to its owner.
 */
export async function GET(
  _req: Request,
  props: { params: Promise<{ source: string; id: string }> },
) {
  const { source, id } = await props.params;
  const base = process.env.NEXT_PUBLIC_SITE_URL ?? "https://batch0.org";
  const back = NextResponse.redirect(new URL("/dashboard/team?tab=drive", base), 303);

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.redirect(
      new URL(`/login?next=${encodeURIComponent("/dashboard/team?tab=drive")}`, base),
      303,
    );
  }
  if (!UUID.test(id)) return back;

  const admin = createAdminClient();
  const isMember = async (teamId: string) => {
    const { data } = await admin
      .from("team_members")
      .select("id")
      .eq("team_id", teamId)
      .eq("user_id", user.id)
      .maybeSingle();
    return !!data;
  };

  let bucket: "student-files" | "team-drive";
  let path: string | null = null;
  let prefix: string;
  let name: string;

  if (source === "mine") {
    const { data } = await admin
      .from("student_files")
      .select("user_id, name, path")
      .eq("id", id)
      .maybeSingle();
    if (!data || data.user_id !== user.id) return back;
    bucket = "student-files";
    path = data.path;
    prefix = `${user.id}/`;
    name = data.name;
  } else if (source === "team") {
    const { data } = await admin
      .from("team_drive_files")
      .select("team_id, name, path")
      .eq("id", id)
      .maybeSingle();
    if (!data || !(await isMember(data.team_id))) return back;
    bucket = "team-drive";
    path = data.path;
    prefix = `${data.team_id}/`;
    name = data.name;
  } else if (source === "pitch-deck" || source === "pitch-video") {
    if (!(await isMember(id))) return back;
    const { data } = await admin
      .from("pitch_submissions")
      .select("deck_path, video_path")
      .eq("team_id", id)
      .maybeSingle();
    path = (source === "pitch-deck" ? data?.deck_path : data?.video_path) ?? null;
    bucket = "team-drive";
    prefix = `${id}/`;
    name = path?.split("/").pop() ?? "pitch";
  } else {
    return back;
  }

  if (
    !path ||
    !path.startsWith(prefix) ||
    path.includes("..") ||
    path.includes("//") ||
    path.includes("\\")
  ) {
    return back;
  }

  const { data: signed } = await admin.storage
    .from(bucket)
    .createSignedUrl(path, 60 * 10, { download: name });
  if (!signed?.signedUrl) return back;

  const res = NextResponse.redirect(signed.signedUrl, 303);
  res.headers.set("Cache-Control", "no-store");
  res.headers.set("Referrer-Policy", "no-referrer");
  return res;
}
