import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { isMissingSchemaError } from "@/lib/schema-ready";

type Admin = ReturnType<typeof createAdminClient>;

/**
 * Which past events have a recording, for the events list's "Recording" link.
 * (Deleting an event removes its takes through deleteRoomRecordings in
 * lib/recording-sessions.ts.)
 *
 * Two generations: legacy two-minute segments (event_assets kind='recording',
 * webinar-media bucket) and one-take recordings (recording_sessions, private
 * `recordings` bucket, migration 0095). The second has no foreign key to
 * events, so nothing cascades. Until 0095 is applied it simply isn't there.
 */

/** Of these event ids, the ones with something to play. */
export async function recordedEventIds(admin: Admin, eventIds: string[]): Promise<Set<string>> {
  const out = new Set<string>();
  if (eventIds.length === 0) return out;
  const [legacy, takes] = await Promise.all([
    admin.from("event_assets").select("event_id").eq("kind", "recording").in("event_id", eventIds),
    admin
      .from("recording_sessions")
      .select("room_id")
      .eq("room_kind", "webinar")
      .in("room_id", eventIds)
      .in("status", ["finished", "interrupted"])
      .not("finalized_at", "is", null)
      .gt("part_count", 0),
  ]);
  for (const r of (legacy.data ?? []) as { event_id: string }[]) out.add(r.event_id);
  if (takes.error) {
    if (!isMissingSchemaError(takes.error)) {
      console.error("[events] recording lookup failed", takes.error.message);
    }
  } else {
    for (const r of (takes.data ?? []) as { room_id: string }[]) out.add(r.room_id);
  }
  return out;
}
