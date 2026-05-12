import Link from "next/link";
import { notFound } from "next/navigation";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireInvestor } from "@/lib/auth";
import { Card } from "@/components/ui/card";
import { TeamThread } from "@/components/team-thread";
import { ScoreCard } from "./score-card";
import { IntroRequestButton } from "./intro-request-button";
import { ArrowLeft } from "lucide-react";

export const metadata = { title: "Team · Investor" };

export default async function InvestorTeamDetailPage({
  params,
}: {
  params: { id: string };
}) {
  const profile = await requireInvestor();
  const admin = createAdminClient();

  const { data: team } = await admin
    .from("teams")
    .select(
      "id, name, tagline, description, logo_url, logo_status, website_url, cohort:cohorts(name)",
    )
    .eq("id", params.id)
    .maybeSingle();
  if (!team) notFound();

  const [
    { data: members },
    { data: messages },
    { data: pitch },
    { data: myScore },
    { data: myIntro },
  ] = await Promise.all([
    admin
      .from("team_members")
      .select("user_id, role, profile:profiles(full_name)")
      .eq("team_id", params.id),
    admin
      .from("team_messages")
      .select("id, body, kind, created_at, author:profiles(full_name, email)")
      .eq("team_id", params.id)
      .order("created_at", { ascending: true })
      .limit(200),
    admin
      .from("pitch_submissions")
      .select("*")
      .eq("team_id", params.id)
      .maybeSingle(),
    admin
      .from("pitch_scores")
      .select("*")
      .eq("team_id", params.id)
      .eq("scorer_id", profile.id)
      .maybeSingle(),
    admin
      .from("intro_requests")
      .select("*")
      .eq("team_id", params.id)
      .eq("investor_id", profile.id)
      .maybeSingle(),
  ]);

  const cohort = Array.isArray(team.cohort) ? team.cohort[0] : team.cohort;

  return (
    <div className="mx-auto max-w-4xl">
      <Link
        href="/investor/teams"
        className="inline-flex items-center gap-1 text-xs text-white/50 hover:text-white"
      >
        <ArrowLeft className="h-3 w-3" /> Teams
      </Link>
      <header className="mt-3 flex items-start gap-4">
        <div className="flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-2xl border border-white/10 bg-zinc-900">
          {team.logo_url && team.logo_status === "approved" ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={team.logo_url} alt="" className="h-full w-full object-cover" />
          ) : (
            <span className="text-2xl font-bold text-spark">
              {team.name.slice(0, 1).toUpperCase()}
            </span>
          )}
        </div>
        <div className="min-w-0 flex-1">
          <h1 className="text-2xl font-bold tracking-tight md:text-3xl">
            {team.name}
          </h1>
          {team.tagline && (
            <p className="text-sm text-white/55">{team.tagline}</p>
          )}
          <p className="mt-1 text-xs text-white/40">{cohort?.name ?? ""}</p>
        </div>
        <IntroRequestButton
          teamId={params.id}
          existing={(myIntro as any) ?? null}
        />
      </header>

      {team.description && (
        <Card className="mt-6">
          <h2 className="text-base font-semibold">About</h2>
          <p className="mt-2 whitespace-pre-wrap text-sm text-white/75">
            {team.description}
          </p>
        </Card>
      )}

      <Card className="mt-6">
        <h2 className="text-base font-semibold">Team</h2>
        <ul className="mt-3 space-y-2">
          {(members ?? []).map((m: any) => {
            const p = Array.isArray(m.profile) ? m.profile[0] : m.profile;
            return (
              <li key={m.user_id} className="text-sm text-white/85">
                {p?.full_name ?? "—"}{" "}
                <span className="text-xs text-white/40">· {m.role}</span>
              </li>
            );
          })}
        </ul>
      </Card>

      {pitch && (
        <Card className="mt-6">
          <h2 className="text-base font-semibold">Pitch</h2>
          {(pitch as any).submitted_at ? (
            <div className="mt-1 text-xs text-emerald-300">
              Submitted on{" "}
              {new Date((pitch as any).submitted_at).toLocaleString()}
            </div>
          ) : (
            <div className="mt-1 text-xs text-white/40">In progress</div>
          )}
          <div className="mt-3 flex flex-wrap gap-3 text-sm">
            {(pitch as any).video_url && (
              <a
                href={(pitch as any).video_url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-spark hover:underline"
              >
                Watch video →
              </a>
            )}
            {(pitch as any).deck_path && (
              <span className="text-white/60">
                Deck uploaded (open via team drive)
              </span>
            )}
            {(pitch as any).video_path && !(pitch as any).video_url && (
              <span className="text-white/60">Video uploaded</span>
            )}
          </div>
          {(pitch as any).notes && (
            <p className="mt-3 whitespace-pre-wrap text-sm text-white/65">
              {(pitch as any).notes}
            </p>
          )}
        </Card>
      )}

      <div className="mt-6">
        <ScoreCard teamId={params.id} existing={(myScore as any) ?? null} />
      </div>

      <div className="mt-6">
        <TeamThread teamId={params.id} messages={(messages ?? []) as any[]} />
      </div>
    </div>
  );
}
