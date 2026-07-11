import Link from "next/link";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireInvestor } from "@/lib/auth";
import { Card } from "@/components/ui/card";

export const metadata = { title: "Interests · Investor" };

export default async function InvestorInterestsPage() {
  const profile = await requireInvestor();
  const admin = createAdminClient();

  const { data: rows } = await admin
    .from("investor_interests")
    .select("*, team:teams(id, name, tagline, slug, cohort:cohorts(name, slug))")
    .eq("investor_id", profile.id)
    .order("updated_at", { ascending: false });

  const grouped = new Map<string, any[]>();
  for (const r of (rows ?? []) as any[]) {
    const arr = grouped.get(r.level) ?? [];
    arr.push(r);
    grouped.set(r.level, arr);
  }

  const order = ["committed", "interested", "watching", "passed"];

  return (
    <div className="mx-auto max-w-4xl">
      <h1 className="font-display text-3xl font-bold tracking-[-0.02em] text-ink">My interests</h1>
      <p className="mt-1 text-sm text-ink-faint">
        Teams you've flagged. Private to you.
      </p>

      <div className="mt-8 space-y-8">
        {(rows?.length ?? 0) === 0 && (
          <Card>
            <p className="text-sm text-ink-faint">
              You haven't marked interest on any teams yet. Browse{" "}
              <Link href="/investor/teams" className="text-spark-ink hover:underline">
                Teams
              </Link>
              .
            </p>
          </Card>
        )}
        {order.map((level) => {
          const arr = grouped.get(level) ?? [];
          if (arr.length === 0) return null;
          return (
            <section key={level}>
              <h2 className="mb-3 font-mono text-xs font-semibold uppercase tracking-[0.18em] text-spark-ink">
                {level} ({arr.length})
              </h2>
              <ul className="space-y-2">
                {arr.map((r: any) => {
                  const t = Array.isArray(r.team) ? r.team[0] : r.team;
                  const cohort = Array.isArray(t?.cohort)
                    ? t.cohort[0]
                    : t?.cohort;
                  return (
                    <li key={r.id}>
                      <Card className="!p-4">
                        <div className="flex items-baseline justify-between gap-3">
                          <div>
                            <div className="text-sm font-medium text-ink">
                              {t?.name ?? "—"}
                            </div>
                            {t?.tagline && (
                              <div className="text-xs text-ink-faint">
                                {t.tagline}
                              </div>
                            )}
                          </div>
                          <div className="text-xs text-ink-faint">
                            {cohort?.name ?? ""}
                          </div>
                        </div>
                      </Card>
                    </li>
                  );
                })}
              </ul>
            </section>
          );
        })}
      </div>
    </div>
  );
}
