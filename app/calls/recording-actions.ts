"use server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireActor } from "@/lib/server-guards";
import { getInvite } from "@/lib/calls";
import { canUploadCallRecording } from "@/lib/call-lifecycle";
import {
  CALL_RECORDING_BUCKET,
  callRecordingFolder,
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
 * the browser PUTs the segment straight to Storage — a five-minute segment is
 * tens of megabytes, far over a server action's 1 MB body limit — and that is
 * the end of it. There is no row to register, because for a call the file
 * name IS the record (lib/call-recording.ts), and the path is built here from
 * nothing the client chose except a bounded integer.
 *
 * The gate mirrors `resolveRoom` in app/live/actions.ts, narrowed to the one
 * person who records:
 *
 *   - the caller is the call's HOST. Not the invitee: both are in the room,
 *     but if both recorded, the call would be on tape twice with two sets of
 *     segment numbers, and the student's laptop would be doing the work for a
 *     recording they did not ask to make;
 *   - the call is accepted — or completed, and the window is open plus a
 *     short grace (canUploadCallRecording). Those two widenings over
 *     resolveRoom are the whole of the difference, and both exist for the
 *     LAST segment: when the student presses End call the row flips to
 *     completed while the host's recorder is still flushing, and when a call
 *     runs to the end of its window the room closes itself and flushes just
 *     after the window has shut. Refusing either upload cut the end off the
 *     conversation. A token for a call next week, or last week, is still an
 *     upload slot nobody holds.
 */
export async function getCallRecordingUploadToken(
  inviteId: string,
  index: number,
  mimeType: string,
): Promise<{ path: string; token: string }> {
  const actor = await requireActor();
  if (!isUuid(inviteId) || !isValidSegmentIndex(index)) {
    throw new Error("That recording segment isn't valid.");
  }

  const invite = await getInvite(inviteId);
  // One answer for "no such call" and "not yours", as the join gate gives.
  if (!invite || invite.hostId !== actor.userId) throw new Error("Forbidden");
  if (!canUploadCallRecording(invite)) {
    throw new Error("This call isn't running, so it can't be recorded.");
  }

  // Date.now() is the run stamp that keeps a reloaded recorder's segment 0
  // from overwriting the first run's — see lib/call-recording.ts.
  const path = `${callRecordingFolder(inviteId)}/${callSegmentName(
    index,
    Date.now(),
    segmentExtension(mimeType),
  )}`;

  const admin = createAdminClient();
  const { data, error } = await admin.storage
    .from(CALL_RECORDING_BUCKET)
    .createSignedUploadUrl(path);
  if (error) throw new Error(error.message);
  return { path: data.path, token: data.token };
}
