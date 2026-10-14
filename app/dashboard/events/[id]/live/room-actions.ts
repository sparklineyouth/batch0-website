"use server";
import { after } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { logAudit } from "@/lib/audit";
import { runAction, type ActionResult } from "@/lib/action-result";
import { closeOpenAttendance, notifyRoom, notifyStage } from "@/lib/live-rooms";
import { webinarHasBegun } from "@/lib/live";
import { earlyStartSchedule, staleRunStamps } from "@/lib/event-form";
import { canEnd, gateRoom, gateVisible } from "@/lib/webinar-gate";
import { withinHardClose } from "@/lib/live-access";
import { announceLive } from "@/app/admin/events/notify";

/**
 * Server actions for the webinar room's live state: Go live now, End, Reopen
 * and the live-state read. The side panel's reads and writes are the route
 * GET/POST /api/live/panel (lib/webinar-data.ts, lib/webinar-panel-writes.ts),
 * off Next's serial action queue.
 *
 * Every action re-runs the room gate (lib/webinar-gate.ts) — a server action
 * is its own entry point.
 */

const roomOf = (eventId: string) => `event:${eventId}`;

// ---------------------------------------------------------------------------
// Go live now, End, Reopen, live state
// ---------------------------------------------------------------------------

/**
 * Go live now: staff, from a room they are rehearsing in. Inside the go-live
 * window (start − 60 min) a host's arrival already does this (claimStage);
 * before it, this is how a webinar starts early. The run then begins now:
 * the event moves to this minute, keeping its length (earlyStartSchedule),
 * and is stamped live, so the audience is let in, End is offered, and the
 * follow-up and the lists see one run. Everyone the event is for is told
 * it's live (not for a staff-only event). Returns the stored start stamp.
 *
 * Compare-and-set on the stamps and the schedule just read: a host's
 * arrival or an edit in between wins, and this reports what is stored.
 */
export async function goLiveNow(eventId: string): Promise<ActionResult<string>> {
  return runAction({ name: "goLiveNow" }, () => startEarly(eventId));
}

async function startEarly(eventId: string): Promise<string> {
  const gate = await gateVisible(eventId);
  if (!gate?.isStaff) throw new Error("Only staff can start a webinar early.");
  if (gate.liveEndedAt) throw new Error("This webinar has ended.");
  if (gate.liveStartedAt) return gate.liveStartedAt;
  if (!withinHardClose(gate)) throw new Error("This webinar closed a while ago.");

  const admin = createAdminClient();
  const nowDate = new Date();
  const now = nowDate.toISOString();
  const moved = earlyStartSchedule(gate.startsAt, gate.endsAt, nowDate);
  let reset = {};
  if (moved) {
    // A share left over from an earlier run of this row goes with it.
    const { data: prior } = await admin
      .from("events")
      .select("assets_shared_at")
      .eq("id", eventId)
      .maybeSingle();
    reset = staleRunStamps({ assets_shared_at: (prior as any)?.assets_shared_at ?? null }, moved.startsAt);
  }
  let claim = admin
    .from("events")
    .update({
      live_started_at: now,
      ...(moved ? { starts_at: moved.startsAt, ends_at: moved.endsAt, ...reset } : {}),
    })
    .eq("id", eventId)
    .is("live_started_at", null)
    .is("live_ended_at", null);
  if (moved) claim = claim.eq("starts_at", gate.startsAt);
  const { data, error } = await claim
    .select("live_started_at, title, visibility, cohort_id, starts_at, live_mode")
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) {
    const { data: stored } = await admin
      .from("events")
      .select("live_started_at")
      .eq("id", eventId)
      .maybeSingle();
    const started = (stored as any)?.live_started_at as string | null | undefined;
    if (started) return started;
    throw new Error("The schedule just changed. Try again.");
  }
  const row = data as Record<string, string | null>;

  await logAudit({
    action: "event.live_started",
    targetType: "event",
    targetId: eventId,
    payload: moved ? { early: true, scheduledFor: gate.startsAt } : { early: false },
  });
  // Everyone in the room re-reads it. The lists are rendered per request; the
  // cached timetables catch up within minutes (no revalidation here: it would
  // re-render this room's page under the people in it).
  await notifyStage(roomOf(eventId), { t: "room-changed" });

  if (row.visibility !== "staff") {
    const { data: me } = await admin
      .from("profiles")
      .select("full_name")
      .eq("id", gate.userId)
      .maybeSingle();
    const hostName = ((me as { full_name?: string | null } | null)?.full_name ?? "").trim() || "batch0";
    after(() =>
      announceLive(
        {
          id: eventId,
          title: row.title ?? "Webinar",
          startsAt: row.starts_at!,
          visibility: row.visibility ?? "enrolled",
          cohortId: row.cohort_id,
          liveMode: row.live_mode ?? "hosted",
          externalUrl: null,
        },
        hostName,
      ),
    );
  }
  return row.live_started_at ?? now;
}

