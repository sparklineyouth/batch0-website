"use server";
import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { assertAdmin } from "@/lib/server-guards";
import { logAudit } from "@/lib/audit";
import { sendEmail } from "@/lib/email/send";
import { Templates } from "@/lib/email/templates";
import Anthropic from "@anthropic-ai/sdk";
import { env } from "@/lib/env";

/**
 * Generates an AI-written recap for a single team using the judges'
 * scores + comments + audience reactions, persists it on the team row,
 * and emails every member. Idempotent — re-running rewrites the recap
 * (admins might want to re-roll a draft).
 */
export async function generateAndSendRecap(teamId: string): Promise<{
  summary: string;
  emailed: number;
}> {
  await assertAdmin();
  const admin = createAdminClient();

  const [
    { data: team },
    { data: criteria },
    { data: scores },
    { data: reactions },
    { data: members },
    { data: allTeams },
  ] = await Promise.all([
    admin
      .from("teams")
      .select("id, name, slug, tagline, description, cohort_id")
      .eq("id", teamId)
      .maybeSingle(),
    admin
      .from("demo_day_rubric_criteria")
      .select("id, label, weight, max_score, cohort_id"),
    admin
      .from("demo_day_scores")
      .select("criterion_id, score, comment")
      .eq("team_id", teamId),
    admin.from("demo_day_reactions").select("emoji").eq("team_id", teamId),
    admin
      .from("team_members")
      .select("user:profiles(email, full_name)")
      .eq("team_id", teamId),
    admin
      .from("demo_day_scores")
      .select("team_id, criterion_id, score"),
  ]);
  if (!team) throw new Error("Team not found");

  const reactionCount = reactions?.length ?? 0;
  const critById = new Map(
    (criteria ?? []).map((c: any) => [
      c.id,
      { ...c, applies: !c.cohort_id || c.cohort_id === team.cohort_id },
    ]),
  );

  // Compute weighted score + rank.
  const teamWeighted = new Map<string, number>();
  const groupedByTeam = new Map<string, Map<string, number[]>>();
  for (const s of (allTeams ?? []) as any[]) {
    const m = groupedByTeam.get(s.team_id) ?? new Map();
    const arr = m.get(s.criterion_id) ?? [];
    arr.push(s.score);
    m.set(s.criterion_id, arr);
    groupedByTeam.set(s.team_id, m);
  }
  for (const [tid, m] of groupedByTeam) {
    let ws = 0;
    let wsum = 0;
    for (const [cid, arr] of m) {
      const c = critById.get(cid);
      if (!c) continue;
      const avg = arr.reduce((a, b) => a + b, 0) / arr.length;
      ws += (avg / Math.max(c.max_score, 1)) * Number(c.weight);
      wsum += Number(c.weight);
    }
    teamWeighted.set(tid, wsum > 0 ? (ws / wsum) * 100 : -1);
  }
  const ranked = [...teamWeighted.entries()].sort((a, b) => b[1] - a[1]);
  const idx = ranked.findIndex(([tid]) => tid === teamId);
  const rank = idx >= 0 ? idx + 1 : null;
  const weightedPct = teamWeighted.get(teamId) ?? null;
  const validWeighted =
    weightedPct != null && weightedPct >= 0 ? weightedPct : null;

  // Build the AI prompt input from scores + comments.
  const scoreSummary = (scores ?? [])
    .map((s: any) => {
      const c = critById.get(s.criterion_id);
      if (!c) return null;
      return `- ${c.label}: ${s.score}/${c.max_score}${s.comment ? ` — "${s.comment}"` : ""}`;
    })
    .filter(Boolean)
    .join("\n");

  let summary = `Strong pitch from ${team.name}. ${reactionCount} audience reaction${
    reactionCount === 1 ? "" : "s"
  }${
    validWeighted != null ? ` · weighted score ${validWeighted.toFixed(1)}%` : ""
  }.`;

  if (env.anthropicApiKey && scoreSummary) {
    try {
      const client = new Anthropic({ apiKey: env.anthropicApiKey });
      const msg = await client.messages.create({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 600,
        system:
          "You're writing a Demo Day recap for a high-school startup team at SparkLine Youth. " +
          "Keep it warm but specific — 3-4 short paragraphs. Quote judge comments only " +
          "if they're actually useful feedback; never call out a judge by name. End with a " +
          "concrete suggestion for what to focus on next.",
        messages: [
          {
            role: "user",
            content: [
              `Team: ${team.name}${team.tagline ? ` — ${team.tagline}` : ""}`,
              team.description ? `About: ${team.description}` : "",
              `Audience reactions: ${reactionCount}`,
              validWeighted != null
                ? `Weighted score: ${validWeighted.toFixed(1)}%`
                : "",
              rank ? `Rank: #${rank} of ${ranked.length}` : "",
              "",
              "Judge scores + comments:",
              scoreSummary,
            ]
              .filter(Boolean)
              .join("\n"),
          },
        ],
      });
      const text = msg.content
        .filter((c) => c.type === "text")
        .map((c: any) => c.text)
        .join("\n")
        .trim();
      if (text) summary = text;
    } catch (err) {
      console.error("[demo-day-recap] AI summary failed", err);
    }
  }

  // Persist on the team row so admins can re-send without re-paying for AI.
  await admin
    .from("teams")
    .update({
      demo_day_recap: summary,
      demo_day_recap_at: new Date().toISOString(),
    })
    .eq("id", teamId);

  // Email every team member.
  const emails = (members ?? [])
    .map((m: any) => {
      const u = Array.isArray(m.user) ? m.user[0] : m.user;
      return u?.email;
    })
    .filter((e: string | undefined): e is string => Boolean(e));

  let emailed = 0;
  if (emails.length > 0) {
    const tpl = Templates.demoDayRecap({
      teamName: team.name,
      rank,
      totalTeams: ranked.length,
      weightedPct: validWeighted,
      reactionCount,
      summary,
      teamSlug: team.slug,
    });
    for (const to of emails) {
      const res = await sendEmail({
        to,
        subject: tpl.subject,
        html: tpl.html,
      });
      if (res.ok) emailed += 1;
    }
  }

  await logAudit({
    action: "demo_day.recap_sent",
    targetType: "team",
    targetId: teamId,
    payload: { emailed, rank, weighted_pct: validWeighted },
  });
  revalidatePath("/admin/demo-day");
  revalidatePath(`/admin/teams/${teamId}`);
  return { summary, emailed };
}
