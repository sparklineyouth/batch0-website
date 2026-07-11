import Link from "next/link";
import { notFound } from "next/navigation";
import { createAdminClient } from "@/lib/supabase/admin";
import { Card } from "@/components/ui/card";
import { TeamForm } from "../team-form";
import { MembersManager } from "./members-manager";
import { TearSheetCard } from "./tear-sheet-button";
import { CapTable } from "./cap-table";
import { RecapButton } from "@/app/admin/demo-day/recap-button";

export const metadata = { title: "Edit team · Admin" };

export default async function AdminTeamDetail({
  params,
}: {
  params: { id: string };
}) {
  const admin = createAdminClient();
  const [
    { data: team },
    { data: cohorts },
    { data: members },
    { data: students },
    { data: capRows },
  ] = await Promise.all([
    admin.from("teams").select("*").eq("id", params.id).maybeSingle(),
    admin.from("cohorts").select("id, name").order("starts_on"),
    admin
      .from("team_members")
      .select("id, role, user_id, user:profiles(email, full_name)")
      .eq("team_id", params.id),
    admin
      .from("profiles")
      .select("id, email, full_name")
      .in("role", ["student", "mentor", "admin"])
      .order("created_at", { ascending: false }),
    admin
      .from("cap_table_holders")
      .select("*")
      .eq("team_id", params.id)
      .order("created_at", { ascending: true }),
  ]);

  if (!team) notFound();

  return (
    <div className="mx-auto max-w-3xl">
      <Link href="/admin/teams" className="text-sm text-ink-faint hover:text-ink">
        ← All teams
      </Link>
      <h1 className="mt-3 font-display text-3xl font-bold tracking-[-0.02em] text-ink">{team.name}</h1>
      <p className="mt-1 text-sm text-ink-soft">
        {team.is_public ? "Public" : "Private"} · slug{" "}
        <code className="rounded bg-wash px-1.5 font-mono text-ink-soft">{team.slug}</code>
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
            public_blurb: (team as any).public_blurb ?? null,
            demo_video_url: (team as any).demo_video_url ?? null,
            raised_cents: team.raised_cents ?? null,
            post_money_cents: team.post_money_cents ?? null,
            lead_investor: team.lead_investor ?? null,
            round_kind: team.round_kind ?? null,
            round_closed_on: team.round_closed_on ?? null,
          }}
          cohorts={cohorts ?? []}
        />
      </Card>

      <Card className="mt-6">
        <h2 className="mb-4 text-sm font-semibold uppercase tracking-wider text-ink-faint">
          Members
        </h2>
        <MembersManager
          teamId={team.id}
          members={(members ?? []) as any}
          students={(students ?? []) as any}
        />
      </Card>

      <Card className="mt-6">
        <CapTable
          teamId={team.id}
          rows={(capRows ?? []) as any}
          members={
            (members ?? []).map((m: any) => ({
              id: m.user_id,
              full_name: m.user?.full_name ?? null,
              email: m.user?.email ?? null,
            })) ?? []
          }
        />
      </Card>

      <Card className="mt-6">
        <TearSheetCard
          teamId={team.id}
          existing={team.tear_sheet ?? null}
          generatedAt={team.tear_sheet_generated_at ?? null}
        />
      </Card>

      <Card className="mt-6">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-ink-faint">
          Demo Day recap
        </h2>
        <p className="mt-1 text-xs text-ink-faint">
          AI-written narrative pulled from judge scores + comments + audience
          reactions. Emails every member when sent.
        </p>
        {(team as any).demo_day_recap && (
          <p className="mt-3 max-h-48 overflow-auto whitespace-pre-wrap rounded-lg border border-line bg-wash p-3 text-xs text-ink-soft">
            {(team as any).demo_day_recap}
          </p>
        )}
        <div className="mt-3">
          <RecapButton
            teamId={team.id}
            existing={(team as any).demo_day_recap ?? null}
          />
        </div>
      </Card>
    </div>
  );
}
