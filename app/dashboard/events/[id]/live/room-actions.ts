"use server";
import { createAdminClient } from "@/lib/supabase/admin";
import { logAudit } from "@/lib/audit";
import { closeOpenAttendance, notifyRoom, notifyStage } from "@/lib/live-rooms";
import { webinarHasBegun } from "@/lib/live";
import { canEnd, gateRoom, gateVisible } from "@/lib/webinar-gate";
import { withinHardClose } from "@/lib/live-access";

/**
 * Server actions for the webinar room's live state: End, Reopen and the
 * live-state read. The side panel's reads and writes are the route
 * GET/POST /api/live/panel (lib/webinar-data.ts, lib/webinar-panel-writes.ts),
 * off Next's serial action queue.
 *
 * Every action re-runs the room gate (lib/webinar-gate.ts) — a server action
 * is its own entry point.
 */

const roomOf = (eventId: string) => `event:${eventId}`;

// ---------------------------------------------------------------------------
// End, Reopen, live state
// ---------------------------------------------------------------------------

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
