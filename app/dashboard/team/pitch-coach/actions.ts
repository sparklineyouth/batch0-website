"use server";
import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { env } from "@/lib/env";
import { applyUsage, isOverHardCap } from "@/lib/ai/usage";
import { canUseAi } from "@/lib/access";
import { logAudit } from "@/lib/audit";
import Anthropic from "@anthropic-ai/sdk";
import type { Role } from "@/lib/types";

export type PitchCoachInput = {
  teamId: string;
  sourceKind: "deck_url" | "video_url" | "transcript";
  source: string;
};

export async function requestPitchCoach(input: PitchCoachInput): Promise<{
  feedbackId: string;
}> {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("Not signed in");

  const admin = createAdminClient();
  const { data: profile } = await admin
    .from("profiles")
    .select("role, full_name")
    .eq("id", user.id)
    .maybeSingle();
  const role = (profile?.role as Role) ?? "student";
  if (!(await canUseAi(role))) {
    throw new Error("Pitch coach is locked until your application is accepted.");
  }
  if (role !== "admin" && (await isOverHardCap(user.id))) {
    throw new Error(
      "You've hit your AI monthly cap. Contact batch0 if you need more.",
    );
  }

  // Membership check
  const { data: membership } = await admin
    .from("team_members")
    .select("user_id")
    .eq("team_id", input.teamId)
    .eq("user_id", user.id)
    .maybeSingle();
  if (!membership && role !== "admin") {
    throw new Error("You're not on this team");
  }

  if (input.source.trim().length < 10) {
    throw new Error("Source content too short to score.");
  }
  if (
    (input.sourceKind === "deck_url" || input.sourceKind === "video_url") &&
    !/^https?:\/\//i.test(input.source.trim())
  ) {
    throw new Error("URL must start with http(s)://");
  }

  // Build rubric prompt from current Demo Day rubric criteria, fallback
  // to a generic 5-axis rubric if none exist.
  const [{ data: team }, { data: criteria }] = await Promise.all([
    admin
      .from("teams")
      .select("name, tagline, description, cohort_id")
      .eq("id", input.teamId)
      .maybeSingle(),
    admin
      .from("demo_day_rubric_criteria")
      .select("label, description, max_score")
      .order("position", { ascending: true }),
  ]);
  const applicable = (criteria ?? []).filter(
    (c: any) => !c.cohort_id || c.cohort_id === team?.cohort_id,
  );
  const rubric = applicable.length > 0
    ? applicable
    : [
        { label: "Problem clarity", description: "Real, urgent, well understood.", max_score: 5 },
        { label: "Solution fit", description: "Does the solution actually move the needle?", max_score: 5 },
        { label: "Traction / evidence", description: "Proof of progress: interviews, prototype, paying users.", max_score: 5 },
        { label: "Team", description: "Why these founders, why now.", max_score: 5 },
        { label: "Ask", description: "Clear, believable, calibrated.", max_score: 5 },
      ];

  if (!env.anthropicApiKey) {
    throw new Error("AI is not configured on this site.");
  }

  // For URLs we can't actually fetch (deck PDF, Loom video) we ask the
  // student to also paste a brief written summary OR the title page
  // text. We don't ingest binary content in this MVP — the prompt makes
  // that limitation clear to the model.
  const sourcePreamble =
    input.sourceKind === "transcript"
      ? `Transcript or written pitch:\n\n${input.source.slice(0, 12000)}`
      : `Pitch source URL (you cannot follow it — score based on the title + filename + the student's accompanying notes):\n${input.source.slice(0, 500)}`;

  const client = new Anthropic({ apiKey: env.anthropicApiKey });
  const sys =
    "You're a senior pitch coach at batch0. Score this pitch against the rubric. " +
    "Return STRICT JSON with shape: " +
    '{"scores": {"<label>": {"score": number, "why": string}}, "overall_score": number, "summary": string, "strengths": string, "improvements": string}. ' +
    "Each label MUST be one of the rubric labels provided. Scores must be 0..max_score for that label. " +
    "Be specific. Quote the pitch. Don't pad — short paragraphs over long ones. " +
    "Improvements should be a numbered list of 3-5 concrete fixes.";

  const userMsg =
    `Team: ${team?.name ?? "Unknown"}${team?.tagline ? ` — ${team.tagline}` : ""}\n` +
    (team?.description ? `About: ${team.description}\n` : "") +
    `\nRubric:\n${rubric.map((r: any) => `- ${r.label} (0-${r.max_score}): ${r.description ?? ""}`).join("\n")}\n\n${sourcePreamble}`;

  const msg = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 1800,
    system: sys,
    messages: [{ role: "user", content: userMsg }],
  });

  // Track AI usage so the student's quota burns through this too.
  const usage = (msg as any).usage ?? {};
  await applyUsage({
    userId: user.id,
    delta: {
      input_tokens: usage.input_tokens ?? 0,
      output_tokens: usage.output_tokens ?? 0,
      cache_creation_tokens: usage.cache_creation_input_tokens ?? 0,
      cache_read_tokens: usage.cache_read_input_tokens ?? 0,
    },
  });

  const text = msg.content
    .filter((c) => c.type === "text")
    .map((c: any) => c.text)
    .join("\n")
    .trim();
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("Couldn't parse coach response. Try again.");
  let parsed: any;
  try {
    parsed = JSON.parse(match[0]);
  } catch (err) {
    throw new Error("Coach response wasn't valid JSON.");
  }

  // Persist
  const { data: row, error } = await admin
    .from("pitch_coach_feedback")
    .insert({
      team_id: input.teamId,
      requested_by: user.id,
      source_kind: input.sourceKind,
      source: input.source.slice(0, 4000),
      scores: parsed.scores ?? {},
      overall_score:
        typeof parsed.overall_score === "number"
          ? Math.min(100, Math.max(0, parsed.overall_score))
          : null,
      summary: (parsed.summary ?? "").slice(0, 4000),
      strengths: parsed.strengths ?? null,
      improvements: parsed.improvements ?? null,
    })
    .select("id")
    .single();
  if (error) throw new Error(error.message);

  await logAudit({
    action: "pitch_coach.requested",
    targetType: "team",
    targetId: input.teamId,
    payload: { source_kind: input.sourceKind, feedback_id: row!.id },
  });

  revalidatePath(`/dashboard/team/pitch-coach`);
  return { feedbackId: row!.id };
}
