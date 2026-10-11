"use client";
import { useCallback, useMemo } from "react";
import { BroadcastRoom, type CallRoom } from "@/components/live/broadcast-room";
import { joinRoom, announcePresence, leaveRoom, listAudience } from "@/app/live/actions";
import { endCall, getCallRoomStatus } from "@/app/calls/actions";
import { getCallRecordingUploadToken } from "@/app/calls/recording-actions";
import { withUploadRetry } from "@/lib/upload-retry";
import { CALL_RECORDING_BUCKET } from "@/lib/call-recording";
import type { SignalRole } from "@/lib/live-signal";

/**
 * A 1:1 call on batch0 Live.
 *
 * The same `BroadcastRoom` a webinar uses, with two differences that both
 * come from the data rather than from a branch in the component: `role` is
 * "host" for everyone on it (a 1:1 has no audience to hide, and a viewer role
 * would leave someone unable to speak), and no `qa` is passed — questions are
 * a webinar affordance, and people on a call just talk.
 *
 * What makes it a CALL is the `call` bundle: every 1:1 is recorded from one
 * staff browser (everyone in it, composited and mixed), anyone on it can End
 * call for everyone, and the room polls for someone else having done so. Same
 * rule as the webinar binding next door: every callback here is memoised on
 * the invite id alone, because `useLiveSession` treats its action props as
 * stable and a changed identity would tear the call down mid-sentence.
 *
 * `listPeers` is wired but inert for calls: the server returns an empty list
 * for `kind: "call"` because everyone on it is already known from the invite
 * row, so there is nothing to reconcile against.
 */
export function BuiltinCallRoom({
  inviteId,
  startsAt,
  title,
  selfUserId,
  recorderIds,
  selfName,
  otherName,
  endsAt,
  backHref,
}: {
  inviteId: string;
  /** The scheduled start — End call is offered from here on. */
  startsAt: string;
  title: string;
  /** This person's user id — their peer id in the room. */
  selfUserId: string;
  /**
   * The call's staff side (host first, then co-hosts) — the browsers that may
   * record. The room elects one of those present; see CallRoom.
   */
  recorderIds: string[];
  selfName: string;
  /** Everyone else on the call, by name ("Ana", "Ana and Ben"). */
  otherName: string;
  /** The scheduled end — the room says "they can rejoin until" from it. */
  endsAt: string;
  /** Where this person's calls list lives — a host's panel, or /dashboard/calls. */
  backHref: string;
}) {
  const actions = useMemo(
    () => ({
      join: () => joinRoom("call", inviteId),
      announce: (joinedAs?: SignalRole) =>
        announcePresence("call", inviteId, joinedAs),
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
   * The server may refuse it — someone ranked ahead of this browser on the
   * staff side recorded the same stretch (see getCallRecordingUploadToken's
   * backstop). Then there is nothing to upload: it is a second copy, and the
   * recorder carries on with the next segment as normal.
   *
   * Throws on failure, deliberately: `useRecorder` counts it, tells the host,
   * and KEEPS RECORDING. One lost segment must never stop the next.
   */
  const onSegment = useCallback(
    async (blob: Blob, index: number, seconds: number, last: boolean) => {
      const mimeType = blob.type || "video/webm";
      const signed = await getCallRecordingUploadToken(inviteId, index, mimeType, {
        seconds,
        last,
      });
      if (signed.refused) return;
      const { path, token } = signed;
      // Deferred import keeps supabase-js out of the route's first-load JS;
      // it's only needed at the moment an upload starts.
      const { createClient } = await import("@/lib/supabase/client");
      const supabase = createClient();
      // Through a network blip, not past a refusal (lib/upload-retry.ts):
      // the last segment goes up as someone presses End call, and one
      // dropped request used to cost the end of the conversation.
      await withUploadRetry(async () => {
        const up = await supabase.storage
          .from(CALL_RECORDING_BUCKET)
          .uploadToSignedUrl(path, token, blob, { contentType: mimeType });
        if (up.error) throw up.error;
      });
    },
    [inviteId],
  );

  const onEndCall = useCallback(() => endCall(inviteId), [inviteId]);
  const fetchStatus = useCallback(() => getCallRoomStatus(inviteId), [inviteId]);

  // Joined into a string for the memo's deps, so a re-render that hands over
  // an equal list never rebuilds the bundle (and with it the session).
  const recorderKey = recorderIds.join(",");
  const call = useMemo<CallRoom>(
    () => ({
      inviteId,
      startsAt,
      endsAt,
      selfUserId,
      recorderIds: recorderKey ? recorderKey.split(",") : [],
      selfName,
      otherName,
      onSegment,
      onEndCall,
      fetchStatus,
    }),
    [
      inviteId,
      startsAt,
      endsAt,
      selfUserId,
      recorderKey,
      selfName,
      otherName,
      onSegment,
      onEndCall,
      fetchStatus,
    ],
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
