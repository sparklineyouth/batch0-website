"use client";
import { useCallback, useMemo } from "react";
import { BroadcastRoom } from "@/components/live/broadcast-room";
import {
  joinRoom,
  announcePresence,
  leaveRoom,
  listAudience,
  endCall,
} from "@/app/live/actions";
import type { SignalRole } from "@/lib/live-signal";

/**
 * A 1:1 call on batch0 Live.
 *
 * The same `BroadcastRoom` a webinar uses, with two differences that both
 * come from the data rather than from a branch in the component: `role` is
 * "host" for both parties (a 1:1 has no audience to hide, and a viewer role
 * would leave one of them unable to speak), and no `qa` is passed — questions
 * are a webinar affordance, and two people on a call just talk.
 *
 * Because both parties hold the same signal role, who OWNS the call travels
 * separately, in `call`: the inviter is the owner, and only the owner gets End
 * call (`endCall`, which completes the invite and closes the room for both).
 * An admin in a call is always its owner — invitees are always students.
 *
 * `listPeers` is wired but inert for calls: the server returns an empty list
 * for `kind: "call"` because the other party is already known from the invite
 * row, so there is nothing to reconcile against.
 */
export function BuiltinCallRoom({
  inviteId,
  title,
  backHref,
  isOwner,
  otherName,
  endsAt,
}: {
  inviteId: string;
  title: string;
  /**
   * Back / after-leave destination, decided by the page: the owner's calls
   * page (/admin, /mentor or /investor calls), or /dashboard/calls for the
   * invitee.
   */
  backHref: string;
  isOwner: boolean;
  otherName: string;
  /** Scheduled end of the call — the room says "rejoin until" from it. */
  endsAt: string;
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

  const onEndCall = useCallback(() => endCall(inviteId), [inviteId]);
  const call = useMemo(
    () => ({ isOwner, otherName, endsAt, onEndCall }),
    [isOwner, otherName, endsAt, onEndCall],
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
