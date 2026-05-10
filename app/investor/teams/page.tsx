import Link from "next/link";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireInvestor } from "@/lib/auth";
import { Card } from "@/components/ui/card";
import { InterestSelect } from "./interest-select";
import type { InvestorInterestLevel } from "@/lib/types";

export const metadata = { title: "Teams · Investor" };

export default async function InvestorTeamsPage({
  searchParams,
}: {
  searchParams: { cohort?: string };
}) {
  const profile = await requireInvestor();
  const admin = createAdminClient();
  const cohortFilter = searchParams.cohort ?? "all";

  const [{ data: cohorts }, { data: teams }, { data: interests }] =
    await Promise.all([
      admin.from("cohorts").select("id, name").order("starts_on"),
      admin
        .from("teams")
        .select("*, cohort:cohorts(id, name, slug)")
        .order("created_at", { ascending: false }),
      admin
        .from("investor_interests")
        .select("team_id, level")
        .eq("investor_id", profile.id),
    ]);

  const interestByTeam = new Map<string, InvestorInterestLevel>();
  for (const i of (interests ?? []) as any[]) {
    interestByTeam.set(i.team_id, i.level);
  }

  const filtered =
    cohortFilter === "all"
      ? teams ?? []
      : (teams ?? []).filter((t: any) => t.cohort_id === cohortFilter);

  return (
    <div className="mx-auto max-w-5xl">
      <h1 className="text-3xl font-bold tracking-tight">Teams</h1>
      <p className="mt-1 text-sm text-white/50">
        Every team in our cohorts. Mark interest to track them privately.
      </p>

      <div className="mt-6 flex flex-wrap items-center gap-2">
        <span className="text-xs uppercase tracking-wider text-white/40">
          Cohort
        </span>
        <Filter href="/investor/teams" label="All" active={cohortFilter === "all"} />
        {(cohorts ?? []).map((c: any) => (
          <Filter
            key={c.id}
            href={`/investor/teams?cohort=${c.id}`}
            label={c.name}
            active={cohortFilter === c.id}
          />
        ))}
      </div>

      <div className="mt-6 grid gap-3">
        {filtered.length === 0 && (
          <Card>
            <p className="text-sm text-white/50">No teams to show yet.</p>
          </Card>
        )}
        {filtered.map((t: any) => {
          const level = interestByTeam.get(t.id) ?? null;
          const cohort = Array.isArray(t.cohort) ? t.cohort[0] : t.cohort;
          const publicHref =
            cohort?.slug && t.is_public
              ? `/cohort/${cohort.slug}/teams/${t.slug}`
              : null;
          return (
            <Card key={t.id}>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-2">
                    <h3 className="text-base font-semibold text-white">
                      {t.name}
                    </h3>
                    <span className="text-xs text-white/40">
                      {cohort?.name ?? ""}
                    </span>
                  </div>
                  {t.tagline && (
                    <p className="mt-1 text-sm text-white/60">{t.tagline}</p>
                  )}
                  {t.description && (
                    <p className="mt-2 line-clamp-3 text-sm text-white/55">
                      {t.description}
                    </p>
                  )}
                  <div className="mt-3 flex flex-wrap gap-3 text-xs">
                    {t.pitch_deck_url && (
                      <a
                        href={t.pitch_deck_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-spark hover:underline"
                      >
                        Pitch deck →
                      </a>
                    )}
                    {t.pitch_video_url && (
                      <a
                        href={t.pitch_video_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-spark hover:underline"
                      >
                        Pitch video →
                      </a>
                    )}
                    {t.website_url && (
                      <a
                        href={t.website_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-spark hover:underline"
                      >
                        Website →
                      </a>
                    )}
                    {publicHref && (
                      <Link href={publicHref} className="text-white/60 hover:text-white">
                        Public profile →
                      </Link>
                    )}
                  </div>
                </div>
                <InterestSelect teamId={t.id} initialLevel={level} />
              </div>
            </Card>
          );
        })}
      </div>
    </div>
  );
}

function Filter({
  href,
  label,
  active,
}: {
  href: string;
  label: string;
  active: boolean;
}) {
  return (
    <Link
      href={href}
      className={`rounded-full border px-3 py-1 text-xs uppercase tracking-wider transition ${
        active
          ? "border-spark bg-spark/10 text-spark"
          : "border-white/15 text-white/60 hover:border-white/30 hover:text-white"
      }`}
    >
      {label}
    </Link>
  );
}
