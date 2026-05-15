import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { sendEmail } from "@/lib/email/send";
import { Templates } from "@/lib/email/templates";
import { env } from "@/lib/env";
import { isoWeekStart, formatWeekRange } from "@/lib/week";
import Anthropic from "@anthropic-ai/sdk";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Per-team weekly recap. Pulls the team's check-ins + thread messages
 * + milestones for the week, asks Claude Haiku for a plain-language
 * summary, and emails parents + mentors. Idempotent via
 * founder_recap_log unique(team_id, week_start) — re-running the same
 * day is a no-op for already-sent teams.
 *
 * Runs Mondays at 16:00 UTC so parents get it before the school week
 * picks up and they have ammunition for "how's the startup going?"
 */
export async function GET(req: Request) {
  if (!env.cronSecret) {
    return new Response("CRON_SECRET not configured", { status: 500 });
  }
  const auth = req.headers.get("authorization");
  if (auth !== `Bearer ${env.cronSecret}`) {
    return new Response("Unauthorized", { status: 401 });
  }

  const admin = createAdminClient();

  // Last completed week = week starting 7 days before this Monday.
  const thisMonday = isoWeekStart(new Date());
  const lastWeekStart = (() => {
    const d = new Date(thisMonday);
    d.setUTCDate(d.getUTCDate() - 7);
    return d.toISOString().slice(0, 10);
  })();
  const range = formatWeekRange(lastWeekStart);

  const { data: activeCohorts } = await admin
    .from("cohorts")
    .select("id, name")
    .eq("status", "active");
  if (!activeCohorts || activeCohorts.length === 0) {
    return NextResponse.json({ ok: true, sent: 0, reason: "no active cohorts" });
  }
  const cohortIds = activeCohorts.map((c) => c.id);

  const { data: teams } = await admin
    .from("teams")
    .select("id, name, cohort_id")
    .in("cohort_id", cohortIds);
  if (!teams || teams.length === 0) {
    return NextResponse.json({ ok: true, sent: 0, reason: "no teams" });
  }

  // Pre-fetch what we need: members, check-ins for last week, recent
  // team_messages, and already-sent recap rows so we can skip them.
  const teamIds = teams.map((t) => t.id);
  const [
    { data: memberships },
    { data: lastWeekRecaps },
    { data: parents },
  ] = await Promise.all([
    admin
      .from("team_members")
      .select(
        "team_id, user_id, profile:profiles(id, email, full_name)",
      )
      .in("team_id", teamIds),
    admin
      .from("founder_recap_log")
      .select("team_id")
      .eq("week_start", lastWeekStart),
    admin
      .from("applications")
      .select("user_id, parent_email")
      .not("parent_email", "is", null),
  ]);

  const alreadySent = new Set(
    (lastWeekRecaps ?? []).map((r: any) => r.team_id),
  );
  const parentEmailByUser = new Map<string, string>();
  for (const a of (parents ?? []) as any[]) {
    if (!parentEmailByUser.has(a.user_id) && a.parent_email) {
      parentEmailByUser.set(a.user_id, a.parent_email);
    }
  }

  const client = env.anthropicApiKey
    ? new Anthropic({ apiKey: env.anthropicApiKey })
    : null;

  let sent = 0;
  let skipped = 0;
  for (const team of teams) {
    if (alreadySent.has(team.id)) {
      skipped += 1;
      continue;
    }
    const teamMembers = (memberships ?? []).filter(
      (m: any) => m.team_id === team.id,
    );
    const memberIds = teamMembers.map((m: any) => m.user_id);
    if (memberIds.length === 0) continue;

    const lastWeekEnd = (() => {
      const d = new Date(`${lastWeekStart}T00:00:00Z`);
      d.setUTCDate(d.getUTCDate() + 7);
      return d.toISOString();
    })();

    const [{ data: checkins }, { data: msgs }] = await Promise.all([
      admin
        .from("student_checkins")
        .select("user_id, week_start, accomplished, next_up, blockers")
        .in("user_id", memberIds)
        .eq("week_start", lastWeekStart),
      admin
        .from("team_messages")
        .select("body, created_at, kind")
        .eq("team_id", team.id)
        .gte("created_at", `${lastWeekStart}T00:00:00Z`)
        .lt("created_at", lastWeekEnd)
        .order("created_at", { ascending: true })
        .limit(60),
    ]);

    // Skip teams that produced nothing — no recap to write.
    if ((checkins?.length ?? 0) === 0 && (msgs?.length ?? 0) === 0) {
      skipped += 1;
      continue;
    }

    const inputBlocks: string[] = [];
    for (const c of (checkins ?? []) as any[]) {
      const member = teamMembers.find((m: any) => m.user_id === c.user_id);
      const profile = Array.isArray(member?.profile)
        ? member.profile[0]
        : member?.profile;
      const name = profile?.full_name ?? "Member";
      inputBlocks.push(
        `## ${name}'s check-in\n` +
          [
            c.accomplished && `Shipped: ${c.accomplished}`,
            c.next_up && `Next: ${c.next_up}`,
            c.blockers && `Blockers: ${c.blockers}`,
          ]
            .filter(Boolean)
            .join("\n"),
      );
    }
    if ((msgs?.length ?? 0) > 0) {
      const sample = (msgs ?? [])
        .filter((m: any) => m.kind !== "system")
        .slice(-12)
        .map((m: any) => `- ${m.body.slice(0, 200)}`)
        .join("\n");
      if (sample) {
        inputBlocks.push(`## Team thread snippets\n${sample}`);
      }
    }

    let summary =
      `${team.name} kept moving this week — see the check-ins below for what got shipped.`;
    let headlines: string[] = [];
    let blockers: string[] = [];
    if (client && inputBlocks.length > 0) {
      try {
        const msg = await client.messages.create({
          model: "claude-haiku-4-5-20251001",
          max_tokens: 700,
          system:
            "You're writing a weekly recap for a parent or mentor of a high-school startup team. " +
            "Tone: warm, plain English, no jargon. Return JSON with shape " +
            '{"summary": string (2-3 short paragraphs), "headlines": string[] (3-5 wins, each ≤120 chars), "blockers": string[] (0-3 specific blockers, each ≤120 chars)}. ' +
            "Be concrete — quote what students actually did. If there's nothing to celebrate, say so honestly.",
          messages: [
            {
              role: "user",
              content: `Team: ${team.name}\nWeek: ${range}\n\n${inputBlocks.join("\n\n")}`,
            },
          ],
        });
        const text = msg.content
          .filter((c) => c.type === "text")
          .map((c: any) => c.text)
          .join("\n")
          .trim();
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]) as {
            summary?: string;
            headlines?: string[];
            blockers?: string[];
          };
          if (parsed.summary) summary = parsed.summary;
          if (Array.isArray(parsed.headlines)) headlines = parsed.headlines;
          if (Array.isArray(parsed.blockers)) blockers = parsed.blockers;
        }
      } catch (err) {
        console.error("[founder-recap] AI failed for team", team.id, err);
      }
    }

    // Recipients = parent emails (one per member with one on file) +
    // assigned mentors. We dedupe — a single parent who got listed
    // twice won't get the email twice.
    const recipients = new Set<string>();
    for (const m of teamMembers) {
      const parentEmail = parentEmailByUser.get(m.user_id);
      if (parentEmail) recipients.add(parentEmail.toLowerCase());
    }
    const { data: assigns } = await admin
      .from("mentor_assignments")
      .select("mentor:profiles(email)")
      .in("student_id", memberIds);
    const mentorIds: string[] = [];
    for (const a of (assigns ?? []) as any[]) {
      const m = Array.isArray(a.mentor) ? a.mentor[0] : a.mentor;
      if (m?.email) recipients.add(m.email.toLowerCase());
    }

    const tpl = Templates.founderWeeklyRecap({
      teamName: team.name,
      weekRange: range,
      summary,
      headlines,
      blockers,
    });
    let recipientsHit = 0;
    for (const to of recipients) {
      const res = await sendEmail({
        to,
        subject: tpl.subject,
        html: tpl.html,
      });
      if (res.ok) recipientsHit += 1;
    }

    await admin.from("founder_recap_log").insert({
      team_id: team.id,
      week_start: lastWeekStart,
      summary,
      parent_emails: Array.from(recipients),
      mentor_ids: mentorIds,
    });
    if (recipientsHit > 0) sent += 1;
  }

  return NextResponse.json({
    ok: true,
    weekStart: lastWeekStart,
    teamsSent: sent,
    skipped,
  });
}
