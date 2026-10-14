"use server";
import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { assertSelf } from "@/lib/server-guards";
import { notify } from "@/lib/notifications";
import { runAction, type ActionResult } from "@/lib/action-result";
import { isMissingSchemaError } from "@/lib/schema-ready";
import { safeHttpsUrl } from "@/lib/google-drive-links";

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
  deck_url?: string | null;
  video_url?: string | null;
  notes?: string | null;
};

/** "" → null; anything else must be an https link (a bare host gets https://). */
function linkField(raw: string | null | undefined, label: string): string | null {
  const s = (raw ?? "").trim();
  if (!s) return null;
  const url = safeHttpsUrl(/^[a-z][a-z0-9+.-]*:/i.test(s) ? s : `https://${s}`);
  if (!url) throw new Error(`${label} must be an https:// link.`);
  return url;
}

export async function upsertPitchSubmission(patch: PitchPatch): Promise<ActionResult> {
  return runAction({ name: "upsertPitchSubmission" }, async () => {
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
    if (patch.deck_url !== undefined) row.deck_url = linkField(patch.deck_url, "Deck link");
    if (patch.video_url !== undefined) row.video_url = linkField(patch.video_url, "Video link");
    if (patch.notes !== undefined) {
      row.notes = (patch.notes ?? "").trim().slice(0, 2000) || null;
    }

    let { error } = await admin
      .from("pitch_submissions")
      .upsert(row, { onConflict: "team_id" });
    // Before migration 0094 there is no deck_url column. An empty deck field
    // shouldn't block saving the rest.
    if (error && isMissingSchemaError(error) && "deck_url" in row) {
      if (row.deck_url) {
        throw new Error("Deck links aren't available yet. Save the video link for now.");
      }
      delete row.deck_url;
      ({ error } = await admin.from("pitch_submissions").upsert(row, { onConflict: "team_id" }));
    }
    if (error) {
      console.error("[pitch] save failed", error);
      throw new Error("Couldn't save. Try again.");
    }
    revalidatePath("/dashboard/team");
  });
}

export async function submitPitch(input: { teamId: string }): Promise<ActionResult> {
  return runAction({ name: "submitPitch" }, async () => {
    const { userId } = await assertSelf();
    await assertTeamMember(userId, input.teamId);
    const admin = createAdminClient();

    // `*`, not a column list: deck_url only exists once 0094 is applied.
    const { data: existing } = await admin
      .from("pitch_submissions")
      .select("*")
      .eq("team_id", input.teamId)
      .maybeSingle();
    if (!existing?.deck_url && !existing?.video_url) {
      throw new Error("Add a deck or video link first.");
    }
    if (existing.submitted_at) return;

    const { error } = await admin
      .from("pitch_submissions")
      .update({ submitted_at: new Date().toISOString() })
      .eq("team_id", input.teamId);
    if (error) {
      console.error("[pitch] submit failed", error);
      throw new Error("Couldn't submit. Try again.");
    }

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
          link: `/admin/teams/${input.teamId}`,
        });
      }
    } catch {}

    revalidatePath("/dashboard/team");
    revalidatePath("/admin/teams");
    revalidatePath(`/admin/teams/${input.teamId}`);
  });
}
