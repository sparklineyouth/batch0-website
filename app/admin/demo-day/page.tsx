import Link from "next/link";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireAdmin } from "@/lib/auth";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

export const metadata = { title: "Demo Day · Admin" };

export default async function AdminDemoDayPage() {
  await requireAdmin();
  const admin = createAdminClient();

  const [
    { data: teams },
    { data: submissions },
    { data: criteria },
    { data: scores },
    { data: reactions },
  ] = await Promise.all([
    admin
      .from("teams")
      .select("id, name, cohort_id, cohort:cohorts(name)")
      .order("name"),
    admin.from("pitch_submissions").select("team_id, submitted_at"),
    admin
      .from("demo_day_rubric_criteria")
      .select("id, label, weight, max_score, cohort_id"),
    admin
      .from("demo_day_scores")
      .select("team_id, criterion_id, score, judge_id"),
    admin.from("demo_day_reactions").select("team_id"),
  ]);

  const subByTeam = new Map<string, any>(
    (submissions ?? []).map((s: any) => [s.team_id, s]),
  );
  const reactByTeam = new Map<string, number>();
  for (const r of (reactions ?? []) as any[]) {
    reactByTeam.set(r.team_id, (reactByTeam.get(r.team_id) ?? 0) + 1);
  }
  const critById = new Map<string, any>(
    (criteria ?? []).map((c: any) => [c.id, c]),
  );

  // Average score across judges for each (team, criterion), then a
  // weighted-average across criteria normalized to 0–1, then ×100 for
  // display. Criteria with cohort_id null apply to all cohorts.
  const teamRows = (teams ?? []).map((t: any) => {
    const sub = subByTeam.get(t.id);
    const scoresByCriterion = new Map<string, number[]>();
    const judgeIds = new Set<string>();
    for (const s of (scores ?? []) as any[]) {
      if (s.team_id !== t.id) continue;
      judgeIds.add(s.judge_id);
      const arr = scoresByCriterion.get(s.criterion_id) ?? [];
      arr.push(s.score);
      scoresByCriterion.set(s.criterion_id, arr);
    }
    let weightSum = 0;
    let weightedSum = 0;
    for (const [cid, arr] of scoresByCriterion) {
      const c = critById.get(cid);
      if (!c) continue;
      if (c.cohort_id && c.cohort_id !== t.cohort_id) continue;
      const avg = arr.reduce((a, b) => a + b, 0) / arr.length;
      const normalized = avg / Math.max(c.max_score, 1);
      weightedSum += normalized * Number(c.weight);
      weightSum += Number(c.weight);
    }
    const weighted = weightSum > 0 ? (weightedSum / weightSum) * 100 : null;
    return {
      id: t.id,
      name: t.name,
      cohort: Array.isArray(t.cohort) ? t.cohort[0]?.name : t.cohort?.name,
      submitted: !!sub?.submitted_at,
      judgeCount: judgeIds.size,
      reactions: reactByTeam.get(t.id) ?? 0,
      weighted,
    };
  });

  teamRows.sort((a, b) => (b.weighted ?? -1) - (a.weighted ?? -1));

  return (
    <div className="mx-auto max-w-5xl">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Demo Day</h1>
          <p className="mt-1 text-sm text-white/55">
            Submission status, weighted leaderboard, and audience reactions.
          </p>
        </div>
        <Link href="/admin/demo-day/rubric">
          <Button variant="secondary" size="sm">
            Edit rubric →
          </Button>
        </Link>
      </div>

      <Card className="mt-6 !p-0">
        <div className="grid grid-cols-12 border-b border-white/10 px-4 py-2 text-[10px] font-semibold uppercase tracking-wider text-white/40">
          <div className="col-span-4">Team</div>
          <div className="col-span-2">Cohort</div>
          <div className="col-span-2">Submitted</div>
          <div className="col-span-1">Judges</div>
          <div className="col-span-1">React</div>
          <div className="col-span-2 text-right">Weighted</div>
        </div>
        <ul className="divide-y divide-white/5">
          {teamRows.length === 0 && (
            <li className="px-4 py-6 text-sm text-white/40">No teams yet.</li>
          )}
          {teamRows.map((r) => (
            <li key={r.id}>
              <Link
                href={`/admin/teams/${r.id}`}
                className="grid grid-cols-12 items-center px-4 py-3 hover:bg-white/[0.02]"
              >
                <div className="col-span-4 truncate text-sm text-white">
                  {r.name}
                </div>
                <div className="col-span-2 truncate text-xs text-white/50">
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
                  {r.judgeCount}
                </div>
                <div className="col-span-1 text-xs text-white/60">
                  {r.reactions}
                </div>
                <div className="col-span-2 text-right text-sm font-semibold tracking-tight text-spark">
                  {r.weighted != null ? `${r.weighted.toFixed(1)}%` : "—"}
                </div>
              </Link>
            </li>
          ))}
        </ul>
      </Card>

      {criteria?.length === 0 && (
        <p className="mt-6 text-sm text-amber-200">
          No rubric yet —{" "}
          <Link
            href="/admin/demo-day/rubric"
            className="font-semibold underline"
          >
            define one
          </Link>{" "}
          before Demo Day so judges have something to score against.
        </p>
      )}
    </div>
  );
}
