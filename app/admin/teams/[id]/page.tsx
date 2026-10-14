import Link from "next/link";
import { notFound } from "next/navigation";
import { createAdminClient } from "@/lib/supabase/admin";
import { Card } from "@/components/ui/card";
import { LocalTime } from "@/components/ui/local-time";
import { TeamForm } from "../team-form";
import { MembersManager } from "./members-manager";
import { TearSheetCard } from "./tear-sheet-button";
import { CapTable } from "./cap-table";
import { GoogleDrivePanel } from "@/components/team/google-drive-panel";
import { PitchLinkPreview } from "@/components/team/pitch-links";
import { loadTeamDrive } from "@/lib/team-drive";
import { getCapabilities } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { RecapButton } from "@/app/admin/demo-day/recap-button";

export const metadata = { title: "Edit team · Admin" };

export default async function AdminTeamDetail(
  props: {
    params: Promise<{ id: string }>;
  }
) {
  const params = await props.params;
  const admin = createAdminClient();
  const [
    { data: team },
    { data: cohorts },
    { data: members },
    { data: students },
    { data: capRows },
    { data: pitch },
    drive,
    caps,
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
    // `*`: deck_url only exists once migration 0094 is applied.
    admin.from("pitch_submissions").select("*").eq("team_id", params.id).maybeSingle(),
    loadTeamDrive(admin, params.id),
    getCapabilities(),
  ]);

  if (!team) notFound();
  const p = pitch as
    | { deck_url?: string | null; video_url: string | null; notes: string | null; submitted_at: string | null }
    | null;

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

      {p && (p.deck_url || p.video_url || p.submitted_at) && (
        <Card className="mt-6">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-ink-faint">
            Demo Day submission
          </h2>
          {p.submitted_at ? (
            <div className="mt-1 text-xs text-emerald-700 dark:text-emerald-300">
              Submitted on <LocalTime value={p.submitted_at} />
            </div>
          ) : (
            <div className="mt-1 text-xs text-ink-faint">Draft</div>
          )}
          <PitchLinkPreview url={p.deck_url} title="Pitch deck" collapsed className="mt-3" />
          <PitchLinkPreview url={p.video_url} title="Pitch video" collapsed className="mt-2" />
          {p.notes && <p className="mt-3 whitespace-pre-wrap text-sm text-ink-soft">{p.notes}</p>}
        </Card>
      )}

      {/* Editable for teams.manage, so an admin can fix a wrong folder link.
          The actions re-check teams.manage and audit-log every edit by a
          non-member (docs/google-drive.md); mentors get it read-only. */}
      <GoogleDrivePanel
        className="mt-6"
        teamId={team.id}
        drive={drive}
        canEdit={can(caps, "teams.manage")}
      />

      <Card className="mt-6">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-ink-faint">
          Demo Day recap
        </h2>
        <p className="mt-1 text-xs text-ink-faint">
          AI recap from scores and reactions. Emails every member.
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
