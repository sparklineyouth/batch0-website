import Link from "next/link";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireInvestor } from "@/lib/auth";
import { Card } from "@/components/ui/card";

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
  requested: "bg-white/10 text-white/60",
  intro_made: "bg-blue-400/15 text-blue-300",
  meeting_held: "bg-amber-300/15 text-amber-200",
  committed: "bg-emerald-400/15 text-emerald-300",
  wired: "bg-spark/15 text-spark",
  passed: "bg-white/10 text-white/40",
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
      <h1 className="text-3xl font-bold tracking-tight">My intros</h1>
      <p className="mt-1 text-sm text-white/55">
        Status of every intro you've requested.
      </p>

      <div className="mt-6 space-y-3">
        {(rows ?? []).length === 0 && (
          <Card>
            <p className="text-sm text-white/50">
              No intros yet. Request one from a team page.
            </p>
          </Card>
        )}
        {(rows ?? []).map((r: any) => {
          const t = Array.isArray(r.team) ? r.team[0] : r.team;
          return (
            <Card key={r.id}>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <Link
                    href={`/investor/teams/${t.id}`}
                    className="text-base font-semibold text-white hover:text-spark"
                  >
                    {t?.name}
                  </Link>
                  {t?.tagline && (
                    <p className="mt-0.5 text-sm text-white/55">
                      {t.tagline}
                    </p>
                  )}
                  <p className="mt-2 text-xs text-white/40">
                    Requested {new Date(r.created_at).toLocaleDateString()}
                  </p>
                  {r.message && (
                    <p className="mt-2 whitespace-pre-wrap text-sm text-white/75">
                      {r.message}
                    </p>
                  )}
                </div>
                <span
                  className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${
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
