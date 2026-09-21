"use client";
import { useMemo } from "react";
import { BroadcastRoom } from "@/components/live/broadcast-room";
import { joinRoom, announcePresence, leaveRoom, listAudience } from "@/app/live/actions";

/**
 * A 1:1 call on batch0 Live.
 *
 * The same `BroadcastRoom` a webinar uses, with two differences that both
 * come from the data rather than from a branch in the component: `role` is
 * "host" for both parties (a 1:1 has no audience to hide, and a viewer role
 * would leave one of them unable to speak), and no `qa` is passed — questions
 * are a webinar affordance, and two people on a call just talk.
 *
 * `listPeers` is wired but inert for calls: the server returns an empty list
 * for `kind: "call"` because the other party is already known from the invite
 * row, so there is nothing to reconcile against.
 */
export function BuiltinCallRoom({
  inviteId,
  title,
}: {
  inviteId: string;
  title: string;
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

  return (
    <BroadcastRoom
      kind="call"
      roomId={inviteId}
      title={title}
      role="host"
      backHref="/dashboard/calls"
      {...actions}
    />
  );
}
