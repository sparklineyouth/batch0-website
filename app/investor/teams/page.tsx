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
      <h1 className="font-display text-3xl font-bold tracking-[-0.02em] text-ink">Teams</h1>
      <p className="mt-1 text-sm text-ink-faint">
        Every team in our cohorts. Mark interest to track them privately.
      </p>

      <div className="mt-6 flex flex-wrap items-center gap-2">
        <span className="font-mono text-xs uppercase tracking-wider text-ink-faint">
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
            <p className="text-sm text-ink-faint">No teams to show yet.</p>
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
                    <Link
                      href={`/investor/teams/${t.id}`}
                      className="font-display text-base font-semibold tracking-[-0.02em] text-ink hover:text-phosphor-ink"
                    >
                      {t.name}
                    </Link>
                    <span className="text-xs text-ink-faint">
                      {cohort?.name ?? ""}
                    </span>
                  </div>
                  {t.tagline && (
                    <p className="mt-1 text-sm text-ink-soft">{t.tagline}</p>
                  )}
                  {t.description && (
                    <p className="mt-2 line-clamp-3 text-sm text-ink-soft">
                      {t.description}
                    </p>
                  )}
                  <div className="mt-3 flex flex-wrap gap-3 text-xs">
                    {t.pitch_deck_url && (
                      <a
                        href={t.pitch_deck_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-phosphor-ink hover:underline"
                      >
                        Pitch deck →
                      </a>
                    )}
                    {t.pitch_video_url && (
                      <a
                        href={t.pitch_video_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-phosphor-ink hover:underline"
                      >
                        Pitch video →
                      </a>
                    )}
                    {t.website_url && (
                      <a
                        href={t.website_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-phosphor-ink hover:underline"
                      >
                        Website →
                      </a>
                    )}
                    {publicHref && (
                      <Link href={publicHref} className="text-ink-soft hover:text-ink">
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
      className={`rounded-full border px-3 py-1 font-mono text-xs uppercase tracking-wider transition ${
        active
          ? "border-phosphor bg-phosphor/10 text-phosphor-ink"
          : "border-line text-ink-soft hover:border-ink/30 hover:text-ink"
      }`}
    >
      {label}
    </Link>
  );
}
