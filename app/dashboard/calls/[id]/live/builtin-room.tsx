"use client";
import { useCallback, useMemo } from "react";
import { RoomController, type CallBinding } from "@/components/live/room/controller";
import { joinRoom, announcePresence, leaveRoom, listAudience } from "@/app/live/actions";
import { endCall } from "@/app/calls/actions";
import type { SignalRole } from "@/lib/live-signal";

/**
 * A 1:1 call on batch0 Live: the same room controller a webinar uses, with
 * everyone on it a broadcaster (signal role "host") and no side panel.
 *
 * The call's staff side records (one browser at a time, under the server's
 * lease) and anyone on it may End call once the other side has been here.
 * Someone added after this render is dialled from the heartbeat's roster
 * (PresenceResult.call). Every callback is memoised on the invite id alone,
 * for the same reason as the webinar binding next door.
 */
export function BuiltinCallRoom({
  inviteId,
  startsAt,
  endsAt,
  title,
  selfUserId,
  staffIds,
  selfName,
  otherName,
  backHref,
  recordingReady = true,
}: {
  inviteId: string;
  /** End call is offered from the scheduled start. */
  startsAt: string;
  /** The scheduled end: people may rejoin until its hard close. */
  endsAt: string;
  title: string;
  /** This person's user id: their peer id in the room. */
  selfUserId: string;
  /** The call's staff side as of this render (host, then co-hosts). */
  staffIds: string[];
  selfName: string;
  /** Everyone else on the call, by name ("Ana", "Ana and Ben"). */
  otherName: string;
  /** This person's calls list: a host's panel, or /dashboard/calls. */
  backHref: string;
  /** False before migration 0095 (recordingsReady). */
  recordingReady?: boolean;
}) {
  const transport = useMemo(
    () => ({
      join: () => joinRoom("call", inviteId),
      announce: (joinedAs?: SignalRole) => announcePresence("call", inviteId, joinedAs),
      leave: () => leaveRoom("call", inviteId),
      listPeers: () => listAudience("call", inviteId),
    }),
    [inviteId],
  );

  const onEndCall = useCallback(async () => {
    const result = await endCall(inviteId);
    if (!result.ok) throw new Error(result.error);
    return { completed: !!result.data?.completed };
  }, [inviteId]);

  // Joined for the memo, so an equal list from a re-render rebuilds nothing.
  const staffKey = staffIds.join(",");
  const call = useMemo<CallBinding>(
    () => ({
      inviteId,
      startsAt,
      endsAt,
      staffIds: staffKey ? staffKey.split(",") : [],
      otherName,
      endCall: onEndCall,
    }),
    [inviteId, startsAt, endsAt, staffKey, otherName, onEndCall],
  );
  const self = useMemo(() => ({ id: selfUserId, name: selfName }), [selfUserId, selfName]);

  return (
    <RoomController
      title={title}
      self={self}
      role="host"
      backHref={backHref}
      transport={transport}
      call={call}
      recordingReady={recordingReady}
    />
  );
}
