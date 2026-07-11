import Link from "next/link";
import { notFound } from "next/navigation";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireInvestor } from "@/lib/auth";
import { Card } from "@/components/ui/card";
import { LocalTime } from "@/components/ui/local-time";
import { TeamThread } from "@/components/team-thread";
import { ScoreCard } from "./score-card";
import { RubricScoreCard } from "./rubric-score-card";
import { IntroRequestButton } from "./intro-request-button";
import { ReactionStrip } from "@/components/demo-day/reaction-strip";
import { SafeOfferForm } from "./safe-offer-form";
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
      "id, name, tagline, description, logo_url, logo_status, website_url, raised_cents, post_money_cents, lead_investor, round_kind, round_closed_on, tear_sheet, tear_sheet_generated_at, cohort_id, cohort:cohorts(name)",
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
    { data: rubric },
    { data: myRubricScores },
    { data: rxnRows },
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
    admin
      .from("demo_day_rubric_criteria")
      .select("id, label, description, weight, max_score, cohort_id")
      .order("position", { ascending: true }),
    admin
      .from("demo_day_scores")
      .select("criterion_id, score, comment")
      .eq("team_id", params.id)
      .eq("judge_id", profile.id),
    admin
      .from("demo_day_reactions")
      .select("emoji")
      .eq("team_id", params.id),
  ]);

  // Cohort-scoped rubric: criteria with cohort_id null apply to all.
  const teamCohortId = (team as any).cohort_id ?? null;
  const applicableRubric = (rubric ?? []).filter(
    (c: any) => !c.cohort_id || c.cohort_id === teamCohortId,
  );
  const reactionCounts: Record<string, number> = {};
  for (const r of (rxnRows ?? []) as any[]) {
    reactionCounts[r.emoji] = (reactionCounts[r.emoji] ?? 0) + 1;
  }

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
          viewerRole={profile.role === "admin" ? "admin" : "investor"}
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

      <CapTableBlock
        raisedCents={(team as any).raised_cents}
        postMoneyCents={(team as any).post_money_cents}
        leadInvestor={(team as any).lead_investor}
        roundKind={(team as any).round_kind}
        roundClosedOn={(team as any).round_closed_on}
      />

      {(team as any).tear_sheet && (
        <Card className="mt-6">
          <div className="flex items-baseline justify-between gap-3">
            <h2 className="text-base font-semibold">Tear sheet</h2>
            {(team as any).tear_sheet_generated_at && (
              <span className="text-[11px] text-white/40">
                AI-generated · updated{" "}
                <LocalTime
                  value={(team as any).tear_sheet_generated_at}
                  mode="date"
                />
              </span>
            )}
          </div>
          <p className="mt-3 whitespace-pre-wrap text-sm text-white/85">
            {(team as any).tear_sheet}
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
              Submitted on <LocalTime value={(pitch as any).submitted_at} />
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

      <Card className="mt-6">
        <h2 className="text-base font-semibold">Audience reactions</h2>
        <p className="mt-1 text-xs text-white/50">
          Live during Demo Day. Aggregated counts visible to admins.
        </p>
        <div className="mt-3">
          <ReactionStrip teamId={params.id} initialCounts={reactionCounts} />
        </div>
      </Card>

      <div className="mt-6">
        {applicableRubric.length > 0 ? (
          <RubricScoreCard
            teamId={params.id}
            criteria={applicableRubric as any}
            existing={(myRubricScores ?? []) as any}
          />
        ) : (
          <ScoreCard teamId={params.id} existing={(myScore as any) ?? null} />
        )}
      </div>

      <div className="mt-6">
        <SafeOfferForm teamId={params.id} />
      </div>

      <div className="mt-6">
        <TeamThread teamId={params.id} messages={(messages ?? []) as any[]} />
      </div>
    </div>
  );
}

const ROUND_LABEL: Record<string, string> = {
  pre_seed: "Pre-seed",
  safe: "SAFE",
  angel: "Angel",
  seed: "Seed",
  grant: "Grant",
  other: "Other",
};

function fmtUsd(cents: number) {
  // Compact for figures over $1M so the tile doesn't run out of room
  // (e.g. "$1.5M post-money"). Below that, full dollar amount with
  // grouping reads better.
  if (cents >= 1_000_000_00) {
    return `$${(cents / 100_000_000).toFixed(cents % 100_000_000 === 0 ? 0 : 1)}M`;
  }
  if (cents >= 100_000_00) {
    return `$${Math.round(cents / 100_000) / 10}M`;
  }
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(cents / 100);
}

function CapTableBlock({
  raisedCents,
  postMoneyCents,
  leadInvestor,
  roundKind,
  roundClosedOn,
}: {
  raisedCents: number | null;
  postMoneyCents: number | null;
  leadInvestor: string | null;
  roundKind: string | null;
  roundClosedOn: string | null;
}) {
  // If the team hasn't filled in any cap-table fields, hide the block —
  // showing "Raised: —" implies a failure to raise, which we don't want.
  if (!raisedCents && !postMoneyCents && !leadInvestor && !roundKind) {
    return null;
  }
  return (
    <Card className="mt-6">
      <h2 className="text-base font-semibold">Cap-table snapshot</h2>
      <p className="mt-1 text-[11px] text-white/40">
        Self-reported by the team. Not audited by Sparkline Youth.
      </p>
      <div className="mt-4 grid gap-4 sm:grid-cols-4">
        {roundKind && (
          <CapField
            label="Round"
            value={ROUND_LABEL[roundKind] ?? roundKind}
          />
        )}
        {raisedCents != null && (
          <CapField label="Raised" value={fmtUsd(raisedCents)} tone="spark" />
        )}
        {postMoneyCents != null && (
          <CapField label="Post-money" value={fmtUsd(postMoneyCents)} />
        )}
        {roundClosedOn && (
          <CapField
            label="Closed"
            value={new Date(`${roundClosedOn}T00:00:00Z`).toLocaleDateString(
              "en-US",
              { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" },
            )}
          />
        )}
      </div>
      {leadInvestor && (
        <p className="mt-4 text-sm text-white/75">
          <span className="text-xs uppercase tracking-wider text-white/45">
            Lead{" "}
          </span>
          <span className="ml-1">{leadInvestor}</span>
        </p>
      )}
    </Card>
  );
}

function CapField({
  label,
  value,
  tone = "default",
}: {
  label: string;
  value: string;
  tone?: "default" | "spark";
}) {
  return (
    <div>
      <div className="text-[10px] font-medium uppercase tracking-[0.2em] text-white/45">
        {label}
      </div>
      <div
        className={`mt-1 text-lg font-semibold tracking-tight ${
          tone === "spark" ? "text-spark" : "text-white"
        }`}
      >
        {value}
      </div>
    </div>
  );
}
