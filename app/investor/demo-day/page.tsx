import Link from "next/link";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireInvestor } from "@/lib/auth";
import { Card } from "@/components/ui/card";
import { LocalTime } from "@/components/ui/local-time";

export const metadata = { title: "Demo Day · Investor" };

export default async function InvestorDemoDayPage() {
  const profile = await requireInvestor();
  const admin = createAdminClient();

  const [{ data: subs }, { data: myScores }] = await Promise.all([
    admin
      .from("pitch_submissions")
      .select(
        "team_id, submitted_at, video_url, team:teams(id, name, tagline, logo_url, logo_status, cohort:cohorts(name))",
      )
      .not("submitted_at", "is", null)
      .order("submitted_at", { ascending: false }),
    admin
      .from("pitch_scores")
      .select("team_id, problem, traction, team_score, ask")
      .eq("scorer_id", profile.id),
  ]);

  const scoredSet = new Set((myScores ?? []).map((s: any) => s.team_id));

  return (
    <div className="mx-auto max-w-4xl">
      <h1 className="font-display text-3xl font-bold tracking-[-0.02em] text-ink">Demo Day</h1>
      <p className="mt-1 text-sm text-ink-soft">
        Submitted pitches you can review and score.
      </p>

      <div className="mt-6 grid gap-3">
        {(subs ?? []).length === 0 && (
          <Card>
            <p className="text-sm text-ink-faint">
              No submissions yet. Check back after Demo Day eve.
            </p>
          </Card>
        )}
        {(subs ?? []).map((s: any) => {
          const t = Array.isArray(s.team) ? s.team[0] : s.team;
          const cohort = Array.isArray(t?.cohort) ? t.cohort[0] : t?.cohort;
          const scored = scoredSet.has(s.team_id);
          return (
            <Link key={s.team_id} href={`/investor/teams/${s.team_id}`}>
              <Card className="transition hover:border-ink/20">
                <div className="flex items-start gap-3">
                  <div className="flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-xl border border-line bg-paper">
                    {t?.logo_url && t?.logo_status === "approved" ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={t.logo_url} alt="" className="h-full w-full object-cover" />
                    ) : (
                      <span className="text-lg font-bold text-spark-ink">
                        {t?.name?.slice(0, 1).toUpperCase()}
                      </span>
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <h3 className="font-display text-base font-semibold tracking-[-0.02em] text-ink">
                      {t?.name}
                    </h3>
                    {t?.tagline && (
                      <p className="mt-0.5 text-sm text-ink-soft">
                        {t.tagline}
                      </p>
                    )}
                    <p className="mt-1 text-xs text-ink-faint">
                      {cohort?.name ?? ""} · Submitted{" "}
                      <LocalTime value={s.submitted_at} mode="date" />
                    </p>
                  </div>
                  <span
                    className={`shrink-0 rounded-full px-2 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wider ${
                      scored
                        ? "bg-emerald-500/10 border border-emerald-500/30 text-emerald-700 dark:text-emerald-300"
                        : "bg-wash text-ink-faint"
                    }`}
                  >
                    {scored ? "Scored" : "Not scored"}
                  </span>
                </div>
              </Card>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
