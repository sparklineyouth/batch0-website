"use server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireActor } from "@/lib/server-guards";
import { getInvite } from "@/lib/calls";
import { isStaffOnCall } from "@/lib/live";
import { ensureCallRecordingBucket } from "@/lib/call-recordings";
import { canUploadCallRecording } from "@/lib/call-lifecycle";
import { recordingRival, recordingSegmentStart } from "@/lib/webinars";
import {
  CALL_RECORDING_BUCKET,
  callRecordingFolder,
  callRecordingRegistry,
  callSegmentName,
  isUuid,
  isValidSegmentIndex,
  segmentExtension,
} from "@/lib/call-recording";

/**
 * Uploading a 1:1 call's recording, one segment at a time.
 *
 * The webinar recorder's three-step dance (see app/admin/events/
 * webinar-actions.ts) minus the third step: this mints a signed upload URL,
 * the browser PUTs the segment straight to Storage — a two-minute segment is
 * tens of megabytes, far over a server action's 1 MB body limit — and that is
 * the end of it. There is no row to register, because for a call the file
 * name IS the record (lib/call-recording.ts), and the path is built here from
 * nothing the client chose except a bounded integer.
 *
 * The gate mirrors `resolveRoom` in app/live/actions.ts, narrowed to the
 * people who may record:
 *
 *   - the caller is on the call's STAFF SIDE — its host or a co-host
 *     (migration 0092). Never the student: they are in the room, but the
 *     student's laptop would be doing the work for a recording they did not
 *     ask to make. Among the staff, the room elects ONE browser at a time
 *     (the lowest user id present, as webinars do — see broadcast-room's
 *     call recorder), so a co-host can carry the recording when the person
 *     who sent the invite never comes, and hand it over when they do;
 *   - and nobody the election ranks ahead of the caller is recording this
 *     call at the same time (the backstop below). The election only works
 *     between browsers that can see each other;
 *   - the call is accepted — or completed, or cancelled — and the window is
 *     open plus a short grace (canUploadCallRecording). Those widenings over
 *     resolveRoom are the whole of the difference, and all exist for the
 *     LAST segment: when the student presses End call the row flips to
 *     completed while the host's recorder is still flushing, when the host
 *     cancels from another tab the room notices and flushes, and when a call
 *     runs to the end of its window the room closes itself and flushes just
 *     after the window has shut. Refusing any of those uploads cut the end
 *     off what was recorded. A token for a call next week, or last week, is
 *     still an upload slot nobody holds.
 */
export async function getCallRecordingUploadToken(
  inviteId: string,
  index: number,
  mimeType: string,
  segment: {
    /** How long the segment ran — dates its start on the server's clock. */
    seconds?: number | null;
    /** The recorder captured it as it stopped (Leave, End, a handover). */
    last?: boolean;
  } = {},
): Promise<{ refused: true } | { refused: false; path: string; token: string }> {
  const actor = await requireActor();
  if (!isUuid(inviteId) || !isValidSegmentIndex(index)) {
    throw new Error("That recording segment isn't valid.");
  }

  const invite = await getInvite(inviteId);
  // One answer for "no such call" and "not yours", as the join gate gives.
  if (!invite || !isStaffOnCall(invite, actor.userId)) throw new Error("Forbidden");
  if (!canUploadCallRecording(invite)) {
    throw new Error("This call isn't running, so it can't be recorded.");
  }

  await ensureCallRecordingBucket();
  const admin = createAdminClient();

  // Somebody ranked ahead of this browser recorded a stretch of THIS
  // segment: it is a second copy, and goes no further. Answered rather than
  // thrown, so the recorder neither counts a failure nor shows an error.
  if (await callRecordingRivalFor(admin, inviteId, actor.userId, segment.seconds)) {
    return { refused: true };
  }

  // Date.now() is the run stamp that keeps a reloaded recorder's segment 0
  // from overwriting the first run's — see lib/call-recording.ts — and the
  // moment the backstop above reads this segment as registered.
  const path = `${callRecordingFolder(inviteId)}/${callSegmentName(
    index,
    Date.now(),
    segmentExtension(mimeType),
    { userId: actor.userId, last: segment.last === true },
  )}`;

  const { data, error } = await admin.storage
    .from(CALL_RECORDING_BUCKET)
    .createSignedUploadUrl(path);
  if (error) throw new Error(error.message);
  return { refused: false, path: data.path, token: data.token };
}

/**
 * Is somebody else this call's recorder, such that `userId`'s segment must be
 * refused? Their user id if so.
 *
 * The server half of "one recorder per call", ported from webinars
 * (recordingRivalFor in app/admin/events/webinar-actions.ts): two staff whose
 * connection to each other never came up — TURN is optional, and a mesh
 * link between two strict NATs can fail while both reach the student — each
 * see only themselves and both elect themselves, and before this the call
 * was recorded twice over, interleaved a segment at a time on playback. The
 * same rule decides: refuse the caller when someone the election ranks ahead
 * (a lower id) registered a segment within the lease, after this one began,
 * and is still recording. A call has no asset rows and no attendance, so all
 * three come from the segment names (callRecordingRegistry).
 *
 * Refusing drops only the overlapping segment; the caller's recorder carries
 * on, and the room does not stand down for a lease the way a webinar does.
 * A webinar can afford that because attendance tells it when the rival has
 * gone; here the only word of a rival whose laptop died is that they stop
 * registering, so the caller's very next segment must be the one that keeps
 * the call on tape — not one four minutes later.
 *
 * A failed listing returns null: this is the election's backstop, not a gate
 * on recording at all.
 */
async function callRecordingRivalFor(
  admin: ReturnType<typeof createAdminClient>,
  inviteId: string,
  userId: string,
  segmentSeconds: number | null | undefined,
): Promise<string | null> {
  const { data, error } = await admin.storage
    .from(CALL_RECORDING_BUCKET)
    // The same page as listCallRecording: several times the longest call.
    .list(callRecordingFolder(inviteId), { limit: 1000 });
  if (error || !data) return null;
  const { recent, stillRecording } = callRecordingRegistry(
    (data as { name: string }[]).map((f) => f.name),
  );
  const now = new Date();
  return recordingRival({
    callerId: userId,
    recent,
    present: stillRecording,
    now,
    segmentStartMs: recordingSegmentStart(
      now,
      typeof segmentSeconds === "number" ? segmentSeconds : undefined,
    ),
  });
}
