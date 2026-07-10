"use server";
import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { assertAdmin } from "@/lib/server-guards";
import { logAudit } from "@/lib/audit";

/**
 * Runs an AI rubric pre-score on an application. Admin always makes the
 * final call — this just sorts the queue and surfaces a one-paragraph
 * summary so reviewers can triage faster.
 *
 * Rubric (1–10):
 *   - specificity of idea
 *   - signs of agency / execution
 *   - founder-market fit signals
 * Score = mean.
 */
export async function aiScreenApplication(input: { applicationId: string }) {
  await assertAdmin();
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("AI not configured (set ANTHROPIC_API_KEY).");
  }
  const admin = createAdminClient();
  const { data: app, error } = await admin
    .from("applications")
    .select(
      "id, full_name, age, grade, school, city, country, why_join, startup_idea, experience, hours_per_week, team_size, linkedin_url, portfolio_url",
    )
    .eq("id", input.applicationId)
    .single();
  if (error) throw new Error(error.message);
  if (!app) throw new Error("Not found");

  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const userBlock = `Applicant: ${app.full_name ?? "—"}, age ${app.age ?? "?"}, grade ${app.grade ?? "?"}, ${app.school ?? "?"}, ${app.city ?? ""} ${app.country ?? ""}
Hours/week available: ${app.hours_per_week ?? "?"}
Founding team size: ${app.team_size ?? "?"} ${app.team_size === 1 ? "(solo)" : app.team_size && app.team_size >= 5 ? "(5+)" : ""}
LinkedIn: ${app.linkedin_url ?? "—"}
Portfolio: ${app.portfolio_url ?? "—"}

Startup idea:
${app.startup_idea ?? "(blank)"}

Why join:
${app.why_join ?? "(blank)"}

Prior experience:
${app.experience ?? "(blank)"}`;

  const res = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 600,
    system: [
      {
        type: "text",
        text: `You're screening high-school applicants for SparkLine Youth, a four-sprint startup accelerator. Be honest and direct — admins make the final decision, you're sorting the queue.

Score each dimension 1–10:
1. specificity (is the idea concrete and well-understood, not generic?)
2. agency (signs they ship things, take initiative, don't wait for permission)
3. founder/market fit (do they have personal reason / unfair insight into this problem?)

Score signal, not surface. If the applicant wrote in a non-English language, has typos, or formats things unconventionally, judge the substance — language fluency and presentation polish are NOT part of the rubric. Translate the summary you produce into English regardless of the applicant's writing language.

Reply with a single JSON object:
{"score_overall": number (1-10, weighted average), "specificity": number, "agency": number, "fit": number, "summary": string (≤300 chars, plain English text, no markdown, what makes this application strong/weak)}

Only return the JSON. No preamble.`,
        cache_control: { type: "ephemeral" },
      },
    ],
    messages: [{ role: "user", content: userBlock }],
  });

  const text =
    res.content
      .map((b: any) => (b.type === "text" ? b.text : ""))
      .join("")
      .trim() || "{}";
  let parsed: any = {};
  try {
    const s = text.indexOf("{");
    const e = text.lastIndexOf("}");
    parsed = JSON.parse(s >= 0 ? text.slice(s, e + 1) : text);
  } catch {
    throw new Error("AI returned an unparseable response.");
  }

  const overall =
    typeof parsed.score_overall === "number"
      ? Math.max(1, Math.min(10, Math.round(parsed.score_overall)))
      : null;
  const summary =
    typeof parsed.summary === "string" ? parsed.summary.slice(0, 600) : null;

  await admin
    .from("applications")
    .update({
      ai_score: overall,
      ai_summary: summary,
      ai_reviewed_at: new Date().toISOString(),
    })
    .eq("id", input.applicationId);

  await logAudit({
    action: "application.ai_screened",
    targetType: "application",
    targetId: input.applicationId,
    payload: { score: overall },
  });

  revalidatePath(`/admin/applications/${input.applicationId}`);
  revalidatePath("/admin/applications");
}
