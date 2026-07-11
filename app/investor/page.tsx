import Link from "next/link";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireInvestor } from "@/lib/auth";
import { Card } from "@/components/ui/card";

export const metadata = { title: "Investor · Sparkline Youth" };

export default async function InvestorOverview() {
  const profile = await requireInvestor();
  const admin = createAdminClient();

  const [{ count: totalTeams }, { count: publicTeams }, { data: interests }] =
    await Promise.all([
      admin.from("teams").select("id", { count: "exact", head: true }),
      admin
        .from("teams")
        .select("id", { count: "exact", head: true })
        .eq("is_public", true),
      admin
        .from("investor_interests")
        .select("id, level")
        .eq("investor_id", profile.id),
    ]);

  return (
    <div className="mx-auto max-w-5xl">
      <h1 className="font-display text-3xl font-bold tracking-[-0.02em] text-ink">Investor overview</h1>
      <p className="mt-1 text-sm text-ink-faint">
        Browse cohort startups and track which you're following.
      </p>

      <div className="mt-8 grid gap-4 sm:grid-cols-3">
        <Stat label="Teams in pipeline" value={(totalTeams ?? 0).toString()} />
        <Stat
          label="My interests"
          value={(interests?.length ?? 0).toString()}
        />
        <Stat
          label="Public profiles"
          value={(publicTeams ?? 0).toString()}
        />
      </div>

      <Card className="mt-10">
        <p className="text-sm text-ink-soft">
          Head to <Link href="/investor/teams" className="text-spark-ink hover:underline">Teams</Link> to browse all the
          startups in this cohort, see their pitch decks, and mark your level
          of interest.
        </p>
      </Card>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <Card>
      <div className="font-mono text-xs uppercase tracking-wider text-ink-faint">
        {label}
      </div>
      <div className="mt-2 font-display text-3xl font-bold tracking-[-0.02em] tabular-nums text-ink">
        {value}
      </div>
    </Card>
  );
}
