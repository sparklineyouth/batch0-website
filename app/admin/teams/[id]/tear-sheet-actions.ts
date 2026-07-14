"use server";
import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { assertAdmin } from "@/lib/server-guards";
import { logAudit } from "@/lib/audit";

/**
 * Generates (and caches) a one-page investor tear sheet for a team
 * using Claude. The output is plain prose grouped into Problem,
 * Solution, Traction, Team, Ask — investors read it on the team
 * detail page in /investor/teams.
 *
 * We persist the generated text on teams.tear_sheet so investors load
 * it without paying the model round-trip; admins click "regenerate"
 * to refresh after team data changes.
 */
export async function generateTearSheet(input: { teamId: string }) {
  await assertAdmin();
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("AI not configured (set ANTHROPIC_API_KEY).");
  }
  const admin = createAdminClient();

  const [{ data: team }, { data: members }, { data: pitch }] =
    await Promise.all([
      admin
        .from("teams")
        .select(
          "id, name, tagline, description, website_url, pitch_video_url, pitch_deck_url, raised_cents, post_money_cents, lead_investor, round_kind, round_closed_on, cohort:cohorts(name)",
        )
        .eq("id", input.teamId)
        .maybeSingle(),
      admin
        .from("team_members")
        .select("role, profile:profiles(full_name, ai_context)")
        .eq("team_id", input.teamId),
      admin
        .from("pitch_submissions")
        .select("notes")
        .eq("team_id", input.teamId)
        .maybeSingle(),
    ]);
  if (!team) throw new Error("Team not found.");

  const cohort = Array.isArray((team as any).cohort)
    ? (team as any).cohort[0]
    : (team as any).cohort;
  const memberLines = (members ?? [])
    .map((m: any) => {
      const profile = Array.isArray(m.profile) ? m.profile[0] : m.profile;
      const name = profile?.full_name ?? "Unnamed";
      const ai = profile?.ai_context ?? null;
      const role = m.role ?? "member";
      const detail =
        ai && typeof ai === "object"
          ? Object.entries(ai)
              .filter(
                ([, v]) =>
                  typeof v === "string" && (v as string).trim().length > 0,
              )
              .slice(0, 3)
              .map(([k, v]) => `${k}: ${String(v).slice(0, 120)}`)
              .join("; ")
          : "";
      return `- ${name} (${role})${detail ? ` — ${detail}` : ""}`;
    })
    .join("\n");

  const capLine: string[] = [];
  if ((team as any).round_kind) capLine.push(`round ${(team as any).round_kind}`);
  if ((team as any).raised_cents)
    capLine.push(
      `raised $${((team as any).raised_cents / 100).toLocaleString()}`,
    );
  if ((team as any).post_money_cents)
    capLine.push(
      `post-money $${((team as any).post_money_cents / 100).toLocaleString()}`,
    );
  if ((team as any).lead_investor)
    capLine.push(`led by ${(team as any).lead_investor}`);

  const inputBlock = `Team: ${team.name}
Cohort: ${cohort?.name ?? "—"}
Tagline: ${team.tagline ?? "—"}
Website: ${team.website_url ?? "—"}
Pitch deck: ${team.pitch_deck_url ?? "—"}
Pitch video: ${team.pitch_video_url ?? "—"}
${capLine.length ? `Cap-table: ${capLine.join(", ")}` : ""}

Description (verbatim from the team):
${team.description ?? "(blank)"}

Pitch submission notes:
${pitch?.notes ?? "(none)"}

Members:
${memberLines || "(no members listed)"}`;

  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const res = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 900,
    system: [
      {
        type: "text",
        text: `You write one-page investor tear sheets for high-school startup teams in the batch0 accelerator. Be specific and honest — investors hate fluff.

Output format (plain text, NO markdown, NO headings other than the labels below):

Problem
<2-3 sentences from the team's actual description. If the description is too vague to extract a clear problem, say so.>

Solution
<2-3 sentences. Specific. What they actually built or are building.>

Traction
<1-2 sentences. Only mention concrete signal you can extract (users, revenue, partnerships, deck, video). If none, write "Pre-product — no traction yet."  Do not invent metrics.>

Team
<1 sentence per founder, focusing on what makes them uniquely positioned. Skip generic descriptors like "passionate" or "driven".>

Ask
<1 sentence. What they're looking for from investors — funding amount if specified, otherwise advice / intros / something specific.>

Rules:
- Plain text only. No bullets, no markdown, no headers beyond the five labels above.
- Each section header on its own line, blank line between sections.
- Translate to English if the input is in another language.
- Don't make up numbers, traction, or relationships not in the source material.
- Total length ≤ 400 words.`,
        cache_control: { type: "ephemeral" },
      },
    ],
    messages: [{ role: "user", content: inputBlock }],
  });

  const text =
    res.content
      .map((b: any) => (b.type === "text" ? b.text : ""))
      .join("")
      .trim() || "";
  if (!text) throw new Error("AI returned an empty tear sheet.");

  await admin
    .from("teams")
    .update({
      tear_sheet: text.slice(0, 4000),
      tear_sheet_generated_at: new Date().toISOString(),
    })
    .eq("id", input.teamId);

  await logAudit({
    action: "team.tear_sheet_generated",
    targetType: "team",
    targetId: input.teamId,
    payload: { length: text.length },
  });

  revalidatePath(`/admin/teams/${input.teamId}`);
  revalidatePath(`/investor/teams/${input.teamId}`);
}
