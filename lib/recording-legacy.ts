import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { listAssets, signedAssetUrl } from "@/lib/webinar-data";
import { CALL_STAFF_OPENS_MINUTES_BEFORE } from "@/lib/live";
import {
  CALL_RECORDING_BUCKET,
  callRecordingFolder,
  sortCallSegments,
} from "@/lib/call-recording";

/**
 * Recordings from before one-take recording (migration 0095): self-contained
 * segment files, played back to back by the legacy player.
 *
 *   webinar  event_assets rows (kind 'recording') in the webinar-media bucket,
 *            in sort_order
 *   call     files under calls/<id>/recording/ in the call-recordings bucket,
 *            ordered by the stamp in their names (lib/call-recording.ts)
 *
 * Read-only: nothing writes either any more, and nothing here deletes them.
 * Like lib/recording-sessions.ts, the caller has checked who may watch.
 */

export type LegacyPart = {
  bucket: "webinar-media" | "call-recordings";
  path: string;
  seconds: number | null;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * `call.startsAt`, when given, skips the bucket listing for a call whose room
 * opened after one-take recording was live: it cannot have segments.
 */
export async function legacyRecording(
  kind: "webinar" | "call",
  roomId: string,
  call?: { startsAt: string | null },
): Promise<LegacyPart[]> {
  if (!UUID.test(roomId)) return [];
  if (kind === "call" && call?.startsAt && (await afterSegments(call.startsAt))) return [];
  if (kind === "webinar") {
    const assets = await listAssets(roomId, ["recording"]);
    return assets.map((a) => ({
      bucket: "webinar-media",
      path: a.storagePath,
      seconds: a.durationSeconds,
    }));
  }
  const folder = callRecordingFolder(roomId);
  try {
    const admin = createAdminClient();
    const { data, error } = await admin.storage
      .from(CALL_RECORDING_BUCKET)
      .list(folder, { limit: 1000 });
    // No bucket (nothing was ever recorded this way) reads as no parts.
    if (error || !data) return [];
    return sortCallSegments(data as { name: string }[]).map((o) => ({
      bucket: "call-recordings",
      path: `${folder}/${o.name}`,
      seconds: null,
    }));
  } catch (err) {
    console.error("[recordings] legacy list failed", roomId, err);
    return [];
  }
}

/**
 * When the first one-take recording started. The segment recorder was gone by
 * then — the code ships before its migration (0095) is applied, and the take
 * needs both — so no room that opened after this has segments. Cached for the
 * process once known (deleting that take only moves the true value later).
 */
let oneTakeSince: number | null = null;

async function afterSegments(startsAt: string): Promise<boolean> {
  if (oneTakeSince === null) {
    const { data, error } = await createAdminClient()
      .from("recording_sessions")
      .select("started_at")
      .order("started_at", { ascending: true })
      .limit(1)
      .maybeSingle();
    const t = !error && data ? Date.parse((data as { started_at: string }).started_at) : NaN;
    if (!Number.isFinite(t)) return false;
    oneTakeSince = t;
  }
  const opens = Date.parse(startsAt) - CALL_STAFF_OPENS_MINUTES_BEFORE * 60_000;
  return Number.isFinite(opens) && opens > oneTakeSince;
}

/** A ten-minute link to one legacy part, minted at the moment it is played. */
export async function signLegacyPart(part: LegacyPart): Promise<string | null> {
  if (part.bucket === "webinar-media") return signedAssetUrl(part.path, 60 * 10);
  try {
    const admin = createAdminClient();
    const { data, error } = await admin.storage
      .from(CALL_RECORDING_BUCKET)
      .createSignedUrl(part.path, 60 * 10);
    if (error) {
      console.error("[recordings] legacy sign failed", error.message);
      return null;
    }
    return data?.signedUrl ?? null;
  } catch (err) {
    console.error("[recordings] legacy sign threw", err);
    return null;
  }
}
