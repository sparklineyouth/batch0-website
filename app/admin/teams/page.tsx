import Link from "next/link";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireAdminPath } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { Card } from "@/components/ui/card";
import { Plus, Globe, EyeOff } from "lucide-react";
import { LogoReviewCard } from "./logo-review-card";

export const metadata = { title: "Teams · Admin" };

/**
 * The team list, with the logo review queue on top (it used to be its own
 * "Moderation" page). The page opens on teams.manage or moderation.manage
 * (ADMIN_EXACT_ROUTE_PERMISSIONS); each part shows only to holders of its key.
 */
export default async function AdminTeamsPage(
  props: {
    searchParams: Promise<{ cohort?: string }>;
  }
) {
  const searchParams = await props.searchParams;
  const { caps } = await requireAdminPath("/admin/teams");
  const manageTeams = can(caps, "teams.manage");
  const moderate = can(caps, "moderation.manage");
  const admin = createAdminClient();
  const cohortFilter = searchParams.cohort ?? "all";

  const [{ data: cohorts }, { data: teams }, { data: pendingLogos }] = await Promise.all([
    manageTeams
      ? admin.from("cohorts").select("id, name, slug").order("starts_on")
      : { data: [] },
    manageTeams
      ? admin
          .from("teams")
          .select(
            "id, name, slug, tagline, is_public, cohort_id, cohort:cohorts(name, slug), team_members(count)",
          )
          .order("created_at", { ascending: false })
      : { data: [] },
    moderate
      ? admin
          .from("teams")
          .select("id, name, slug, logo_url, logo_rejected_reason, updated_at, cohort:cohorts(name)")
          .eq("logo_status", "pending")
          .not("logo_url", "is", null)
          .order("updated_at", { ascending: false })
      : { data: [] },
  ]);

  const filtered =
    cohortFilter === "all"
      ? teams ?? []
      : (teams ?? []).filter((t: any) => t.cohort_id === cohortFilter);
  const logos = (pendingLogos ?? []) as any[];

  return (
    <div className="mx-auto max-w-5xl">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="font-display text-3xl font-bold tracking-[-0.02em] text-ink">Teams</h1>
          <p className="mt-1 text-sm text-ink-soft">
            Cohort startups.
          </p>
        </div>
        {manageTeams && (
          <Link
            href="/admin/teams/new"
            className="inline-flex h-10 items-center gap-2 rounded-md bg-phosphor px-4 text-sm font-semibold text-on-phosphor shadow-cta hover:bg-phosphor-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-phosphor focus-visible:ring-offset-2 focus-visible:ring-offset-paper"
          >
            <Plus className="h-4 w-4" /> New team
          </Link>
        )}
      </div>

      {moderate && (logos.length > 0 || !manageTeams) && (
        <section id="logos" className="mt-6 scroll-mt-24">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-ink-faint">
            Logos to review{logos.length > 0 ? ` (${logos.length})` : ""}
          </h2>
          {logos.length === 0 ? (
            <p className="mt-2 text-sm text-ink-faint">No logos pending review.</p>
          ) : (
            <>
              <p className="mt-1 text-xs text-ink-faint">
                Reject anything not safe for a high-school audience.
              </p>
              <div className="mt-3 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {logos.map((t) => (
                  <LogoReviewCard key={t.id} team={t} />
                ))}
              </div>
            </>
          )}
        </section>
      )}

      {manageTeams && (
        <>
          <div className="mt-6 flex flex-wrap items-center gap-2">
            <span className="text-xs uppercase tracking-wider text-ink-faint">
              Cohort
            </span>
            <Filter href="/admin/teams" label="All" active={cohortFilter === "all"} />
            {(cohorts ?? []).map((c: any) => (
              <Filter
                key={c.id}
                href={`/admin/teams?cohort=${c.id}`}
                label={c.name}
                active={cohortFilter === c.id}
              />
            ))}
          </div>

          <div className="mt-6 grid gap-3">
            {filtered.length === 0 && (
              <Card>
                <p className="text-sm text-ink-soft">No teams yet.</p>
              </Card>
            )}
            {filtered.map((t: any) => {
              const cohort = Array.isArray(t.cohort) ? t.cohort[0] : t.cohort;
              const members = t.team_members?.[0]?.count ?? 0;
              return (
                <Link key={t.id} href={`/admin/teams/${t.id}`} className="block">
                  <Card className="hover:border-phosphor/40">
                    <div className="flex items-start justify-between gap-4">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <h2 className="text-base font-semibold text-ink">
                            {t.name}
                          </h2>
                          {t.is_public ? (
                            <span className="inline-flex items-center gap-1 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[10px] uppercase tracking-wider text-emerald-700 dark:text-emerald-300">
                              <Globe className="h-3 w-3" /> Public
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 rounded-full bg-wash px-2 py-0.5 text-[10px] uppercase tracking-wider text-ink-faint">
                              <EyeOff className="h-3 w-3" /> Private
                            </span>
                          )}
                        </div>
                        <div className="mt-0.5 text-xs text-ink-faint">
                          {cohort?.name} · {members} member
                          {members === 1 ? "" : "s"}
                        </div>
                        {t.tagline && (
                          <p className="mt-2 text-sm text-ink-soft">{t.tagline}</p>
                        )}
                      </div>
                    </div>
                  </Card>
                </Link>
              );
            })}
          </div>
        </>
      )}
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
          ? "border-phosphor/30 bg-phosphor/10 text-phosphor-ink"
          : "border-line text-ink-soft hover:border-ink/30 hover:text-ink"
      }`}
    >
      {label}
    </Link>
  );
}
