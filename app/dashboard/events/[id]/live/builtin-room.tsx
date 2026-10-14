"use client";
import { useCallback, useMemo } from "react";
import { BroadcastRoom } from "@/components/live/broadcast-room";
import {
  joinRoom,
  announcePresence,
  leaveRoom,
  listAudience,
} from "@/app/live/actions";
import {
  endLive,
  fetchPremiereState,
  goLive,
  reopenLive,
} from "./room-actions";
import type { RoomState } from "./room-actions";
import type { LiveRole, WebinarQuestion } from "@/lib/live";
import type { SignalRole } from "@/lib/live-signal";
import type { AudienceMode, EventSpeaker, PremiereState } from "@/lib/webinars";

/**
 * A hosted webinar on batch0 Live.
 *
 * This binds the event to a room that knows nothing about events. `BroadcastRoom`
 * takes callbacks and data; everything that makes this particular room a WEBINAR
 * — which event it is, what its premiere is playing — is resolved here and
 * handed down. The same component serves a 1:1
 * with `kind: "call"` and none of these props, which is the whole reason the
 * binding lives out here rather than inside the room.
 *
 * ---------------------------------------------------------------------------
 * Why every callback is memoised on the event id alone
 * ---------------------------------------------------------------------------
 *
 * `useLiveSession` treats its action props as stable and deliberately leaves
 * them out of its lifecycle effect's dependency array, with an eslint-disable
 * and a comment saying so. If one of them changed identity on a render, that
 * effect would re-run and tear down every live peer connection — mid-webinar,
 * in front of the audience, with no error anywhere to explain it. So the
 * `useMemo` and `useCallback` below are not an optimisation, they are the
 * thing keeping the room up, and the dependency lists must stay this narrow.
 */
export function BuiltinEventRoom({
  eventId,
  selfUserId,
  selfName,
  title,
  startsAt,
  endsAt,
  role,
  isStaffHost,
  canEnd,
  backHref,
  audienceMode,
  displayViewerCount,
  autoRecord,
  premiere,
  liveEndedAt,
  speakers,
  deck,
  initialQuestions,
  initialRoomState,
}: {
  eventId: string;
  /** The signed-in person's id — their peer id in the room. */
  selfUserId: string;
  /** The signed-in person's name, for their tile in the recording. */
  selfName: string;
  title: string;
  /** The schedule — see WebinarRoom in components/live/broadcast-room. */
  startsAt: string;
  endsAt: string | null;
  role: LiveRole;
  /**
   * Staff, as opposed to a guest speaker who also holds `role: "host"`.
   *
   * Both broadcast. Only staff are shown who is watching — a guest founder
   * needs a camera, not the attendance list of a room containing minors. The
   * server already enforces this by withholding the names (see `discloseNames`
   * in lib/live-rooms.ts); this prop is what lets the UI avoid drawing an
   * empty column where the roster would be.
   */
  isStaffHost: boolean;
  /**
   * May this reader end the webinar for everyone, as the server saw it at
   * render time (nobody before the start; then staff always, and a guest
   * speaker only with no staff host present). The room keeps it current from
   * then on.
   */
  canEnd: boolean;
  /**
   * Back / after-leave destination, decided by the page from the role: staff
   * go back to /admin/webinars, speakers and students to /dashboard/events.
   */
  backHref: string;
  audienceMode: AudienceMode;
  /** Admin-announced headcount, shown to everyone. Null = hidden roster. */
  displayViewerCount: number | null;
  autoRecord: boolean;
  /** Null for an ordinary live webinar. */
  premiere:
    | (PremiereState & { url: string; durationSeconds: number })
    | null;
  liveEndedAt: string | null;
  speakers: EventSpeaker[];
  deck: { id: string; filename: string; sizeBytes: number | null }[];
  initialQuestions: WebinarQuestion[];
  initialRoomState: RoomState | null;
}) {
  const actions = useMemo(
    () => ({
      join: () => joinRoom("event", eventId),
      // `joinedAs` lets the server answer 'revoked' to a host whose grant was
      // removed mid-session, rather than silently re-announcing them as a
      // viewer while they still hold host credentials.
      announce: (joinedAs?: SignalRole) =>
        announcePresence("event", eventId, joinedAs),
      leave: () => leaveRoom("event", eventId),
      listPeers: () => listAudience("event", eventId),
    }),
    [eventId],
  );

  const onGoLive = useCallback(() => goLive(eventId), [eventId]);
  const onEndLive = useCallback(() => endLive(eventId), [eventId]);
  const onReopenLive = useCallback(() => reopenLive(eventId), [eventId]);
  const refreshPremiere = useCallback(
    () => fetchPremiereState(eventId),
    [eventId],
  );

  const webinar = useMemo(
    () => ({
      eventId,
      startsAt,
      endsAt,
      selfUserId,
      selfName,
      audienceMode,
      isStaffHost,
      autoRecord,
      premiere,
      liveEndedAt,
      canEnd,
      speakers,
      deck,
      initialQuestions,
      initialRoomState,
      onGoLive,
      onEndLive,
      onReopenLive,
      refreshPremiere,
    }),
    // `speakers`, `deck` and the two initial payloads are server-rendered and
    // stable for the life of the page; listing them keeps the lint honest
    // without ever actually changing identity mid-webinar.
    [
      eventId,
      startsAt,
      endsAt,
      selfUserId,
      selfName,
      audienceMode,
      isStaffHost,
      autoRecord,
      premiere,
      liveEndedAt,
      canEnd,
      speakers,
      deck,
      initialQuestions,
      initialRoomState,
      onGoLive,
      onEndLive,
      onReopenLive,
      refreshPremiere,
    ],
  );

  return (
    <BroadcastRoom
      kind="event"
      roomId={eventId}
      title={title}
      role={role}
      backHref={backHref}
      displayViewerCount={displayViewerCount}
      webinar={webinar}
      {...actions}
    />
  );
}
