"use client";
import { useCallback, useMemo } from "react";
import { BroadcastRoom, type CallRoom } from "@/components/live/broadcast-room";
import { joinRoom, announcePresence, leaveRoom, listAudience } from "@/app/live/actions";
import { endCall, getCallRoomStatus } from "@/app/calls/actions";
import { getCallRecordingUploadToken } from "@/app/calls/recording-actions";
import { CALL_RECORDING_BUCKET } from "@/lib/call-recording";

/**
 * A 1:1 call on batch0 Live.
 *
 * The same `BroadcastRoom` a webinar uses, with two differences that both
 * come from the data rather than from a branch in the component: `role` is
 * "host" for both parties (a 1:1 has no audience to hide, and a viewer role
 * would leave one of them unable to speak), and no `qa` is passed — questions
 * are a webinar affordance, and two people on a call just talk.
 *
 * What makes it a CALL is the `call` bundle: every 1:1 is recorded from the
 * host's browser (both people, composited and mixed), either person can End
 * call for both, and the room polls for the other side having done so. Same
 * rule as the webinar binding next door: every callback here is memoised on
 * the invite id alone, because `useLiveSession` treats its action props as
 * stable and a changed identity would tear the call down mid-sentence.
 *
 * `listPeers` is wired but inert for calls: the server returns an empty list
 * for `kind: "call"` because the other party is already known from the invite
 * row, so there is nothing to reconcile against.
 */
export function BuiltinCallRoom({
  inviteId,
  startsAt,
  title,
  isHost,
  selfName,
  otherName,
  backHref,
}: {
  inviteId: string;
  /** The scheduled start — End call is offered from here on. */
  startsAt: string;
  title: string;
  /** call_invites.host_id — the side that records. */
  isHost: boolean;
  selfName: string;
  otherName: string;
  /** Where this person's calls list lives — a host's panel, or /dashboard/calls. */
  backHref: string;
}) {
  const actions = useMemo(
    () => ({
      join: () => joinRoom("call", inviteId),
      announce: () => announcePresence("call", inviteId),
      leave: () => leaveRoom("call", inviteId),
      listPeers: () => listAudience("call", inviteId),
    }),
    [inviteId],
  );

  /**
   * Put one recording segment in the bucket.
   *
   * Two steps, not the webinar's three: the server mints a signed upload URL
   * for a path it builds itself (calls/<id>/recording/segment-NNNN-<ts>), and
   * the bytes go straight from this tab to Storage — a two-minute segment is
   * far over a server action's 1 MB body limit. There is no row to register;
   * for a call the file name is the record (lib/call-recording.ts).
   *
   * Throws on failure, deliberately: `useRecorder` counts it, tells the host,
   * and KEEPS RECORDING. One lost segment must never stop the next.
   */
  const onSegment = useCallback(
    async (blob: Blob, index: number) => {
      const mimeType = blob.type || "video/webm";
      const { path, token } = await getCallRecordingUploadToken(
        inviteId,
        index,
        mimeType,
      );
      // Deferred import keeps supabase-js out of the route's first-load JS;
      // it's only needed at the moment an upload starts.
      const { createClient } = await import("@/lib/supabase/client");
      const supabase = createClient();
      const up = await supabase.storage
        .from(CALL_RECORDING_BUCKET)
        .uploadToSignedUrl(path, token, blob, { contentType: mimeType });
      if (up.error) throw up.error;
    },
    [inviteId],
  );

  const onEndCall = useCallback(() => endCall(inviteId), [inviteId]);
  const fetchStatus = useCallback(() => getCallRoomStatus(inviteId), [inviteId]);

  const call = useMemo<CallRoom>(
    () => ({
      inviteId,
      startsAt,
      isRecorder: isHost,
      selfName,
      otherName,
      onSegment,
      onEndCall,
      fetchStatus,
    }),
    [inviteId, startsAt, isHost, selfName, otherName, onSegment, onEndCall, fetchStatus],
  );

  return (
    <BroadcastRoom
      kind="call"
      roomId={inviteId}
      title={title}
      role="host"
      backHref={backHref}
      call={call}
      {...actions}
    />
  );
}
