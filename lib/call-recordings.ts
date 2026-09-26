import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { splitCalls } from "@/lib/call-lifecycle";
import {
  CALL_RECORDING_BUCKET,
  CALL_RECORDING_MAX_BYTES,
  callRecordingFolder,
  isUuid,
  sortCallSegments,
} from "@/lib/call-recording";
import type { CallInvite } from "@/lib/live";

/**
 * Service-role reads of 1:1 call recordings.
 *
 * The recording has no table — the segment files in
 * `call-recordings/calls/<id>/recording/` are the whole record (see the header
 * of lib/call-recording.ts for why). So "list a call's recording" is a storage
 * listing, and "play part 2" is a signed URL for the second file in order.
 *
 * Same contract as lib/webinar-data.ts: NOTHING HERE DECIDES WHO MAY CALL IT.
 * Every caller has already checked `canViewCallRecording` (the two people on
 * the call, and admins) against the invite row; these functions sign whatever
 * they are handed.
 */

/**
 * Make sure the private `call-recordings` bucket exists — created by the app on
 * first use rather than by a migration (see lib/call-recording.ts for why it
 * is separate from webinar-media). Private, and deliberately given no storage
 * policies: only the service role reaches it. Idempotent, and memoised per
 * server instance so it costs one round trip, not one per upload.
 */
let bucketReady: Promise<void> | null = null;
export function ensureCallRecordingBucket(): Promise<void> {
  bucketReady ??= (async () => {
    const admin = createAdminClient();
    const { data } = await admin.storage.getBucket(CALL_RECORDING_BUCKET);
    if (data) return;
    const { error } = await admin.storage.createBucket(CALL_RECORDING_BUCKET, {
      public: false,
      fileSizeLimit: CALL_RECORDING_MAX_BYTES,
      allowedMimeTypes: ["video/webm", "video/mp4"],
    });
    // Two instances racing to create it: the loser's "already exists" is fine.
    if (error && !/exist/i.test(error.message)) throw error;
  })().catch((err) => {
    bucketReady = null; // let the next upload try again
    throw err;
  });
  return bucketReady;
}

export type CallRecordingPart = {
  name: string;
  path: string;
  sizeBytes: number | null;
};

/** A call's segments, in playback order. Empty for a call never recorded. */
export async function listCallRecording(
  inviteId: string,
): Promise<CallRecordingPart[]> {
  // The id becomes a storage prefix; nothing but a bare UUID gets that far.
  if (!isUuid(inviteId)) return [];
  const folder = callRecordingFolder(inviteId);
  try {
    const admin = createAdminClient();
    const { data, error } = await admin.storage
      .from(CALL_RECORDING_BUCKET)
      // 1000 is Storage's page cap and ~83 hours of five-minute segments —
      // several times the longest call the CHECK allows, reloads included.
      .list(folder, { limit: 1000 });
    if (error || !data) return [];
    return sortCallSegments(data as { name: string; metadata?: any }[]).map(
      (o) => ({
        name: o.name,
        path: `${folder}/${o.name}`,
        sizeBytes:
          typeof o.metadata?.size === "number" ? o.metadata.size : null,
      }),
    );
  } catch (err) {
    console.error("[calls] recording list failed", inviteId, err);
    return [];
  }
}

/**
 * How many past calls a list page will look up recordings for.
 *
 * One storage listing per call, run in parallel. A host's page shows a few
 * dozen past calls at most, but the admin's all-calls view can hold 200, and
 * 200 listings on every render is a page that gets slower each week. The most
 * recent calls are the ones anyone goes looking for.
 */
const RECORDING_LOOKUP_CAP = 25;

/**
 * The calls on a list worth asking storage about: over, and accepted at some
 * point (only a host in an accepted call's window can upload — an expired
 * invite or a cancelled call has nothing to find). Newest first, capped.
 */
export function recordingCandidates(
  invites: readonly CallInvite[],
  now: Date = new Date(),
): string[] {
  return splitCalls(invites, now)
    .past.filter((i) => i.status === "accepted" || i.status === "completed")
    .slice(0, RECORDING_LOOKUP_CAP)
    .map((i) => i.id);
}

/** inviteId → number of recorded parts, for the calls that have any. */
export async function countCallRecordings(
  inviteIds: readonly string[],
): Promise<Record<string, number>> {
  const entries = await Promise.all(
    inviteIds.map(async (id) => [id, (await listCallRecording(id)).length] as const),
  );
  return Object.fromEntries(entries.filter(([, n]) => n > 0));
}

/**
 * A short-lived link to one part.
 *
 * Ten minutes, like every other per-click signed read in the repo: minted at
 * the moment of the click (by the /api/calls/[id]/recording route), so it is
 * seconds old when used, and dead long before a forwarded copy is useful. A
 * playback that has started carries on past expiry.
 */
export async function signCallRecordingPart(
  path: string,
  expiresInSeconds = 60 * 10,
): Promise<string | null> {
  try {
    const admin = createAdminClient();
    const { data, error } = await admin.storage
      .from(CALL_RECORDING_BUCKET)
      .createSignedUrl(path, expiresInSeconds);
    if (error) {
      console.error("[calls] recording sign failed", error.message);
      return null;
    }
    return data?.signedUrl ?? null;
  } catch (err) {
    console.error("[calls] recording sign threw", err);
    return null;
  }
}
