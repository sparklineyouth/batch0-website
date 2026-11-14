"use server";
import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { assertPermission } from "@/lib/server-guards";
import { logAudit } from "@/lib/audit";
import { notifyMany } from "@/lib/notifications";
import { sendEmail } from "@/lib/email/send";
import { Templates } from "@/lib/email/templates";
import {
  applicableCriteria,
  buildScorecard,
  coerceAnchors,
  formatScore,
  type CriterionRow,
} from "@/lib/demo-day-rubric";

export type ReleaseOptions = {
  teamId: string;
  /** Put the card on the founders' team page. */
  showOnDashboard: boolean;
  /** Email every member a complete copy. */
  sendEmail: boolean;
  /** Let the judges' written notes travel with the numbers. */
  includeComments: boolean;
  /** An optional line from us, shown above the scores. */
  note?: string | null;
};

/**
 * Hands a team's scorecard back to its founders.
 *
 * The two channels are independent on purpose. Dashboard-only is the default
 * for a cohort being walked through their cards in a session; email is for
 * the ones who weren't there, and is the copy that gets forwarded to a
 * parent. Either can be chosen alone — an admin who wants a quiet release
 * unticks the email, and one who wants the email without parking the card in
 * the dashboard unticks the other.
 *
 * Releasing is re-runnable: pressing it again with the email ticked sends
 * another copy (after an edited note, or a rescore), which is why the row
 * counts sends rather than storing a boolean.
 */
export async function releaseFeedback(opts: ReleaseOptions): Promise<{
  emailed: number;
  skipped: number;
  weightedPct: number | null;
}> {
  const { userId } = await assertPermission("demoday.manage");
  const admin = createAdminClient();

  if (!opts.showOnDashboard && !opts.sendEmail) {
    throw new Error(
      "Pick at least one channel — the dashboard, an email, or both.",
    );
  }

  const [{ data: team }, { data: criteria }, { data: scores }, { data: members }] =
    await Promise.all([
      admin
        .from("teams")
        .select("id, name, cohort_id")
        .eq("id", opts.teamId)
        .maybeSingle(),
      admin
        .from("demo_day_rubric_criteria")
        .select(
          "id, label, description, weight, max_score, cohort_id, anchors, position",
        )
        .order("position", { ascending: true }),
      admin
        .from("demo_day_scores")
        .select("criterion_id, score, comment, judge_id")
        .eq("team_id", opts.teamId),
      admin
        .from("team_members")
        .select("user_id, user:profiles(email, full_name)")
        .eq("team_id", opts.teamId),
    ]);
  if (!team) throw new Error("Team not found");

  const rubric = applicableCriteria(
    ((criteria ?? []) as any[]).map((c) => ({
      ...c,
      anchors: coerceAnchors(c.anchors),
    })) as CriterionRow[],
    team.cohort_id,
  );
  const card = buildScorecard(rubric, (scores ?? []) as any[]);

  // A card with nothing on it is worse than silence: it reads to a founder as
  // "the judges looked and had nothing to say". Scoring first, releasing
  // second.
  if (card.scoredCount === 0) {
    throw new Error(
      "No judge has scored this team yet — there's nothing to send back.",
    );
  }

  const note = opts.note?.trim() || null;
  const nowIso = new Date().toISOString();

  const { data: existing } = await admin
    .from("demo_day_feedback_releases")
    .select("email_count")
    .eq("team_id", opts.teamId)
    .maybeSingle();

  let emailed = 0;
  let skipped = 0;

  if (opts.sendEmail) {
    const tpl = Templates.demoDayRubricFeedback({
      teamName: team.name,
      weightedPct: card.weightedPct,
      judgeCount: card.judgeCount,
      note,
      rows: card.rows
        .filter((r) => r.average != null)
        .map((r) => ({
          label: r.criterion.label,
          score: formatScore(r.average, r.maxScore),
          sharePct: Math.round(r.weightPct),
          band: r.anchor,
          comments: opts.includeComments ? r.comments : [],
        })),
    });
    for (const m of (members ?? []) as any[]) {
      const u = Array.isArray(m.user) ? m.user[0] : m.user;
      if (!u?.email) {
        skipped += 1;
        continue;
      }
      const res = await sendEmail({
        to: u.email,
        subject: tpl.subject,
        html: tpl.html,
        text: tpl.text,
        templateKey: "demo_day_rubric_feedback",
      });
      if (res.ok) emailed += 1;
      else skipped += 1;
    }
  }

  const { error } = await admin.from("demo_day_feedback_releases").upsert(
    {
      team_id: opts.teamId,
      released_at: nowIso,
      released_by: userId,
      show_on_dashboard: opts.showOnDashboard,
      include_comments: opts.includeComments,
      note,
      // Only touched by a send, so an email-less re-release doesn't erase the
      // record of a copy that already went out.
      ...(opts.sendEmail
        ? {
            emailed_at: nowIso,
            email_count: (existing?.email_count ?? 0) + emailed,
          }
        : {}),
    },
    { onConflict: "team_id" },
  );
  if (error) throw new Error(error.message);

  if (opts.showOnDashboard) {
    await notifyMany(
      ((members ?? []) as any[]).map((m) => ({
        userId: m.user_id as string,
        type: "demo_day_feedback",
        title: "Your Demo Day scorecard is ready",
        body: `The judges' scores for ${team.name} are on your team page.`,
        link: "/dashboard/team",
        // One notification per release, not per re-release: an admin fixing a
        // typo in the note shouldn't ping four founders again.
        dedupeKey: `demo_day_feedback:${opts.teamId}`,
      })),
    );
  }

  await logAudit({
    action: "demo_day.feedback_released",
    targetType: "team",
    targetId: opts.teamId,
    payload: {
      show_on_dashboard: opts.showOnDashboard,
      emailed,
      skipped,
      include_comments: opts.includeComments,
      weighted_pct: card.weightedPct,
    },
  });

  revalidatePath("/admin/demo-day/feedback");
  revalidatePath("/admin/demo-day");
  revalidatePath("/dashboard/team");
  return { emailed, skipped, weightedPct: card.weightedPct };
}

/**
 * Takes a released card back off the founders' dashboard.
 *
 * The row survives with `released_at` null so the send history stays
 * readable — an admin needs to know an email already went out even after
 * they've hidden the card, because that one can't be recalled.
 */
export async function unreleaseFeedback(teamId: string) {
  await assertPermission("demoday.manage");
  const admin = createAdminClient();
  const { error } = await admin
    .from("demo_day_feedback_releases")
    .update({ released_at: null })
    .eq("team_id", teamId);
  if (error) throw new Error(error.message);
  await logAudit({
    action: "demo_day.feedback_unreleased",
    targetType: "team",
    targetId: teamId,
  });
  revalidatePath("/admin/demo-day/feedback");
  revalidatePath("/admin/demo-day");
  revalidatePath("/dashboard/team");
}
