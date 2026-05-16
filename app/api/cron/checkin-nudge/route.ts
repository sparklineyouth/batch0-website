import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { sendDirectMessage, isDiscordEnabled } from "@/lib/discord";
import { env } from "@/lib/env";
import { isoWeekStart } from "@/lib/week";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Weekly Discord DM nudge for students who haven't posted this week's
 * check-in yet. Designed to run Sunday evening so students hit Monday
 * morning with the check-in fresh in their head.
 *
 * Skips:
 *   - users with no Discord link (we can't reach them)
 *   - users who already submitted a check-in this ISO week
 *   - users with no active enrollment (check-ins are cohort-only)
 *
 * Best-effort: Discord refuses DMs if the user has them off; we log
 * and move on. Each DM is keyed by the current week so a re-run on
 * the same day doesn't double-message anyone.
 */
export async function GET(req: Request) {
  if (!env.cronSecret) {
    return new Response("CRON_SECRET not configured", { status: 500 });
  }
  const auth = req.headers.get("authorization");
  if (auth !== `Bearer ${env.cronSecret}`) {
    return new Response("Unauthorized", { status: 401 });
  }
  if (!(await isDiscordEnabled())) {
    return NextResponse.json({ skipped: "discord-disabled" });
  }

  const admin = createAdminClient();
  const week = isoWeekStart();

  // 1. All enrolled users who have linked Discord.
  const { data: enrollments } = await admin
    .from("enrollments")
    .select("user_id, cohort_id, profile:profiles(discord_user_id, full_name)")
    .not("user_id", "is", null);

  type Row = {
    user_id: string;
    cohort_id: string | null;
    discord_user_id: string | null;
    full_name: string | null;
  };
  const candidates: Row[] = (enrollments ?? [])
    .map((e: any) => {
      const p = Array.isArray(e.profile) ? e.profile[0] : e.profile;
      return {
        user_id: e.user_id,
        cohort_id: e.cohort_id ?? null,
        discord_user_id: p?.discord_user_id ?? null,
        full_name: p?.full_name ?? null,
      } as Row;
    })
    .filter((r) => !!r.discord_user_id);

  if (candidates.length === 0) {
    return NextResponse.json({ sent: 0, skipped: 0, reason: "no candidates" });
  }

  // 2. Which of them already checked in this week?
  const { data: existing } = await admin
    .from("student_checkins")
    .select("user_id")
    .eq("week_start", week)
    .in("user_id", candidates.map((c) => c.user_id));
  const alreadyCheckedIn = new Set((existing ?? []).map((e: any) => e.user_id));

  // 3. Throttle: skip anyone we already nudged this week. We piggy-back
  //    on notifications.dedupe_key so we don't need a new table.
  const dedupeKeys = candidates.map((c) => `checkin_nudge:${c.user_id}:${week}`);
  const { data: prior } = await admin
    .from("notifications")
    .select("dedupe_key")
    .in("dedupe_key", dedupeKeys);
  const alreadyNudged = new Set((prior ?? []).map((p: any) => p.dedupe_key));

  let sent = 0;
  let skipped = 0;
  let failed = 0;
  for (const c of candidates) {
    if (alreadyCheckedIn.has(c.user_id)) {
      skipped++;
      continue;
    }
    const key = `checkin_nudge:${c.user_id}:${week}`;
    if (alreadyNudged.has(key)) {
      skipped++;
      continue;
    }

    const ok = await sendDirectMessage(c.discord_user_id!, {
      embeds: [
        {
          title: "Quick check-in?",
          description: [
            `Hey${c.full_name ? `, ${c.full_name}` : ""} — your weekly SparkLine Youth check-in for the week of **${week}** is empty.`,
            "",
            "Run `/checkin` right here to post it in 30 seconds, or open the dashboard:",
            `${env.siteUrl}/dashboard/checkin`,
          ].join("\n"),
          color: 0xfacc15,
        },
      ],
    });
    if (ok) {
      sent++;
      // Record the nudge so we don't double-fire.
      await admin
        .from("notifications")
        .insert({
          user_id: c.user_id,
          type: "checkin_nudge",
          title: "We DM'd you a check-in nudge",
          body: null,
          link: "/dashboard/checkin",
          dedupe_key: key,
        })
        .then(() => {}, () => {});
    } else {
      failed++;
    }
  }

  return NextResponse.json({ week, sent, skipped, failed });
}
