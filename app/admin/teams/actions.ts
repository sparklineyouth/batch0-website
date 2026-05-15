"use server";
import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { assertStaff, assertAdmin } from "@/lib/server-guards";
import { logAudit } from "@/lib/audit";

function slugify(s: string) {
  return s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

export type RoundKind = "pre_seed" | "safe" | "seed" | "angel" | "grant" | "other";

export type TeamInput = {
  id?: string;
  cohort_id: string;
  name: string;
  tagline: string | null;
  description: string | null;
  logo_url: string | null;
  pitch_video_url: string | null;
  pitch_deck_url: string | null;
  website_url: string | null;
  is_public: boolean;
  public_blurb: string | null;
  demo_video_url: string | null;
  // Cap-table snapshot (optional). When every field is null the
  // investor view hides the cap-table block entirely so we don't
  // advertise "raised: —".
  raised_cents: number | null;
  post_money_cents: number | null;
  lead_investor: string | null;
  round_kind: RoundKind | null;
  round_closed_on: string | null;
};

export async function saveTeam(input: TeamInput) {
  await assertStaff();
  if (!input.name.trim()) throw new Error("Team name required");
  if (!input.cohort_id) throw new Error("Cohort required");

  const admin = createAdminClient();
  const slug = slugify(input.name);
  const payload = {
    cohort_id: input.cohort_id,
    name: input.name.trim(),
    slug,
    tagline: input.tagline?.trim() || null,
    description: input.description?.trim() || null,
    logo_url: input.logo_url?.trim() || null,
    pitch_video_url: input.pitch_video_url?.trim() || null,
    pitch_deck_url: input.pitch_deck_url?.trim() || null,
    website_url: input.website_url?.trim() || null,
    is_public: input.is_public,
    public_blurb: input.public_blurb?.trim() || null,
    demo_video_url: input.demo_video_url?.trim() || null,
    raised_cents: input.raised_cents,
    post_money_cents: input.post_money_cents,
    lead_investor: input.lead_investor?.trim() || null,
    round_kind: input.round_kind,
    round_closed_on: input.round_closed_on || null,
  };
  let id = input.id;
  if (id) {
    const { error } = await admin.from("teams").update(payload).eq("id", id);
    if (error) throw new Error(error.message);
  } else {
    const { data: created, error } = await admin
      .from("teams")
      .insert(payload)
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    id = created!.id;
  }
  await logAudit({
    action: input.id ? "team.updated" : "team.created",
    targetType: "team",
    targetId: id ?? null,
    payload: { name: input.name },
  });
  revalidatePath("/admin/teams");
  return id!;
}

export async function deleteTeam(id: string) {
  await assertAdmin();
  const admin = createAdminClient();
  const { error } = await admin.from("teams").delete().eq("id", id);
  if (error) throw new Error(error.message);
  await logAudit({
    action: "team.deleted",
    targetType: "team",
    targetId: id,
  });
  revalidatePath("/admin/teams");
}

export async function addTeamMember(args: {
  teamId: string;
  userId: string;
  role: string;
}) {
  await assertStaff();
  const admin = createAdminClient();
  const { error } = await admin.from("team_members").upsert(
    {
      team_id: args.teamId,
      user_id: args.userId,
      role: args.role || "member",
    },
    { onConflict: "team_id,user_id" },
  );
  if (error) throw new Error(error.message);
  revalidatePath("/admin/teams");
}

export async function removeTeamMember(memberId: string) {
  await assertStaff();
  const admin = createAdminClient();
  const { error } = await admin
    .from("team_members")
    .delete()
    .eq("id", memberId);
  if (error) throw new Error(error.message);
  revalidatePath("/admin/teams");
}
