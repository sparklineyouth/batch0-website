"use server";
import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { assertSelf } from "@/lib/server-guards";
import { notify } from "@/lib/notifications";

async function assertTeamMember(userId: string, teamId: string) {
  const admin = createAdminClient();
  const { data } = await admin
    .from("team_members")
    .select("id")
    .eq("team_id", teamId)
    .eq("user_id", userId)
    .maybeSingle();
  if (!data) throw new Error("You aren't a member of that team.");
}

export type PitchPatch = {
  teamId: string;
  deck_path?: string | null;
  video_path?: string | null;
  video_url?: string | null;
  notes?: string | null;
};

export async function upsertPitchSubmission(patch: PitchPatch) {
  const { userId } = await assertSelf();
  await assertTeamMember(userId, patch.teamId);
  const admin = createAdminClient();

  const { data: team } = await admin
    .from("teams")
    .select("cohort_id")
    .eq("id", patch.teamId)
    .maybeSingle();

  const row: Record<string, any> = {
    team_id: patch.teamId,
    cohort_id: team?.cohort_id ?? null,
  };
  if (patch.deck_path !== undefined) row.deck_path = patch.deck_path;
  if (patch.video_path !== undefined) row.video_path = patch.video_path;
  if (patch.video_url !== undefined) {
    const u = (patch.video_url ?? "").trim();
    if (u && !/^https?:\/\//i.test(u)) {
      throw new Error("Video URL must start with http(s)://");
    }
    row.video_url = u || null;
  }
  if (patch.notes !== undefined) {
    row.notes = (patch.notes ?? "").trim().slice(0, 2000) || null;
  }

  const { error } = await admin
    .from("pitch_submissions")
    .upsert(row, { onConflict: "team_id" });
  if (error) throw new Error(error.message);
  revalidatePath("/dashboard/team");
}

export async function submitPitch(input: { teamId: string }) {
  const { userId } = await assertSelf();
  await assertTeamMember(userId, input.teamId);
  const admin = createAdminClient();

  const { data: existing } = await admin
    .from("pitch_submissions")
    .select("deck_path, video_path, video_url, submitted_at")
    .eq("team_id", input.teamId)
    .maybeSingle();
  if (!existing) throw new Error("Upload at least one asset before submitting.");
  const ready =
    !!existing.deck_path || !!existing.video_path || !!existing.video_url;
  if (!ready) throw new Error("Upload a deck or video first.");
  if (existing.submitted_at) return;

  const { error } = await admin
    .from("pitch_submissions")
    .update({ submitted_at: new Date().toISOString() })
    .eq("team_id", input.teamId);
  if (error) throw new Error(error.message);

  // Notify admins so they can do a final review.
  try {
    const { data: team } = await admin
      .from("teams")
      .select("name")
      .eq("id", input.teamId)
      .maybeSingle();
    const { data: admins } = await admin
      .from("profiles")
      .select("id")
      .eq("role", "admin");
    for (const a of admins ?? []) {
      await notify({
        userId: a.id,
        type: "pitch_submitted",
        title: `${team?.name ?? "A team"} submitted their pitch`,
        body: null,
        link: "/admin/teams",
      });
    }
  } catch {}

  revalidatePath("/dashboard/team");
  revalidatePath("/admin/teams");
}
