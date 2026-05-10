import Link from "next/link";
import { notFound } from "next/navigation";
import { createAdminClient } from "@/lib/supabase/admin";
import { Card } from "@/components/ui/card";
import { TeamForm } from "../team-form";
import { MembersManager } from "./members-manager";

export const metadata = { title: "Edit team · Admin" };

export default async function AdminTeamDetail({
  params,
}: {
  params: { id: string };
}) {
  const admin = createAdminClient();
  const [{ data: team }, { data: cohorts }, { data: members }, { data: students }] =
    await Promise.all([
      admin.from("teams").select("*").eq("id", params.id).maybeSingle(),
      admin.from("cohorts").select("id, name").order("starts_on"),
      admin
        .from("team_members")
        .select(
          "id, role, user_id, user:profiles(email, full_name)",
        )
        .eq("team_id", params.id),
      admin
        .from("profiles")
        .select("id, email, full_name")
        .in("role", ["student", "mentor", "admin"])
        .order("created_at", { ascending: false }),
    ]);

  if (!team) notFound();

  return (
    <div className="mx-auto max-w-3xl">
      <Link href="/admin/teams" className="text-sm text-white/55 hover:text-white">
        ← All teams
      </Link>
      <h1 className="mt-3 text-3xl font-bold tracking-tight">{team.name}</h1>
      <p className="mt-1 text-sm text-white/55">
        {team.is_public ? "Public" : "Private"} · slug{" "}
        <code className="rounded bg-white/5 px-1.5">{team.slug}</code>
      </p>

      <Card className="mt-6">
        <TeamForm
          initial={{
            id: team.id,
            cohort_id: team.cohort_id,
            name: team.name,
            tagline: team.tagline,
            description: team.description,
            logo_url: team.logo_url,
            pitch_video_url: team.pitch_video_url,
            pitch_deck_url: team.pitch_deck_url,
            website_url: team.website_url,
            is_public: team.is_public,
          }}
          cohorts={cohorts ?? []}
        />
      </Card>

      <Card className="mt-6">
        <h2 className="mb-4 text-sm font-semibold uppercase tracking-wider text-white/55">
          Members
        </h2>
        <MembersManager
          teamId={team.id}
          members={(members ?? []) as any}
          students={(students ?? []) as any}
        />
      </Card>
    </div>
  );
}
