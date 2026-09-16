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
 *     deep-linked to the student's profile, carrying a dedupe key so the
 *     notifications table itself refuses a second copy
 *   - one row in at_risk_interventions keyed by (student_id, week_start)
 *     so the cron stays idempotent — a student already flagged this
 *     week is skipped on subsequent runs, whether we read the flag up
 *     front or learn it from the unique key mid-loop
 *
 * Idempotency is the whole contract here, so the run ABORTS rather than
 * proceeds when it can't read this week's existing flags: a mentor nudged
 * twice about the same student stops reading the nudges.
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

  const [{ data: enrollments }, { data: recentCheckins }, { data: assignments }, { data: existingInterventions, error: interventionsErr }] =
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

  // This one read IS the idempotency. Swallowing its error and carrying on
  // with an empty set doesn't degrade gracefully — it re-processes every
  // student already flagged this week, and the DB can only stop the duplicate
  // intervention row, not the duplicate mentor nudge. So a failed read ends the
  // run; the next Monday tick (or a manual re-run) is a full retry.
  if (interventionsErr) {
    console.error("[at-risk-intervene] intervention read failed", interventionsErr);
    return NextResponse.json(
      { ok: false, error: "intervention read failed" },
      { status: 500 },
    );
  }

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

    // Idempotency: the unique (student_id, week_start) key is what decides
    // whether this student has already been flagged this week, so a 23505 is
    // not a failure — it is the answer "already handled", and it has to skip
    // the nudge below as well. Matching on the message text used to let a
    // duplicate fall THROUGH to the notification, which is how one bad read
    // sent every mentor a second identical nudge.
    const { error: insErr } = await admin
      .from("at_risk_interventions")
      .insert({
        student_id: e.user_id,
        week_start: currentWeek,
        missed_weeks: SILENT_WEEKS_THRESHOLD,
        reason: `No check-ins for ${SILENT_WEEKS_THRESHOLD}+ weeks`,
      });
    if (insErr) {
      if ((insErr as any).code !== "23505") {
        console.error("[at-risk-intervene] insert failed", insErr);
      }
      continue;
    }
    // Remember the flag in-process too: enrollments are unique per (user,
    // cohort), so a student in two simultaneously-active cohorts comes round
    // this loop once per enrollment, and leaving that to the unique key means
    // spending an insert to learn what we already know.
    alreadyFlagged.add(e.user_id);

    // Notify the assigned mentor (in-app). Falls back to all cohort
    // admins when the student has no mentor. Keyed like checkin-nudge so
    // notifications' partial unique index is the last line of defence if a
    // re-run ever gets this far.
    if (mentorId) {
      await admin.from("notifications").insert({
        user_id: mentorId,
        type: "intervention",
        title: `${profile?.full_name ?? "A student"} needs a nudge`,
        body: "They've missed two check-ins. Want to offer office hours?",
        link: `/mentor/students/${e.user_id}`,
        dedupe_key: `intervention:${e.user_id}:${currentWeek}`,
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
          dedupe_key: `intervention:${e.user_id}:${currentWeek}`,
        });
      }
    }

    created += 1;
  }

  return NextResponse.json({ ok: true, weekStart: currentWeek, created });
}
