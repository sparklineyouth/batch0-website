import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { notifyMany } from "@/lib/notifications";
import { sendEmail } from "@/lib/email/send";
import { Templates } from "@/lib/email/templates";
import { env } from "@/lib/env";
import { JOIN_CLOSES_MINUTES_AFTER, roomWindow } from "@/lib/live";
import { PEER_TIMEOUT_MS } from "@/lib/live-signal";
import { presentHosts } from "@/lib/live-rooms";
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
 *
 * A STAFF-visibility event is never shared. That is a rehearsal or an internal
 * session, and an admin who ticked auto-share on the form (or copied a row that
 * had it) must not end up mailing a rehearsal recording to a whole cohort.
 *
 * ---------------------------------------------------------------------------
 * When a webinar counts as over
 * ---------------------------------------------------------------------------
 *
 *   - A host pressed End DURING THE RUN (`live_ended_at` at or after the
 *     scheduled start): SETTLE_MINUTES after that. The accurate case — it
 *     catches a webinar that ended early, and never fires on one still
 *     running past its scheduled end.
 *   - An End from BEFORE the start is a rehearsal's, not this run's, and is
 *     ignored. Hosts can open the room an hour early; a host who rehearsed at
 *     17:10 and pressed End used to make an 18:00 webinar "due" the moment
 *     its start passed — the cohort was mailed "the recording and the slides
 *     are up" as the talk began, and the claim meant the real follow-up
 *     never went out.
 *   - Nobody pressed End: SETTLE_MINUTES after the audience's window closed
 *     (scheduled end + JOIN_CLOSES_MINUTES_AFTER) — but not while a host is
 *     still in the room. An overrunning talk keeps its audience past end+30m
 *     for as long as a host is present (up to the hard stop at end+3h), and
 *     the old schedule-only rule mailed "the recording is up" at end+45m to a
 *     cohort half of whom were still watching it. Such a row is skipped as
 *     `still-running` and picked up once a host presses End (then it is due
 *     at that + SETTLE_MINUTES), once the last host's heartbeat goes stale,
 *     or at the hard stop, whichever comes first.
 *
 * The claim also re-checks `live_ended_at` against what was read, so a Reopen
 * (or an End) landing between the read and the claim cancels this run's send
 * instead of racing it.
 */

/** Wait this long after the end before sending. */
const SETTLE_MINUTES = 15;

/**
 * How long to keep waiting for a recording that auto-record should have made.
 *
 * With auto-record on, "no assets yet" right after the end usually means the
 * final segments are still uploading (or registering) — not that there is
 * nothing to share. Stamping `nothing-to-share` then would permanently skip a
 * webinar whose recording lands five minutes later. So such a webinar is left
 * unclaimed and reconsidered on later runs, up to this long past its due time,
 * after which it really is treated as having nothing.
 *
 * Measured from the due time, not from when the room actually emptied. An
 * overrun nobody ended is skipped as `still-running` before this is consulted
 * at all, and overruns are capped at the hard stop (end + 3h), so the grace
 * only runs short for a talk that overran by more than ~2 hours — and that
 * one has been uploading segments the whole time.
 */
const RECORDING_GRACE_MINUTES = 120;

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
    .select(
      "id, title, cohort_id, starts_at, ends_at, live_ended_at, visibility, auto_record",
    )
    .eq("auto_share", true)
    .is("assets_shared_at", null)
    .neq("visibility", "staff")
    .lte("starts_at", new Date(now).toISOString())
    .limit(20);
  if (error) {
    // 42703/PGRST204 here means 0084 has not been applied yet. That is not an
    // incident — it is a deploy that landed before the SQL was pasted in — so
    // it is reported rather than thrown, and the next run picks it up.
    console.error("[cron/webinar-followups] candidate read failed", error.message);
    return NextResponse.json({ error: error.message }, { status: 200 });
  }

  // This run's End, if it has one: a stamp from before the scheduled start is
  // a rehearsal's (see the header) and does not count.
  const endedAt = (e: any): number | null => {
    if (!e.live_ended_at) return null;
    const at = new Date(e.live_ended_at).getTime();
    return at >= new Date(e.starts_at).getTime() ? at : null;
  };
  const dueAt = (e: any): number =>
    (endedAt(e) ??
      roomWindow(e.starts_at, e.ends_at).end +
        JOIN_CLOSES_MINUTES_AFTER * 60_000) +
    SETTLE_MINUTES * 60_000;
  const due = (rows ?? []).filter((e: any) => now >= dueAt(e));

  const report: Record<string, unknown>[] = [];

  for (const ev of due as any[]) {
    // Nobody has ended this run: is a host still in the room? Same presence
    // rule as the viewer window's overrun extension (roomAccessFor), and
    // bounded by the same hard stop, so a forgotten host tab cannot hold the
    // follow-up back past end+3h. An unreadable attendance table counts as
    // nobody present, as it does there — the schedule fallback still fires.
    if (endedAt(ev) === null) {
      const w = roomWindow(ev.starts_at, ev.ends_at);
      if (now <= w.hardCloseAt) {
        const hosts = await presentHosts(ev.id, PEER_TIMEOUT_MS);
        if (hosts && hosts.length > 0) {
          report.push({ id: ev.id, skipped: "still-running" });
          continue;
        }
      }
    }

    // Look before claiming, for one case only: an auto-recorded webinar with
    // no recording attached yet, still inside the grace period, is left
    // UNCLAIMED so a later run can share the recording once its segments land
    // (rather than stamping `nothing-to-share`, or mailing "the slides are up"
    // an hour before the recording would have been). Reading first costs
    // nothing — the claim below is still the atomic guard.
    if (ev.auto_record && now < dueAt(ev) + RECORDING_GRACE_MINUTES * 60_000) {
      const early = await listAssets(ev.id, ["recording"]);
      if (early.length === 0) {
        report.push({ id: ev.id, skipped: "waiting-for-recording" });
        continue;
      }
    }

    // CLAIM FIRST. Stamping before the fan-out is what makes a run that dies
    // halfway — a timeout, a deploy, a Resend outage — cost one webinar's
    // follow-up rather than mailing the whole cohort twice on the next run.
    // The `is null` guard makes the claim atomic against a concurrent run,
    // and the `live_ended_at` guard makes it conditional on the End this run
    // decided from: a Reopen (or an End) since the read means the webinar is
    // not over in the way we thought, and a later run will decide again.
    let claim = admin
      .from("events")
      .update({ assets_shared_at: new Date().toISOString() })
      .eq("id", ev.id)
      .is("assets_shared_at", null);
    claim = ev.live_ended_at
      ? claim.eq("live_ended_at", ev.live_ended_at)
      : claim.is("live_ended_at", null);
    const { data: claimed } = await claim.select("id").maybeSingle();
    if (!claimed) continue; // somebody else got it, or the room changed

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
      // One path for the email button and the notification, so they cannot
      // drift: the event's room page, which after the webinar lists the
      // recording and the slides for whoever may see them. It used to be
      // /dashboard/events/<id>, which had no page at all — every "watch the
      // recording" click was a 404. (That path now redirects here, for the
      // links already sitting in inboxes.)
      const eventPath = `/dashboard/events/${ev.id}/live`;
      const eventUrl = `${env.siteUrl}${eventPath}`;

      await notifyMany(
        recipients.map((r) => ({
          userId: r.user_id,
          type: "event_posted",
          title: ev.title,
          body: hasRecording
            ? "The recording and the slides are up."
            : "The slides are up.",
          link: eventPath,
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
