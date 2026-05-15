import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { env } from "@/lib/env";
import { isoWeekStart, mondayOf } from "@/lib/week";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SILENT_WEEKS_THRESHOLD = 2;

/**
 * Auto-create an office-hours nudge for any student who has missed
 * 2+ consecutive check-ins. Writes:
 *   - one notification per assigned mentor ("nudge this student"),
 *     deep-linked to the student's profile
 *   - one row in at_risk_interventions keyed by (student_id, week_start)
 *     so the cron stays idempotent — a student already flagged this
 *     week is skipped on subsequent runs
 *
 * The recipient (the mentor) can then propose a slot through the
 * existing office-hours flow. This cron doesn't book a slot itself —
 * it surfaces the signal so a human can act on it.
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
  const currentWeek = isoWeekStart(new Date());
  const horizonWeek = (() => {
    const d = mondayOf(new Date());
    d.setUTCDate(d.getUTCDate() - 7 * 4);
    return d.toISOString().slice(0, 10);
  })();

  const { data: activeCohorts } = await admin
    .from("cohorts")
    .select("id, name")
    .eq("status", "active");
  if (!activeCohorts || activeCohorts.length === 0) {
    return NextResponse.json({ ok: true, created: 0, reason: "no active cohorts" });
  }
  const cohortIds = activeCohorts.map((c) => c.id);

  const [{ data: enrollments }, { data: recentCheckins }, { data: assignments }, { data: existingInterventions }] =
    await Promise.all([
      admin
        .from("enrollments")
        .select("user_id, cohort_id, user:profiles(full_name, email)")
        .in("cohort_id", cohortIds),
      admin
        .from("student_checkins")
        .select("user_id, week_start")
        .gte("week_start", horizonWeek),
      admin
        .from("mentor_assignments")
        .select("mentor_id, student_id"),
      admin
        .from("at_risk_interventions")
        .select("student_id")
        .eq("week_start", currentWeek),
    ]);

  const alreadyFlagged = new Set(
    (existingInterventions ?? []).map((r: any) => r.student_id),
  );
  const checkinsByUser = new Map<string, Set<string>>();
  for (const c of (recentCheckins ?? []) as any[]) {
    const s = checkinsByUser.get(c.user_id) ?? new Set<string>();
    s.add(c.week_start);
    checkinsByUser.set(c.user_id, s);
  }
  const mentorByStudent = new Map<string, string>();
  for (const a of (assignments ?? []) as any[]) {
    if (!mentorByStudent.has(a.student_id)) {
      mentorByStudent.set(a.student_id, a.mentor_id);
    }
  }

  // Build the rolling 2-week silence window: the current week + the
  // previous week. A student is at-risk if neither week has a check-in.
  const recentWeeks = (() => {
    const out: string[] = [];
    const d = mondayOf(new Date());
    for (let i = 0; i < SILENT_WEEKS_THRESHOLD; i++) {
      out.push(d.toISOString().slice(0, 10));
      d.setUTCDate(d.getUTCDate() - 7);
    }
    return out;
  })();

  let created = 0;
  for (const e of (enrollments ?? []) as any[]) {
    if (alreadyFlagged.has(e.user_id)) continue;
    const got = checkinsByUser.get(e.user_id) ?? new Set();
    const silent = recentWeeks.every((w) => !got.has(w));
    if (!silent) continue;

    const mentorId = mentorByStudent.get(e.user_id) ?? null;
    const profile = Array.isArray(e.user) ? e.user[0] : e.user;

    // Idempotency: insert with the unique (student_id, week_start) key;
    // we ignore the row that already exists.
    const { error: insErr } = await admin
      .from("at_risk_interventions")
      .insert({
        student_id: e.user_id,
        week_start: currentWeek,
        missed_weeks: SILENT_WEEKS_THRESHOLD,
        reason: `No check-ins for ${SILENT_WEEKS_THRESHOLD}+ weeks`,
      });
    if (insErr && !insErr.message.includes("duplicate")) {
      console.error("[at-risk-intervene] insert failed", insErr);
      continue;
    }

    // Notify the assigned mentor (in-app). Falls back to all cohort
    // admins when the student has no mentor.
    if (mentorId) {
      await admin.from("notifications").insert({
        user_id: mentorId,
        type: "intervention",
        title: `${profile?.full_name ?? "A student"} needs a nudge`,
        body: "They've missed two check-ins. Want to offer office hours?",
        link: `/mentor/students/${e.user_id}`,
      });
    } else {
      const { data: admins } = await admin
        .from("profiles")
        .select("id")
        .eq("role", "admin")
        .limit(20);
      for (const a of (admins ?? []) as any[]) {
        await admin.from("notifications").insert({
          user_id: a.id,
          type: "intervention",
          title: `${profile?.full_name ?? "A student"} needs a mentor`,
          body: "Unassigned student missed two check-ins. Assign a mentor and offer office hours.",
          link: `/admin/students/${e.user_id}`,
        });
      }
    }

    created += 1;
  }

  return NextResponse.json({ ok: true, weekStart: currentWeek, created });
}
