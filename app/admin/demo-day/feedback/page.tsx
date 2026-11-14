import Link from "next/link";
import { createAdminClient } from "@/lib/supabase/admin";
import { requirePermission } from "@/lib/auth";
import { Card } from "@/components/ui/card";
import {
  applicableCriteria,
  buildScorecard,
  coerceAnchors,
  type CriterionRow,
} from "@/lib/demo-day-rubric";
import { FeedbackManager, type TeamFeedback } from "./feedback-manager";

export const metadata = { title: "Release Demo Day feedback · Admin" };

export default async function AdminDemoDayFeedbackPage() {
  await requirePermission("demoday.manage");
  const admin = createAdminClient();

  const [{ data: teams }, { data: criteria }, { data: scores }, { data: releases }] =
    await Promise.all([
      admin
        .from("teams")
        .select("id, name, cohort_id, cohort:cohorts(name)")
        .order("name"),
      admin
        .from("demo_day_rubric_criteria")
        .select(
          "id, label, description, weight, max_score, cohort_id, anchors, position",
        )
        .order("position", { ascending: true }),
      // Every score for every team in one round trip, then grouped in JS.
      // One query per team would be a request per row on a page that exists
      // to be read top to bottom.
      admin
        .from("demo_day_scores")
        .select("team_id, criterion_id, score, comment, judge_id"),
      admin
        .from("demo_day_feedback_releases")
        .select(
          "team_id, released_at, show_on_dashboard, include_comments, note, emailed_at, email_count",
        ),
    ]);

  const normalizedCriteria = ((criteria ?? []) as any[]).map((c) => ({
    ...c,
    weight: Number(c.weight),
    anchors: coerceAnchors(c.anchors),
  })) as CriterionRow[];

  const scoresByTeam = new Map<string, any[]>();
  for (const s of (scores ?? []) as any[]) {
    const arr = scoresByTeam.get(s.team_id) ?? [];
    arr.push(s);
    scoresByTeam.set(s.team_id, arr);
  }
  const releaseByTeam = new Map<string, any>(
    ((releases ?? []) as any[]).map((r) => [r.team_id, r]),
  );

  const rows: TeamFeedback[] = ((teams ?? []) as any[]).map((t) => {
    const card = buildScorecard(
      applicableCriteria(normalizedCriteria, t.cohort_id),
      scoresByTeam.get(t.id) ?? [],
    );
    const rel = releaseByTeam.get(t.id);
    return {
      teamId: t.id,
      teamName: t.name,
      cohortName: Array.isArray(t.cohort) ? t.cohort[0]?.name : t.cohort?.name,
      card,
      release: rel
        ? {
            releasedAt: rel.released_at,
            showOnDashboard: rel.show_on_dashboard,
            includeComments: rel.include_comments,
            note: rel.note,
            emailedAt: rel.emailed_at,
            emailCount: rel.email_count ?? 0,
          }
        : null,
    };
  });

  // Unreleased-but-scored first: that is the queue this page exists to work
  // through. Then released, then teams nobody has judged yet.
  rows.sort((a, b) => {
    const rank = (r: TeamFeedback) =>
      r.card.scoredCount === 0 ? 2 : r.release?.releasedAt ? 1 : 0;
    const d = rank(a) - rank(b);
    if (d !== 0) return d;
    return (b.card.weightedPct ?? -1) - (a.card.weightedPct ?? -1);
  });

  const pending = rows.filter(
    (r) => r.card.scoredCount > 0 && !r.release?.releasedAt,
  ).length;

  return (
    <div className="mx-auto max-w-3xl">
      <Link
        href="/admin/demo-day"
        className="text-sm text-ink-soft hover:text-ink"
      >
        ← Demo Day
      </Link>
      <h1 className="mt-3 font-display text-3xl font-bold tracking-[-0.02em] text-ink">
        Release feedback
      </h1>
      <p className="mt-1 text-sm text-ink-soft">
        Judge scores stay hidden from founders until you release them. Choose
        per team whether the card lands on their dashboard, in their inbox, or
        both — and whether the judges&apos; written notes travel with it.
      </p>
      {pending > 0 && (
        <p className="mt-3 text-sm text-amber-700 dark:text-amber-200">
          {pending} team{pending === 1 ? "" : "s"} scored and waiting on a
          release.
        </p>
      )}

      {rows.length === 0 ? (
        <Card className="mt-6">
          <p className="text-sm text-ink-faint">No teams yet.</p>
        </Card>
      ) : (
        <div className="mt-6 space-y-4">
          {rows.map((r) => (
            <FeedbackManager key={r.teamId} team={r} />
          ))}
        </div>
      )}
    </div>
  );
}
