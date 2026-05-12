"use server";
import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { assertAdmin } from "@/lib/server-guards";
import { logAudit } from "@/lib/audit";
import { notify } from "@/lib/notifications";

export async function approveTeamLogo(input: { teamId: string }) {
  await assertAdmin();
  const admin = createAdminClient();
  const { data: team } = await admin
    .from("teams")
    .select("name")
    .eq("id", input.teamId)
    .maybeSingle();
  const { error } = await admin
    .from("teams")
    .update({
      logo_status: "approved",
      logo_rejected_reason: null,
    })
    .eq("id", input.teamId);
  if (error) throw new Error(error.message);
  await logAudit({
    action: "team_logo.approved",
    targetType: "team",
    targetId: input.teamId,
    payload: null,
  });

  // Tell the team it's approved.
  const { data: members } = await admin
    .from("team_members")
    .select("user_id")
    .eq("team_id", input.teamId);
  for (const m of members ?? []) {
    await notify({
      userId: m.user_id,
      type: "team_logo_approved",
      title: "Your team logo was approved",
      body: team?.name ? `${team.name}'s logo is now public.` : null,
      link: "/dashboard/team",
    });
  }
  revalidatePath("/admin/moderation");
  revalidatePath("/dashboard/team");
}

export async function rejectTeamLogo(input: {
  teamId: string;
  reason: string;
}) {
  await assertAdmin();
  const reason = (input.reason ?? "").trim().slice(0, 240);
  const admin = createAdminClient();

  // Pull the current logo URL so we can delete the rejected bytes from
  // the public bucket — keeping them around means anyone with the URL
  // can still view it after rejection.
  const { data: existing } = await admin
    .from("teams")
    .select("logo_url")
    .eq("id", input.teamId)
    .maybeSingle();

  const { error } = await admin
    .from("teams")
    .update({
      logo_url: null,
      logo_status: "rejected",
      logo_rejected_reason: reason || "Unsuitable image.",
    })
    .eq("id", input.teamId);
  if (error) throw new Error(error.message);

  // Best-effort: derive the storage path from the public URL and remove
  // the object. The public URL has the form `.../team-logos/<path>`.
  if (existing?.logo_url) {
    const marker = "/team-logos/";
    const idx = existing.logo_url.indexOf(marker);
    if (idx >= 0) {
      const storagePath = existing.logo_url.slice(idx + marker.length);
      await admin.storage.from("team-logos").remove([storagePath]);
    }
  }
  await logAudit({
    action: "team_logo.rejected",
    targetType: "team",
    targetId: input.teamId,
    payload: { reason },
  });
  const { data: members } = await admin
    .from("team_members")
    .select("user_id")
    .eq("team_id", input.teamId);
  for (const m of members ?? []) {
    await notify({
      userId: m.user_id,
      type: "team_logo_rejected",
      title: "Team logo needs changes",
      body: reason || "Upload a different logo.",
      link: "/dashboard/team",
    });
  }
  revalidatePath("/admin/moderation");
  revalidatePath("/dashboard/team");
}
