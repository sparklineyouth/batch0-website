"use client";
import { useCallback, useMemo } from "react";
import { BroadcastRoom, type CallRoom } from "@/components/live/broadcast-room";
import { joinRoom, announcePresence, leaveRoom, listAudience } from "@/app/live/actions";
import { endCall, getCallRoomStatus } from "@/app/calls/actions";
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
 * What makes it a CALL is the `call` bundle: the team's side records (one
 * browser, everyone in it, composited and mixed), anyone on it can End call
 * for everyone, and the room polls for someone else having done so. Same
 * rule as the webinar binding next door: every callback here is memoised on
 * the invite id alone, because `useLiveSession` treats its action props as
 * stable and a changed identity would tear the call down mid-sentence.
 *
 * `listPeers` is wired but inert for calls: the server returns an empty list
 * for `kind: "call"` because everyone on it is already known from the invite
 * row, so there is nothing to reconcile against. That includes anyone added
 * after this page rendered: `announce` answers a call with its roster on
 * every heartbeat (PresenceResult.call), and the session dials them from it.
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
   * record; see CallRoom. As of this render: from its first heartbeat the
   * room follows the server's list.
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

  const onEndCall = useCallback(async () => {
    const result = await endCall(inviteId);
    if (!result.ok) throw new Error(result.error);
    return { completed: !!result.data?.completed };
  }, [inviteId]);
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
