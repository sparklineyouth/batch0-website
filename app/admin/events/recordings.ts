import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { isMissingSchemaError } from "@/lib/schema-ready";

type Admin = ReturnType<typeof createAdminClient>;

/**
 * The events admin's view of recordings: which past events have one (for the
 * list's "Recording" link) and removing them with their event.
 *
 * Two generations: legacy two-minute segments (event_assets kind='recording',
 * webinar-media bucket) and one-take recordings (recording_sessions, private
 * `recordings` bucket, migration 0095). The second has no foreign key to
 * events, so nothing cascades. Until 0095 is applied it simply isn't there.
 */

const RECORDINGS_BUCKET = "recordings";

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

/**
 * Best effort, after the event row is gone: every take's files, then its
 * row. A failure is logged and leaves an orphan nobody can open (playback
 * re-checks the event), never a half-deleted event.
 */
export async function deleteEventRecordings(admin: Admin, eventId: string): Promise<void> {
  const { data, error } = await admin
    .from("recording_sessions")
    .select("id, storage_prefix")
    .eq("room_kind", "webinar")
    .eq("room_id", eventId);
  if (error) {
    if (!isMissingSchemaError(error)) {
      console.error("[events] recording cleanup failed", eventId, error.message);
    }
    return;
  }
  for (const take of (data ?? []) as { id: string; storage_prefix: string | null }[]) {
    try {
      const prefix = (take.storage_prefix ?? "").replace(/\/+$/, "");
      // Only this event's folder (webinar/<eventId>/<takeId>), never a bare prefix.
      if (prefix.startsWith(`webinar/${eventId}/`)) {
        const names = await listFolder(admin, prefix);
        for (let i = 0; i < names.length; i += 500) {
          const { error: rmError } = await admin.storage
            .from(RECORDINGS_BUCKET)
            .remove(names.slice(i, i + 500).map((n) => `${prefix}/${n}`));
          if (rmError) throw new Error(rmError.message);
        }
      }
      const { error: delError } = await admin.from("recording_sessions").delete().eq("id", take.id);
      if (delError) throw new Error(delError.message);
    } catch (err) {
      console.error("[events] recording cleanup failed", take.id, err);
    }
  }
}

async function listFolder(admin: Admin, prefix: string): Promise<string[]> {
  const names: string[] = [];
  for (let offset = 0; offset < 20_000; offset += 1000) {
    const { data, error } = await admin.storage
      .from(RECORDINGS_BUCKET)
      .list(prefix, { limit: 1000, offset, sortBy: { column: "name", order: "asc" } });
    if (error) throw new Error(`list ${prefix}: ${error.message}`);
    for (const o of data ?? []) names.push(o.name);
    if ((data ?? []).length < 1000) break;
  }
  return names;
}
