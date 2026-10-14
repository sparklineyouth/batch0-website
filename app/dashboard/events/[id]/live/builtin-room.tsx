"use client";
import { useCallback, useMemo } from "react";
import { RoomController, type WebinarBinding } from "@/components/live/room/controller";
import type { EventDeck } from "@/components/live/room/use-presentation";
import {
  joinRoom,
  announcePresence,
  leaveRoom,
  listAudience,
  setPrimaryHost,
  getHostingStatus,
} from "@/app/live/actions";
import { endLive, fetchLiveState, goLiveNow, reopenLive } from "./room-actions";
import type { LiveRole } from "@/lib/live";
import type { SignalRole } from "@/lib/live-signal";
import type { WebinarPanelInitial } from "@/lib/webinar-panel";

/**
 * A hosted webinar on batch0 Live: binds the event's server actions to the
 * room controller.
 *
 * Every callback is memoised on the event id alone. useLiveSession treats its
 * transport as stable and leaves it out of its lifecycle effect; a new
 * identity would tear every peer connection down mid-webinar.
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
  autoRecord,
  liveStartedAt,
  liveEndedAt,
  deckUrl,
  deckName,
  panel,
  recordingReady = true,
}: {
  eventId: string;
  /** Their peer id: a peer's id is its user id. */
  selfUserId: string;
  selfName: string;
  title: string;
  startsAt: string;
  endsAt: string | null;
  role: LiveRole;
  /** events.manage, as opposed to a guest speaker (who also hosts). */
  isStaffHost: boolean;
  /** As the server saw it at render; the room keeps it current. */
  canEnd: boolean;
  backHref: string;
  autoRecord: boolean;
  liveStartedAt: string | null;
  liveEndedAt: string | null;
  /** The event's PDF deck, signed (hosts only); null when there is none. */
  deckUrl: string | null;
  deckName: string | null;
  panel: WebinarPanelInitial;
  /** False before migration 0095 (recordingsReady). */
  recordingReady?: boolean;
}) {
  const transport = useMemo(
    () => ({
      join: () => joinRoom("event", eventId),
      // `joinedAs` lets the server answer 'revoked' to a host whose grant was
      // removed mid-session instead of re-announcing them as a viewer.
      announce: (joinedAs?: SignalRole) => announcePresence("event", eventId, joinedAs),
      leave: () => leaveRoom("event", eventId),
      listPeers: () => listAudience("event", eventId),
    }),
    [eventId],
  );
  const onGoLiveNow = useCallback(() => goLiveNow(eventId), [eventId]);
  const onEndLive = useCallback(() => endLive(eventId), [eventId]);
  const onReopenLive = useCallback(() => reopenLive(eventId), [eventId]);
  const onFetchLiveState = useCallback(() => fetchLiveState(eventId), [eventId]);
  const onSetPrimary = useCallback((userId: string) => setPrimaryHost(eventId, userId), [eventId]);
  const onHosting = useCallback(() => getHostingStatus(eventId), [eventId]);
  const deck = useMemo<EventDeck | null>(
    () => (deckUrl ? { url: deckUrl, name: deckName || "Slides.pdf" } : null),
    [deckUrl, deckName],
  );

  const webinar = useMemo<WebinarBinding>(
    () => ({
      eventId,
      startsAt,
      endsAt,
      isStaffHost,
      autoRecord,
      liveStartedAt,
      liveEndedAt,
      canEnd,
      deck,
      panel,
      goLiveNow: isStaffHost ? onGoLiveNow : undefined,
      endLive: onEndLive,
      reopenLive: onReopenLive,
      fetchLiveState: onFetchLiveState,
      setPrimaryHost: onSetPrimary,
      hostingStatus: onHosting,
    }),
    [
      eventId,
      startsAt,
      endsAt,
      isStaffHost,
      autoRecord,
      liveStartedAt,
      liveEndedAt,
      canEnd,
      deck,
      panel,
      onGoLiveNow,
      onEndLive,
      onReopenLive,
      onFetchLiveState,
      onSetPrimary,
      onHosting,
    ],
  );
  const self = useMemo(() => ({ id: selfUserId, name: selfName }), [selfUserId, selfName]);

  return (
    <RoomController
      title={title}
      self={self}
      role={role}
      backHref={backHref}
      transport={transport}
      webinar={webinar}
      recordingReady={recordingReady}
    />
  );
}
