import Link from "next/link";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireAdmin } from "@/lib/auth";
import { Card } from "@/components/ui/card";

export const metadata = { title: "Demo Day · Admin" };

type Score = {
  problem: number | null;
  traction: number | null;
  team_score: number | null;
  ask: number | null;
};

function avg(nums: (number | null | undefined)[]) {
  const xs = nums.filter((n): n is number => typeof n === "number");
  if (xs.length === 0) return null;
  return xs.reduce((s, n) => s + n, 0) / xs.length;
}

export default async function AdminDemoDayPage() {
  await requireAdmin();
  const admin = createAdminClient();

  const [{ data: teams }, { data: submissions }, { data: scores }] =
    await Promise.all([
      admin
        .from("teams")
        .select("id, name, cohort:cohorts(name)")
        .order("name"),
      admin.from("pitch_submissions").select("*"),
      admin
        .from("pitch_scores")
        .select(
          "team_id, problem, traction, team_score, ask, scorer:profiles(full_name, email, role)",
        ),
    ]);

  const subByTeam = new Map<string, any>(
    (submissions ?? []).map((s: any) => [s.team_id, s]),
  );
  const scoresByTeam = new Map<string, Score[]>();
  for (const s of (scores ?? []) as any[]) {
    const arr = scoresByTeam.get(s.team_id) ?? [];
    arr.push(s);
    scoresByTeam.set(s.team_id, arr);
  }

  const rows = (teams ?? []).map((t: any) => {
    const sub = subByTeam.get(t.id);
    const teamScores = scoresByTeam.get(t.id) ?? [];
    const overall =
      avg(
        teamScores.flatMap((sc) => [
          sc.problem,
          sc.traction,
          sc.team_score,
          sc.ask,
        ]),
      );
    return {
      id: t.id,
      name: t.name,
      cohort: Array.isArray(t.cohort) ? t.cohort[0]?.name : t.cohort?.name,
      submitted: !!sub?.submitted_at,
      scoreCount: teamScores.length,
      overall,
    };
  });

  rows.sort((a, b) => (b.overall ?? -1) - (a.overall ?? -1));

  return (
    <div className="mx-auto max-w-5xl">
      <h1 className="text-3xl font-bold tracking-tight">Demo Day</h1>
      <p className="mt-1 text-sm text-white/55">
        Submission status and live leaderboard. Click a team for full
        scorecards.
      </p>

      <Card className="mt-6 !p-0">
        <div className="grid grid-cols-12 border-b border-white/10 px-4 py-2 text-[10px] font-semibold uppercase tracking-wider text-white/40">
          <div className="col-span-5">Team</div>
          <div className="col-span-3">Cohort</div>
          <div className="col-span-2">Submitted</div>
          <div className="col-span-1">Scores</div>
          <div className="col-span-1 text-right">Avg</div>
        </div>
        <ul className="divide-y divide-white/5">
          {rows.length === 0 && (
            <li className="px-4 py-6 text-sm text-white/40">
              No teams yet.
            </li>
          )}
          {rows.map((r) => (
            <li key={r.id}>
              <Link
                href={`/admin/teams/${r.id}`}
                className="grid grid-cols-12 items-center px-4 py-3 hover:bg-white/[0.02]"
              >
                <div className="col-span-5 truncate text-sm text-white">
                  {r.name}
                </div>
                <div className="col-span-3 truncate text-xs text-white/50">
                  {r.cohort}
                </div>
                <div className="col-span-2 text-xs">
                  {r.submitted ? (
                    <span className="text-emerald-300">Yes</span>
                  ) : (
                    <span className="text-white/40">No</span>
                  )}
                </div>
                <div className="col-span-1 text-xs text-white/60">
                  {r.scoreCount}
                </div>
                <div className="col-span-1 text-right text-sm font-semibold tracking-tight text-spark">
                  {r.overall != null ? r.overall.toFixed(2) : "—"}
                </div>
              </Link>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}