/**
 * End the webinar for everyone. Returns the STORED `live_ended_at` (the first
 * End wins). Staff always; a guest speaker only with no staff host present;
 * never before the run has begun, never after the hard stop.
 *
 * Stamps the event, closes open polls (their results stay visible), closes
 * open attendance, then publishes `room-changed` on the public stage topic —
 * the one channel every participant holds — so each engine re-asks the server
 * and tears down. Reversible only by staff (Reopen).
 */
export async function endLive(eventId: string): Promise<string> {
  const gate = await gateVisible(eventId);
  if (!gate?.isModerator) throw new Error("Forbidden");
  if (!withinHardClose(gate)) {
    throw new Error("This webinar closed a while ago.");
  }
  if (!webinarHasBegun(gate.startsAt, gate.liveStartedAt)) {
    throw new Error("This webinar hasn't started yet — use Leave to step out.");
  }
  if (!(await canEnd(gate))) {
    throw new Error("A staff host is running this webinar — use Leave to step out.");
  }

  const admin = createAdminClient();
  const now = new Date().toISOString();
  const { data, error } = await admin
    .from("events")
    .update({ live_ended_at: now })
    .eq("id", eventId)
    .is("live_ended_at", null)
    .select("live_ended_at")
    .maybeSingle();
  if (error) throw new Error(error.message);
  const firstEnd = !!data;
  const stored: string =
    (data as any)?.live_ended_at ?? (await readLiveEndedAt(eventId)) ?? now;

  if (firstEnd) {
    // Best-effort: the stamp is what ends the webinar.
    const { error: pollError } = await admin
      .from("webinar_polls")
      .update({ open: false })
      .eq("event_id", eventId)
      .eq("open", true);
    if (pollError) {
      console.error("[webinars] closing polls on end failed", pollError.message);
    }
    await closeOpenAttendance(eventId, stored);
    await logAudit({
      action: "event.live_ended",
      targetType: "event",
      targetId: eventId,
      payload: { byStaff: gate.isStaff },
    });
  }

  // On every call, not only the first: a retry after a dropped broadcast is
  // exactly when a client might still be waiting to hear.
  await notifyStage(roomOf(eventId), { t: "room-changed" });
  await notifyRoom(roomOf(eventId), { t: "bump", what: "poll" });
  return stored;
}

/** Undo an End. Staff only, bounded by the hard stop. */
export async function reopenLive(eventId: string): Promise<void> {
  const gate = await gateVisible(eventId);
  if (!gate?.isStaff) throw new Error("Forbidden");
  if (!withinHardClose(gate)) {
    throw new Error("This webinar closed a while ago.");
  }
  const admin = createAdminClient();
  const { error } = await admin
    .from("events")
    .update({ live_ended_at: null })
    .eq("id", eventId);
  if (error) throw new Error(error.message);
  if (gate.liveEndedAt) {
    await logAudit({
      action: "event.live_reopened",
      targetType: "event",
      targetId: eventId,
    });
  }
  await notifyStage(roomOf(eventId), { t: "room-changed" });
}

async function readLiveEndedAt(eventId: string): Promise<string | null> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("events")
    .select("live_ended_at")
    .eq("id", eventId)
    .maybeSingle();
  return (data as any)?.live_ended_at ?? null;
}

/**
 * The room's live state from the server: started, ended, and whether the
 * reader may End. Null means "not in this room right now"; a failed access
 * read THROWS, so a poller retries instead of reading it as a revocation.
 */
export async function fetchLiveState(eventId: string): Promise<{
  liveStartedAt: string | null;
  liveEndedAt: string | null;
  canEnd: boolean;
  isStaff: boolean;
} | null> {
  const gate = await gateRoom(eventId, { throwOnError: true });
  if (!gate) return null;
  return {
    liveStartedAt: gate.liveStartedAt,
    liveEndedAt: gate.liveEndedAt,
    canEnd: await canEnd(gate),
    isStaff: gate.isStaff,
  };
}
