import "server-only";
import type { createAdminClient } from "@/lib/supabase/admin";
import { isMissingSchemaError } from "@/lib/schema-ready";
import { legacyPathOk } from "@/lib/legacy-upload-path";

type Admin = ReturnType<typeof createAdminClient>;

/** One row of public.team_drive_links, as the Drive panel renders it. */
export type DriveLinkRow = {
  id: string;
  kind: string;
  google_id: string;
  resource_key: string | null;
  published: boolean;
  gid: string | null;
  title: string;
  is_folder_root: boolean;
};

export type TeamDriveState = {
  /** False until migration 0094 is applied: the panel says so and hides inputs. */
  ready: boolean;
  folder: DriveLinkRow | null;
  pins: DriveLinkRow[];
};

/**
 * A team's Google Drive folder and pinned links. Service-role read: callers
 * have already decided the viewer may see this team (member, mentor, or
 * teams.manage), the same rule the table's RLS applies.
 */
export async function loadTeamDrive(admin: Admin, teamId: string): Promise<TeamDriveState> {
  const { data, error } = await admin
    .from("team_drive_links")
    .select("id, kind, google_id, resource_key, published, gid, title, is_folder_root")
    .eq("team_id", teamId)
    .order("position", { ascending: true })
    .order("created_at", { ascending: true });
  if (error) {
    if (!isMissingSchemaError(error)) console.error("[team-drive] load failed", error);
    return { ready: !isMissingSchemaError(error), folder: null, pins: [] };
  }
  const rows = (data ?? []) as DriveLinkRow[];
  return {
    ready: true,
    folder: rows.find((r) => r.is_folder_root) ?? null,
    pins: rows.filter((r) => !r.is_folder_root),
  };
}

/** A file from the retired in-app uploads, listed for download only. */
export type OlderUpload = {
  /** Download URL (app/dashboard/team/older-uploads route). */
  href: string;
  name: string;
  sizeBytes: number | null;
  createdAt: string | null;
};

export type OlderUploadsState = {
  team: OlderUpload[];
  mine: OlderUpload[];
  /** A download just failed (?older=unavailable): say so. */
  unavailable?: boolean;
};

/**
 * What a student still has in the retired upload stores: their team's drive
 * files, the team's uploaded pitch deck/video, and their own personal files.
 * Empty lists when there's nothing (the usual case), so the UI can hide the
 * section entirely. Rows whose path fails the download route's check are left
 * out rather than listed with a Download that can't work.
 */
export async function loadOlderUploads(
  admin: Admin,
  args: { userId: string; teamId: string | null },
): Promise<OlderUploadsState> {
  const [teamFiles, pitch, mine] = await Promise.all([
    args.teamId
      ? admin
          .from("team_drive_files")
          .select("id, path, name, size_bytes, created_at")
          .eq("team_id", args.teamId)
          .order("created_at", { ascending: false })
      : null,
    args.teamId
      ? admin
          .from("pitch_submissions")
          .select("deck_path, video_path, updated_at")
          .eq("team_id", args.teamId)
          .maybeSingle()
      : null,
    admin
      .from("student_files")
      .select("id, path, name, size_bytes, created_at")
      .eq("user_id", args.userId)
      .order("created_at", { ascending: false }),
  ]);

  const teamId = args.teamId;
  const team: OlderUpload[] = ((teamFiles?.data ?? []) as any[])
    .filter((f) => teamId && legacyPathOk(f.path, teamId))
    .map((f) => ({
      href: `/dashboard/team/older-uploads/team/${f.id}`,
      name: f.name,
      sizeBytes: f.size_bytes ?? null,
      createdAt: f.created_at ?? null,
    }));
  const p = pitch?.data as { deck_path: string | null; video_path: string | null; updated_at: string | null } | null;
  const pitchFiles: OlderUpload[] = [];
  if (teamId && legacyPathOk(p?.deck_path, teamId)) {
    pitchFiles.push({
      href: `/dashboard/team/older-uploads/pitch-deck/${teamId}`,
      name: "Pitch deck (uploaded)",
      sizeBytes: null,
      createdAt: p!.updated_at,
    });
  }
  if (teamId && legacyPathOk(p?.video_path, teamId)) {
    pitchFiles.push({
      href: `/dashboard/team/older-uploads/pitch-video/${teamId}`,
      name: "Pitch video (uploaded)",
      sizeBytes: null,
      createdAt: p!.updated_at,
    });
  }
  const own: OlderUpload[] = ((mine.data ?? []) as any[])
    .filter((f) => legacyPathOk(f.path, args.userId))
    .map((f) => ({
      href: `/dashboard/team/older-uploads/mine/${f.id}`,
      name: f.name,
      sizeBytes: f.size_bytes ?? null,
      createdAt: f.created_at ?? null,
    }));
  return { team: [...pitchFiles, ...team], mine: own };
}
