import Link from "next/link";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireInvestor } from "@/lib/auth";
import { Card } from "@/components/ui/card";
import { LocalTime } from "@/components/ui/local-time";

export const metadata = { title: "Intros · Investor" };

const LABEL: Record<string, string> = {
  requested: "Requested",
  intro_made: "Intro made",
  meeting_held: "Meeting held",
  committed: "Committed",
  wired: "Wired",
  passed: "Passed",
};

const COLOR: Record<string, string> = {
  requested: "bg-wash text-ink-soft",
  intro_made: "bg-blue-500/10 border border-blue-500/30 text-blue-700 dark:text-blue-300",
  meeting_held: "bg-amber-500/10 border border-amber-500/30 text-amber-700 dark:text-amber-300",
  committed: "bg-emerald-500/10 border border-emerald-500/30 text-emerald-700 dark:text-emerald-300",
  wired: "bg-spark/15 text-spark-ink",
  passed: "bg-wash text-ink-faint",
};

export default async function InvestorIntrosPage() {
  const profile = await requireInvestor();
  const admin = createAdminClient();

  const { data: rows } = await admin
    .from("intro_requests")
    .select(
      "id, status, message, created_at, updated_at, team:teams(id, name, tagline)",
    )
    .eq("investor_id", profile.id)
    .order("created_at", { ascending: false });

  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="font-display text-3xl font-bold tracking-[-0.02em] text-ink">My intros</h1>
      <p className="mt-1 text-sm text-ink-soft">
        Status of every intro you've requested.
      </p>

      <div className="mt-6 space-y-3">
        {(rows ?? []).length === 0 && (
          <Card>
            <p className="text-sm text-ink-faint">
              No intros yet. Request one from a team page.
            </p>
          </Card>
        )}
        {(rows ?? []).map((r: any) => {
          const t = Array.isArray(r.team) ? r.team[0] : r.team;
          const teamHref = t?.id ? `/investor/teams/${t.id}` : null;
          return (
            <Card key={r.id}>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  {teamHref ? (
                    <Link
                      href={teamHref}
                      className="font-display text-base font-semibold tracking-[-0.02em] text-ink hover:text-spark-ink"
                    >
                      {t?.name ?? "Untitled team"}
                    </Link>
                  ) : (
                    <span className="font-display text-base font-semibold tracking-[-0.02em] text-ink-soft">
                      {t?.name ?? "Team removed"}
                    </span>
                  )}
                  {t?.tagline && (
                    <p className="mt-0.5 text-sm text-ink-soft">
                      {t.tagline}
                    </p>
                  )}
                  <p className="mt-2 text-xs text-ink-faint">
                    Requested <LocalTime value={r.created_at} mode="date" />
                  </p>
                  {r.message && (
                    <p className="mt-2 whitespace-pre-wrap text-sm text-ink-soft">
                      {r.message}
                    </p>
                  )}
                </div>
                <span
                  className={`shrink-0 rounded-full px-2 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wider ${
                    COLOR[r.status] ?? COLOR.requested
                  }`}
                >
                  {LABEL[r.status] ?? r.status}
                </span>
              </div>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
