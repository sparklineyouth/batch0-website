import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { notifyMany } from "@/lib/notifications";
import { sendEmail } from "@/lib/email/send";
import { Templates } from "@/lib/email/templates";
import { env } from "@/lib/env";
import { DEFAULT_EVENT_MINUTES } from "@/lib/live";
import { listAssets } from "@/lib/webinar-data";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// One run can fan out to a whole cohort, and `sendEmail` is a network round
// trip each. A 40-student webinar is 40 sequential sends; the default 10s would
// cut that off partway and leave `assets_shared_at` unset, so the next run
// would start again from the top and re-mail everyone it had already reached.
export const maxDuration = 300;

/**
 * Send the deck and the recording out after a webinar ends.
 *
 * This is the whole of `auto_share`. Without it the checkbox in the admin form
 * is inert — the column would be set, the index would exist, and nothing would
 * ever read either.
 *
 * ---------------------------------------------------------------------------
 * Why it is a cron and not the end of the webinar
 * ---------------------------------------------------------------------------
 *
 * The obvious place to do this is when the host presses End. It is the wrong
 * place for two reasons, and both of them have happened to this feature's
 * predecessors:
 *
 *  1. The recording is not finished then. Segments upload while the webinar
 *     runs, and the last one is still in flight at the moment the host clicks
 *     away — so a follow-up sent from the End button promises a recording that
 *     is missing its final five minutes.
 *  2. Hosts do not always press End. They close the laptop. A webinar that
 *     ended by the tab going away has no client left to run anything, and the
 *     students who missed it are exactly the ones the email is for.
 *
 * A job that asks "which webinars have ended and not been shared" is immune to
 * both. It also makes the operation idempotent in the only way that matters:
 * `assets_shared_at` is the claim, it is stamped BEFORE the sending starts, and
 * a webinar can therefore be shared once however many times this runs, however
 * it is retried, and however it fails partway.
 *
 * ---------------------------------------------------------------------------
 * Who gets it
 * ---------------------------------------------------------------------------
 *
 * Everyone enrolled in the cohort, whether or not they turned up — the people
 * who most need a recording are the ones who missed it, and a follow-up that
 * only reaches attendees reaches the people who least need it. `live_participants`
 * is consulted only to change the opening sentence.
 *
 * A webinar with no cohort (a public one) has no invite list to work from, so
 * it is skipped and stamped: there is nobody to send to, and leaving it unstamped
 * would have this job reconsider it on every run forever.
 */

/** Wait this long after the end before sending. */
const SETTLE_MINUTES = 15;

export async function GET(req: Request) {
  // Fail closed when CRON_SECRET isn't configured. An open endpoint here
  // doesn't just burn CPU — it sends real email to real people on demand.
  if (!env.cronSecret) {
    return new Response("CRON_SECRET not configured", { status: 500 });
  }
  const auth = req.headers.get("authorization");
  if (auth !== `Bearer ${env.cronSecret}`) {
    return new Response("Unauthorized", { status: 401 });
  }

  const admin = createAdminClient();
  const now = Date.now();

  // Candidates: wants sharing, not yet shared. The "has it ended" test is done
  // in JS rather than in the query because `ends_at` is nullable and the
  // fallback is DEFAULT_EVENT_MINUTES past the start — a rule that lives in
  // lib/live.ts and that the rest of the system already agrees on. Encoding it
  // as SQL interval arithmetic here would be a second copy to keep in step.
  const { data: rows, error } = await admin
    .from("events")
    .select("id, title, cohort_id, starts_at, ends_at")
    .eq("auto_share", true)
    .is("assets_shared_at", null)
    .lte("starts_at", new Date(now).toISOString())
    .limit(20);
  if (error) {
    // 42703/PGRST204 here means 0084 has not been applied yet. That is not an
    // incident — it is a deploy that landed before the SQL was pasted in — so
    // it is reported rather than thrown, and the next run picks it up.
    console.error("[cron/webinar-followups] candidate read failed", error.message);
    return NextResponse.json({ error: error.message }, { status: 200 });
  }

  const due = (rows ?? []).filter((e: any) => {
    const end = e.ends_at
      ? new Date(e.ends_at).getTime()
      : new Date(e.starts_at).getTime() + DEFAULT_EVENT_MINUTES * 60_000;
    return now >= end + SETTLE_MINUTES * 60_000;
  });

  const report: Record<string, unknown>[] = [];

  for (const ev of due as any[]) {
    // CLAIM FIRST. Stamping before the fan-out is what makes a run that dies
    // halfway — a timeout, a deploy, a Resend outage — cost one webinar's
    // follow-up rather than mailing the whole cohort twice on the next run.
    // The `is null` guard makes the claim atomic against a concurrent run.
    const { data: claimed } = await admin
      .from("events")
      .update({ assets_shared_at: new Date().toISOString() })
      .eq("id", ev.id)
      .is("assets_shared_at", null)
      .select("id")
      .maybeSingle();
    if (!claimed) continue; // somebody else got it

    try {
      const assets = await listAssets(ev.id);
      const hasRecording = assets.some((a) => a.kind === "recording");
      const hasDeck = assets.some(
        (a) => a.kind === "deck" || a.kind === "handout",
      );
      if (!hasRecording && !hasDeck) {
        report.push({ id: ev.id, skipped: "nothing-to-share" });
        continue;
      }
      if (!ev.cohort_id) {
        report.push({ id: ev.id, skipped: "no-cohort" });
        continue;
      }

      const [{ data: enrollments }, { data: attended }] = await Promise.all([
        admin
          .from("enrollments")
          .select("user_id, profile:profiles(email, full_name)")
          .eq("cohort_id", ev.cohort_id),
        admin
          .from("live_participants")
          .select("user_id")
          .eq("event_id", ev.id),
      ]);

      const cameIds = new Set(
        ((attended ?? []) as any[]).map((r) => r.user_id),
      );
      const recipients = (enrollments ?? []) as any[];
      // The events list, not /dashboard/events/<id>: there is no page at that
      // path (only /<id>/live, which closes with the join window), so both the
      // email button and the bell linked every recipient to a 404. The list is
      // the student page that exists, and it is where a past webinar is shown.
      const eventUrl = `${env.siteUrl}/dashboard/events`;

      await notifyMany(
        recipients.map((r) => ({
          userId: r.user_id,
          type: "event_posted",
          title: ev.title,
          body: hasRecording
            ? "The recording and the slides are up."
            : "The slides are up.",
          link: "/dashboard/events",
        })),
      );

      let sent = 0;
      for (const r of recipients) {
        const profile = Array.isArray(r.profile) ? r.profile[0] : r.profile;
        const to = profile?.email;
        if (!to) continue;
        const t = Templates.webinarFollowUp({
          title: ev.title,
          eventUrl,
          hasRecording,
          hasDeck,
          attended: cameIds.has(r.user_id),
        });
        try {
          await sendEmail({ to, subject: t.subject, html: t.html });
          sent += 1;
        } catch (err) {
          // One bad address must not stop the other thirty-nine. The webinar is
          // already claimed, so this address simply misses out — which is the
          // right trade against re-mailing everyone to retry one.
          console.error("[cron/webinar-followups] send failed", to, err);
        }
      }
      report.push({ id: ev.id, sent, hasRecording, hasDeck });
    } catch (err) {
      console.error("[cron/webinar-followups]", ev.id, err);
      report.push({ id: ev.id, error: String(err) });
    }
  }

  return NextResponse.json({ considered: due.length, report });
}
