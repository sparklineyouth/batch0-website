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
import {
  getWebinarUploadToken,
  nextRecordingIndex,
  registerWebinarAsset,
} from "@/app/admin/events/webinar-actions";
import type { RoomState } from "./room-actions";
import type { LiveRole, WebinarQuestion } from "@/lib/live";
import type { SignalRole } from "@/lib/live-signal";
import type { AudienceMode, EventSpeaker, PremiereState } from "@/lib/webinars";

/**
 * A hosted webinar on batch0 Live.
 *
 * This binds the event to a room that knows nothing about events. `BroadcastRoom`
 * takes callbacks and data; everything that makes this particular room a WEBINAR
 * — which event it is, where its recording segments go, what its premiere is
 * playing — is resolved here and handed down. The same component serves a 1:1
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
  title,
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
  title: string;
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
   * render time (staff always; a guest speaker only with no staff host
   * present). The room keeps it current from then on.
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

  /**
   * Put one recording segment in the bucket.
   *
   * The three-step dance this repo already uses for every large upload, and it
   * is three steps for a reason Next imposes: a server action's request body is
   * capped at 1 MB by default and this project does not raise it, so a 45 MB
   * segment cannot be POSTed to an action at all. Instead the server mints a
   * signed URL, the bytes go straight from the tab to Supabase Storage without
   * touching a Vercel function, and a second action records the path.
   *
   * `sortOrder` is the segment index, and registering the same index twice
   * REPLACES the row (registerWebinarAsset selects it and updates, falling
   * back to insert). A recorder that re-uploads segment 4 after a dropped
   * connection must not leave two copies, or the recording plays the same five
   * minutes twice. The index itself is seeded from the server
   * (`nextRecordingIndex`), so a reload or a second staff recorder appends
   * rather than replacing segment 0.
   *
   * Throws on failure, which is deliberate: `useRecorder` catches, counts the
   * failure, and KEEPS RECORDING. Losing one segment must never stop the next
   * one, because the alternative is a network blip at minute twelve costing
   * the remaining forty-eight.
   */
  const onSegment = useCallback(
    async (blob: Blob, index: number, durationSeconds: number) => {
      const filename = `segment-${String(index).padStart(4, "0")}.webm`;
      const { path, token } = await getWebinarUploadToken(
        eventId,
        "recording",
        filename,
      );
      // Deferred import keeps supabase-js out of the route's first-load JS;
      // it's only needed here, at the moment an upload starts.
      const { createClient } = await import("@/lib/supabase/client");
      const supabase = createClient();
      const up = await supabase.storage
        .from("webinar-media")
        .uploadToSignedUrl(path, token, blob, {
          contentType: blob.type || "video/webm",
        });
      if (up.error) throw up.error;

      await registerWebinarAsset(eventId, {
        kind: "recording",
        storagePath: path,
        filename,
        mimeType: blob.type || "video/webm",
        sizeBytes: blob.size,
        durationSeconds: Math.round(durationSeconds),
        sortOrder: index,
      });
    },
    [eventId],
  );

  const seedRecordingIndex = useCallback(
    () => nextRecordingIndex(eventId),
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
      onSegment,
      nextRecordingIndex: seedRecordingIndex,
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
      onSegment,
      seedRecordingIndex,
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
