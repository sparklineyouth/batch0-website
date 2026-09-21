"use client";
import { useMemo } from "react";
import { BroadcastRoom } from "@/components/live/broadcast-room";
import { joinRoom, announcePresence, leaveRoom, listAudience } from "@/app/live/actions";
import type { LiveRole, WebinarQuestion } from "@/lib/live";

/**
 * A hosted webinar on batch0 Live.
 *
 * This exists to bind the four server actions to one event id and hand the
 * result to `BroadcastRoom`, which knows nothing about events or invites. The
 * same component serves a 1:1 with `kind: "call"` — that is the whole reason
 * the binding lives out here rather than inside the room.
 *
 * The callbacks are memoised on the event id alone. `useLiveSession` treats
 * them as stable and deliberately leaves them out of its lifecycle effect:
 * if they changed identity on a render, the effect would re-run and tear down
 * every live peer connection mid-webinar.
 */
export function BuiltinEventRoom({
  eventId,
  title,
  role,
  displayViewerCount,
  initialQuestions,
}: {
  eventId: string;
  title: string;
  role: LiveRole;
  /** Admin-announced headcount, shown to everyone. Null = hidden roster. */
  displayViewerCount: number | null;
  initialQuestions: WebinarQuestion[];
}) {
  const actions = useMemo(
    () => ({
      join: () => joinRoom("event", eventId),
      announce: () => announcePresence("event", eventId),
      leave: () => leaveRoom("event", eventId),
      listPeers: () => listAudience("event", eventId),
    }),
    [eventId],
  );

  return (
    <BroadcastRoom
      kind="event"
      roomId={eventId}
      title={title}
      role={role}
      backHref="/dashboard/events"
      displayViewerCount={displayViewerCount}
      qa={{ eventId, initialQuestions }}
      {...actions}
    />
  );
}
