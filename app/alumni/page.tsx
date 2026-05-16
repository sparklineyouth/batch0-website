import Link from "next/link";
import { createAdminClient } from "@/lib/supabase/admin";
import Navbar from "@/components/navbar";
import Footer from "@/components/footer";
import { ExternalLink, Calendar } from "lucide-react";

export const metadata = {
  title: "Alumni · SparkLine Youth",
  description:
    "Teams that graduated from past SparkLine Youth cohorts and what they're building today.",
};

export const dynamic = "force-dynamic";

// Distinct from /showcase (current cohorts, founder spotlights). This
// route is the "after the program" public face: completed cohorts only,
// emphasis on graduation year + ongoing links. Team-level info, not
// individual names — we don't have an explicit opt-in for showing
// student names publicly, and these are high-school founders.
export default async function AlumniPage() {
  const admin = createAdminClient();

  const { data: completedCohorts } = await admin
    .from("cohorts")
    .select("id, name, slug, starts_on, ends_on, status")
    .eq("status", "completed")
    .order("ends_on", { ascending: false, nullsFirst: false });

  const cohortIds = (completedCohorts ?? []).map((c: any) => c.id);

  const { data: teams } = cohortIds.length
    ? await admin
        .from("teams")
        .select(
          "id, name, slug, tagline, logo_url, website_url, cohort_id",
        )
        .eq("is_public", true)
        .in("cohort_id", cohortIds)
        .order("name")
    : { data: [] };

  const teamsByCohort = new Map<string, any[]>();
  for (const t of teams ?? []) {
    const arr = teamsByCohort.get(t.cohort_id) ?? [];
    arr.push(t);
    teamsByCohort.set(t.cohort_id, arr);
  }

  // Strip empty cohorts so we don't render headers for cohorts that
  // have no public teams yet — that would look like the program shipped
  // nothing.
  const renderedCohorts = (completedCohorts ?? []).filter((c: any) =>
    (teamsByCohort.get(c.id) ?? []).length > 0,
  );
  const totalTeams = (teams ?? []).length;

  return (
    <main className="relative min-h-screen overflow-hidden bg-black text-white">
      <Navbar />
      <section className="relative mx-auto max-w-6xl px-6 pt-32 pb-20">
        <p className="text-sm font-medium uppercase tracking-[0.2em] text-spark">
          Alumni
        </p>
        <h1 className="mt-3 text-4xl font-bold tracking-tight md:text-6xl">
          What our founders built.
        </h1>
        <p className="mt-5 max-w-2xl text-lg text-white/65">
          Every team below shipped something real during a SparkLine Youth cohort.
          Many are still building.
        </p>

        {renderedCohorts.length === 0 ? (
          <div className="mt-16 rounded-2xl border border-white/10 bg-zinc-900/40 px-6 py-12 text-center">
            <p className="text-base text-white/65">
              The first SparkLine Youth cohort is still in flight. Once it wraps,
              its alumni will land here.
            </p>
            <Link
              href="/apply"
              className="mt-6 inline-flex items-center gap-2 rounded-lg bg-spark px-4 py-2 text-sm font-semibold text-black hover:bg-spark-200"
            >
              Apply to the next cohort
            </Link>
          </div>
        ) : (
          <>
            <p className="mt-2 text-sm text-white/45">
              {totalTeams} {totalTeams === 1 ? "team" : "teams"} ·{" "}
              {renderedCohorts.length}{" "}
              {renderedCohorts.length === 1 ? "cohort" : "cohorts"}
            </p>

            <div className="mt-12 space-y-16">
              {renderedCohorts.map((c: any) => {
                const cohortTeams = teamsByCohort.get(c.id) ?? [];
                const year = c.ends_on
                  ? new Date(c.ends_on).getUTCFullYear()
                  : null;
                return (
                  <div key={c.id}>
                    <div className="flex flex-wrap items-baseline justify-between gap-3 border-b border-white/10 pb-3">
                      <div>
                        <h2 className="text-2xl font-semibold tracking-tight">
                          {c.name}
                        </h2>
                        {year && (
                          <p className="mt-1 inline-flex items-center gap-1.5 text-xs text-white/45">
                            <Calendar className="h-3 w-3" />
                            Graduated {year}
                          </p>
                        )}
                      </div>
                      {c.slug && (
                        <Link
                          href={`/cohort/${c.slug}`}
                          className="text-sm text-spark hover:underline"
                        >
                          View showcase →
                        </Link>
                      )}
                    </div>
                    <div className="mt-5 grid gap-4 md:grid-cols-2 lg:grid-cols-3">
                      {cohortTeams.map((t: any) => (
                        <TeamCard
                          key={t.id}
                          team={t}
                          cohortSlug={c.slug ?? null}
                        />
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          </>
        )}
      </section>
      <Footer />
    </main>
  );
}

function TeamCard({
  team,
  cohortSlug,
}: {
  team: {
    name: string;
    slug: string | null;
    tagline: string | null;
    logo_url: string | null;
    website_url: string | null;
  };
  cohortSlug: string | null;
}) {
  // Prefer the in-house team page (always available) over the team's
  // own website (may have gone dark since the cohort) — and surface
  // the website as a secondary link if present.
  const internalHref =
    cohortSlug && team.slug
      ? `/cohort/${cohortSlug}/teams/${team.slug}`
      : null;
  return (
    <div className="group rounded-2xl border border-white/10 bg-zinc-900/40 p-5 transition hover:border-spark/30 hover:bg-zinc-900/60">
      <div className="flex items-center gap-3">
        {team.logo_url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={team.logo_url}
            alt=""
            className="h-12 w-12 rounded-lg border border-white/10 bg-white object-contain p-1"
          />
        ) : (
          <div className="grid h-12 w-12 place-items-center rounded-lg border border-white/10 bg-zinc-800 text-base font-semibold uppercase text-white/60">
            {team.name.slice(0, 1)}
          </div>
        )}
        <div className="min-w-0 flex-1">
          {internalHref ? (
            <Link
              href={internalHref}
              className="block truncate text-base font-semibold text-white group-hover:text-spark"
            >
              {team.name}
            </Link>
          ) : (
            <span className="block truncate text-base font-semibold text-white">
              {team.name}
            </span>
          )}
        </div>
      </div>
      {team.tagline && (
        <p className="mt-3 text-sm text-white/60 line-clamp-3">
          {team.tagline}
        </p>
      )}
      <div className="mt-4 flex flex-wrap gap-3 text-xs">
        {internalHref && (
          <Link
            href={internalHref}
            className="text-spark hover:underline"
          >
            Profile →
          </Link>
        )}
        {team.website_url && (
          <a
            href={team.website_url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-white/55 hover:text-white"
          >
            Website
            <ExternalLink className="h-3 w-3" />
          </a>
        )}
      </div>
    </div>
  );
}
