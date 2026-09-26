"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { PreJoin } from "@/components/live/pre-join";
import { LiveDot } from "@/components/live/call-stage";
import { VideoTile } from "@/components/live/video-tile";
import { CallControls } from "@/components/live/call-controls";
import { QAPanel } from "@/components/live/qa-panel";
import { RoomPanel } from "@/components/live/room-panel";
import { PremierePlayer } from "@/components/live/premiere-player";
import { useLocalMedia } from "@/components/live/use-local-media";
import { useLiveSession } from "@/components/live/use-live-session";
import {
  useRecorder,
  type RecorderRemote,
} from "@/components/live/use-recorder";
import { SpeakerStrip } from "@/components/live/speaker-strip";
import { Button, ButtonLink } from "@/components/ui/button";
import { headcountLabel, type LiveRole, type WebinarQuestion } from "@/lib/live";
import type { LiveCredentials, LivePeer } from "@/lib/live-rooms";
import {
  electRecorder,
  presentForRecording,
  RECORDER_LEASE_MS,
  RECORDER_SETTLE_MS,
  type AudienceMode,
  type EventSpeaker,
  type PremiereState,
  type RecorderCandidate,
} from "@/lib/webinars";
import type { RoomState } from "@/app/dashboard/events/[id]/live/room-actions";
import { AlertTriangle, Users, Loader2, CircleDot } from "lucide-react";

/**
 * A batch0 Live room — the built-in provider's equivalent of LiveRoom.
 *
 * Same two halves as the Daily version: the green room and the chrome are
 * ours, and the call itself fills the middle. The difference is that the
 * middle is now ours too — `useLiveSession` holds the peer connections, and
 * what lands here is a set of `MediaStream`s to render, which is exactly what
 * `VideoTile` has taken since it was written.
 *
 * The host/viewer split shows up three times, and all three read from `role`
 * rather than from anything the browser could be talked into changing:
 *
 *   - a viewer is given no camera and no mic, and the engine builds its
 *     connection recvonly, so there is nothing to un-mute;
 *   - a viewer sees the host and no one else, because the server never told
 *     it anyone else exists;
 *   - only the host sees the real headcount.
 *
 * The one deliberate exception to that last rule is an admin-announced
 * `displayViewerCount`, which is shown to everyone. `headcountLabel` owns the
 * precedence so this room and the Daily one cannot disagree about it.
 */

/**
 * `left` is this person stepping out — the room carries on and they can
 * rejoin. `ended` is the CALL being over, for both people: someone pressed End
 * call, it was cancelled, or its window closed. Only a 1:1 reaches `ended`; a
 * webinar's ending is the `endedAt` banner, because its audience stays on the
 * page for the chat.
 */
type Phase = "prejoin" | "live" | "left" | "ended";

/**
 * Everything that makes this room a 1:1 CALL, as `WebinarRoom` is for a
 * webinar — one all-or-nothing bundle, for the same reason.
 */
export type CallRoom = {
  inviteId: string;
  /**
   * When the call is scheduled to start. End call is offered from here on:
   * the room opens fifteen minutes early, and before the start the server
   * will not mark the call completed (canMarkCallCompleted), so a button
   * saying "End call" there would promise something it cannot do.
   */
  startsAt: string;
  /**
   * This person is the call's host (call_invites.host_id), and so the one
   * whose browser records. Exactly one side records: two recorders would put
   * the call on tape twice, and make the student's laptop do the work.
   */
  isRecorder: boolean;
  /** Names for the recording's tiles, and for the copy around the room. */
  selfName: string;
  otherName: string;
  onSegment: (blob: Blob, index: number, seconds: number) => Promise<void>;
  /** Mark the call completed. The server decides whether it may (not before the start). */
  onEndCall: () => Promise<{ completed: boolean }>;
  /**
   * Is the call over? Polled while in the room — see `getCallRoomStatus` for
   * why the other person's End call cannot simply be seen on the wire.
   */
  fetchStatus: () => Promise<{ over: boolean } | null>;
};

/** How often a call room asks whether the other person ended it. */
const CALL_STATUS_POLL_MS = 15_000;

/**
 * What became of a webinar segment. `refused` is the server saying another
 * host's browser is this webinar's recorder — not a failure, an instruction
 * to stand down (see `recordingRival` in lib/webinars.ts).
 */
export type SegmentOutcome = "saved" | "refused";

export type WebinarRoom = {
  eventId: string;
  /** The signed-in person's id — their peer id as every other host sees it. */
  selfUserId: string;
  audienceMode: AudienceMode;
  /** Staff, as opposed to a guest speaker who also broadcasts. */
  isStaffHost: boolean;
  autoRecord: boolean;
  /** Null for an ordinary live webinar. */
  premiere: (PremiereState & { url: string; durationSeconds: number }) | null;
  liveEndedAt: string | null;
  speakers: EventSpeaker[];
  deck: { id: string; filename: string; sizeBytes: number | null }[];
  initialQuestions: WebinarQuestion[];
  initialRoomState: RoomState | null;
  onSegment: (
    blob: Blob,
    index: number,
    seconds: number,
  ) => Promise<SegmentOutcome>;
  onGoLive: () => Promise<string | null>;
  onEndLive: () => Promise<void>;
  onReopenLive: () => Promise<void>;
  /**
   * Re-read the premiere's position from the SERVER's clock.
   *
   * Polled as a backstop rather than trusted from the browser. A viewer whose
   * laptop is four minutes fast would otherwise drift four minutes ahead of the
   * room — visibly, in chat, reacting to something nobody else has seen — and
   * one whose clock is out by an hour would watch a black screen and conclude
   * the webinar never started.
   */
  refreshPremiere: () => Promise<
    (PremiereState & { liveEndedAt: string | null }) | null
  >;
};

export function BroadcastRoom({
  kind,
  roomId,
  title,
  role,
  backHref,
  displayViewerCount = null,
  qa,
  webinar,
  call,
  join,
  announce,
  leave,
  listPeers,
}: {
  kind: "event" | "call";
  roomId: string;
  title: string;
  role: LiveRole;
  backHref: string;
  /**
   * Admin-announced headcount (events.display_viewer_count). When set it is
   * shown to everyone in place of the hidden roster — the deliberate
   * exception to audience privacy. Null keeps the default: the host sees the
   * real count, a viewer sees nothing.
   */
  displayViewerCount?: number | null;
  /** Present for webinars, absent for 1:1 calls. */
  qa?: { eventId: string; initialQuestions: WebinarQuestion[] };
  /**
   * Everything that makes this room a WEBINAR rather than a 1:1.
   *
   * One optional bundle rather than a dozen optional props, because they are
   * all-or-nothing: a room either has an event behind it or it does not, and
   * twelve independently-optional props would be twelve ways to end up in a
   * state that cannot happen. A 1:1 passes nothing and every webinar feature
   * below is simply absent — no flags to read, no branches to get wrong.
   */
  webinar?: WebinarRoom;
  /** Present for 1:1 calls, absent for webinars. Never both. */
  call?: CallRoom;
  join: () => Promise<LiveCredentials | null>;
  announce: () => Promise<boolean>;
  leave: () => Promise<void>;
  listPeers: () => Promise<LivePeer[]>;
}) {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>("prejoin");
  const isHost = role === "host";

  // ---- Premiere -----------------------------------------------------------
  //
  // Tracked as state because it CHANGES under everyone during the session: the
  // recording runs out, or a host presses "go live" thirty minutes into a
  // forty-minute talk. Seeded from the server render so the first paint is
  // already correct, then advanced by the ticker below.
  const [premierePhase, setPremierePhase] = useState(
    webinar?.premiere?.phase ?? null,
  );
  const [endedAt, setEndedAt] = useState<string | null>(
    webinar?.liveEndedAt ?? null,
  );
  const inPremiere = premierePhase === "playing" || premierePhase === "waiting";

  const refreshPremiere = webinar?.refreshPremiere;
  useEffect(() => {
    if (!refreshPremiere) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const next = await refreshPremiere();
        if (cancelled || !next) return;
        setPremierePhase(next.phase);
        setEndedAt(next.liveEndedAt);
      } catch {
        // A dropped poll costs a few seconds of staleness; the next one
        // catches up. Surfacing it would put an error banner over a webinar
        // that is working.
      }
    };
    void tick();
    // Every eight seconds. Frequent enough that "go live early" reaches the
    // room while the host is still saying "we're going live now", cheap enough
    // that fifty viewers cost about six requests a second between them — an
    // order of magnitude below the 5-second Q&A poll this feature replaced.
    const timer = setInterval(tick, 8_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [refreshPremiere]);

  // What they chose in the green room, applied once the real stream exists.
  const wanted = useRef<{ cameraOn: boolean; micOn: boolean }>({
    cameraOn: true,
    micOn: true,
  });
  const applied = useRef(false);

  // The call's own devices, acquired after the green room rather than handed
  // over from it: PreJoin releases its stream on unmount, and re-acquiring
  // costs no second permission prompt now that permission is granted.
  // A host's camera does NOT come up while a premiere is still playing. They
  // are not on air yet, and lighting up a webcam (and its indicator light) for
  // forty minutes before anyone can see it is both wasteful and alarming.
  const media = useLocalMedia({
    autoStart: isHost && phase === "live" && !inPremiere,
  });
  const screen = useScreenShare();

  // Honour the green room's toggles once, as soon as there is a stream to
  // apply them to. Joining with the camera off must not flash a face first.
  useEffect(() => {
    if (applied.current || media.status !== "ready") return;
    applied.current = true;
    if (!wanted.current.cameraOn && media.cameraOn) media.toggleCamera();
    if (!wanted.current.micOn && media.micOn) media.toggleMic();
  }, [media]);

  const session = useLiveSession({
    kind,
    roomId,
    role: isHost ? "host" : "viewer",
    enabled: phase === "live",
    localStream: isHost ? media.stream : null,
    screenStream: screen.stream,
    // Passed through rather than inferred from `track.enabled`: a disabled
    // track still transmits black frames and silence, which reaches a viewer
    // as a frozen picture. The engine detaches instead, so the remote tile
    // can honestly say "camera off".
    cameraOn: media.cameraOn,
    micOn: media.micOn,
    join,
    announce,
    leave,
    listPeers,
  });

  // Unlike Daily, this provider knows its own roster, so `realCount` is a
  // real number for a host rather than null — the default "host sees the
  // truth, viewer sees nothing" comes out of `headcountLabel` directly.
  const headcount = headcountLabel({
    role,
    displayCount: displayViewerCount,
    realCount: session.audienceCount,
  });

  // ---- Recording ----------------------------------------------------------
  //
  // Records what the AUDIENCE saw, not what the camera captured: the hook
  // composites camera and screen share onto a canvas, so a host switching to
  // slides mid-sentence produces one continuous file rather than a recording
  // that stops at the switch. Segments upload while the webinar is still
  // running — see the header of use-recorder.ts for why that is not an
  // optimisation but the difference between losing two minutes and losing an
  // hour.
  //
  // Gated on `!inPremiere` as well as on the host: a premiere is already a
  // recording, and re-recording the Q&A over the top of it would produce a
  // second asset that starts forty minutes in and looks like a truncated
  // duplicate.
  //
  // A 1:1 records always, from the host's side only (`call.isRecorder`), and
  // hands the recorder the other person too — their tile and their voice —
  // because half a conversation is not a record of it. See the header of
  // use-recorder.ts.
  //
  // Both kinds wait for the camera and mic to SETTLE (granted, refused, or
  // missing) before starting. Starting while the permission prompt is still up
  // records a first segment with no microphone in it, which the solo recorder
  // then has to rotate away from a second later, leaving a one-second file at
  // the head of every recording.
  const mediaSettled = media.status !== "idle" && media.status !== "requesting";

  // ---- Who records a webinar ---------------------------------------------
  //
  // Exactly one browser in the room. Every host — staff and guest speakers
  // alike — runs this component, and each one's recorder captures only its
  // own camera and mic; left to itself, every host's tab recorded, and the
  // event's recording came out as alternating slices of different people's
  // solo feeds. So each host's browser works out, from the co-hosts it can
  // see, which ONE of them records (electRecorder: staff before guests, then
  // the lowest id), and only that one does. Every browser holds the same
  // inputs — a peer's id is its user id, and the speaker list is in the
  // page — so they agree without talking to each other. When the recorder
  // leaves, the next in line sees it go and takes over; when someone who
  // outranks the recorder arrives, the recorder sees them and stands down,
  // flushing what it has.
  //
  // Nothing is decided until the join has landed (`session.joined`), or every
  // host would elect themselves off an empty roster. For RECORDER_SETTLE_MS
  // after that, a co-host still "connecting" counts as present: the join
  // payload named them, and their connection simply has not come up yet.
  const [settling, setSettling] = useState(true);
  useEffect(() => {
    if (!session.joined) {
      setSettling(true);
      return;
    }
    const t = setTimeout(() => setSettling(false), RECORDER_SETTLE_MS);
    return () => clearTimeout(t);
  }, [session.joined]);

  const speakers = webinar?.speakers;
  const guestIds = useMemo(
    () =>
      new Set(
        (speakers ?? [])
          .map((sp) => sp.userId)
          .filter((id): id is string => !!id),
      ),
    [speakers],
  );
  const selfUserId = webinar?.selfUserId ?? "";
  const recorderId = useMemo(() => {
    if (!webinar || !isHost || !session.joined) return null;
    const present: RecorderCandidate[] = [
      { userId: selfUserId, guest: guestIds.has(selfUserId) },
    ];
    for (const p of session.remotes) {
      if (p.role !== "host" || !presentForRecording(p.state, settling)) continue;
      present.push({ userId: p.peerId, guest: guestIds.has(p.peerId) });
    }
    return electRecorder(present);
  }, [webinar, isHost, session.joined, session.remotes, settling, selfUserId, guestIds]);

  // The server's backstop refusing this browser's segment means another
  // host's browser IS recording, whatever this one can see (their connection
  // to us may never have come up). Stand down for a lease, then look again.
  const [standDownUntil, setStandDownUntil] = useState<number | null>(null);
  useEffect(() => {
    if (standDownUntil === null) return;
    const t = setTimeout(
      () => setStandDownUntil(null),
      Math.max(0, standDownUntil - Date.now()),
    );
    return () => clearTimeout(t);
  }, [standDownUntil]);
  const webinarSegment = webinar?.onSegment;
  const onWebinarSegment = useCallback(
    async (blob: Blob, index: number, seconds: number) => {
      if (!webinarSegment) return;
      const outcome = await webinarSegment(blob, index, seconds);
      if (outcome === "refused") {
        setStandDownUntil(Date.now() + RECORDER_LEASE_MS);
      }
    },
    [webinarSegment],
  );

  // Not once the webinar has been ENDED, either — by this host or a co-host
  // (RoomPanel's onLiveEnded sets `endedAt` live). The gate closing flushes
  // what was recorded; a host lingering in an ended room is not more talk.
  const recordWebinar =
    !!webinar?.autoRecord &&
    isHost &&
    !inPremiere &&
    !endedAt &&
    !!selfUserId &&
    recorderId === selfUserId &&
    standDownUntil === null;
  // Who IS recording, when it is not this browser — named to the other hosts
  // so a co-host does not wonder why their header has no Recording badge.
  const recordingElsewhere =
    !!webinar?.autoRecord &&
    isHost &&
    !inPremiere &&
    !endedAt &&
    !!recorderId &&
    recorderId !== selfUserId
      ? session.remotes.find((p) => p.peerId === recorderId)?.name || "another host"
      : null;
  const recordCall = !!call?.isRecorder;
  const recorderRemotes = useMemo<RecorderRemote[] | undefined>(() => {
    if (!call) return undefined;
    if (session.remotes.length === 0) {
      return [
        {
          id: "pending",
          name: call.otherName,
          camera: null,
          screen: null,
          audio: null,
          connected: false,
        },
      ];
    }
    return session.remotes.map((p) => ({
      id: p.peerId,
      name: p.name || call.otherName,
      camera: p.streams.camera ?? null,
      screen: p.streams.screen ?? null,
      audio: p.streams.audio ?? null,
      connected: p.state === "live",
    }));
  }, [call, session.remotes]);
  const recorder = useRecorder({
    eventId: webinar?.eventId ?? roomId,
    enabled: (recordWebinar || recordCall) && phase === "live" && mediaSettled,
    cameraStream: media.stream,
    screenStream: screen.stream,
    micStream: media.stream,
    cameraOn: media.cameraOn,
    micOn: media.micOn,
    onSegment: webinar ? onWebinarSegment : call?.onSegment ?? noopSegment,
    remotes: recorderRemotes,
    localName: call?.selfName,
  });

  const onJoin = useCallback((opts: { cameraOn: boolean; micOn: boolean }) => {
    wanted.current = opts;
    // A rejoin brings a fresh stream, and the green room's toggles apply to it.
    applied.current = false;
    setPhase("live");
  }, []);

  const [ending, setEnding] = useState(false);
  const [leaving, setLeaving] = useState(false);

  /**
   * Leave, without ending anything for anybody else.
   *
   * What a viewer's button does, and what a host's does when there is a second
   * host still talking. The room carries on.
   *
   * It FLUSHES THE RECORDING first, for the same reason End does (see below):
   * `media.stop()` ends the tracks the recorder is reading, and a 1:1 has no
   * End-for-everyone step that always comes first — Leave is the button most
   * calls finish on. Stopping the tracks first cut the last segment to
   * whatever had been written, and the page leaving then dropped its upload.
   * Bounded by the recorder's own drain timeout, and instant when nothing is
   * recording, which is every viewer.
   */
  const hangUp = useCallback(async () => {
    if (leaving) return;
    setLeaving(true);
    try {
      await recorder.stop();
    } catch (err) {
      console.error("[live] recording flush failed", err);
    }
    screen.stop();
    media.stop();
    setLeaving(false);
    setPhase("left");
  }, [leaving, media, recorder, screen]);

  // ---- Ending a 1:1 -------------------------------------------------------
  //
  // End call is only offered once BOTH people have been in the room and the
  // scheduled start has come. Before that, the one person here pressing the
  // red button beside Leave is almost always trying to get out of an empty
  // room — and writing `completed` then shut the room on a mentor three
  // minutes late, moved the call to Past for both, refused the cancel that
  // would have refunded its scholarship credit, and told the student their
  // interview was done when it never happened. Leave is still there for
  // them; the sweep completes a call that genuinely ran once its window
  // closes.
  //
  // "Been in the room" is latched: someone whose connection drops after the
  // conversation has still had it, and must still be able to end it.
  const peerLive = !!call && session.remotes.some((p) => p.state === "live");
  const [peerSeen, setPeerSeen] = useState(false);
  useEffect(() => {
    if (peerLive) setPeerSeen(true);
  }, [peerLive]);
  const peerSeenRef = useRef(peerSeen);
  peerSeenRef.current = peerSeen;

  const callStartsAt = call?.startsAt;
  const [callStarted, setCallStarted] = useState(false);
  useEffect(() => {
    if (!callStartsAt) return;
    const wait = Date.parse(callStartsAt) - Date.now();
    if (!(wait > 0)) {
      setCallStarted(true);
      return;
    }
    setCallStarted(false);
    // Capped at setTimeout's ceiling; the room is only open from fifteen
    // minutes before the start, so the cap never binds in practice.
    const t = setTimeout(() => setCallStarted(true), Math.min(wait, 2_147_483_647));
    return () => clearTimeout(t);
  }, [callStartsAt]);

  /**
   * End a 1:1, for both people — or close this side because it already ended.
   *
   * Same order as ending a webinar, for the same reasons: flush the recording,
   * THEN tell the server, THEN stop the devices. The server step marks the
   * call completed (only once its start has come — see endCall); the other
   * person's room learns it on its next status poll and closes itself, which
   * flushes their recording in turn if they are the one recording.
   *
   * `elsewhere` is that other side: the call is over and this room is only
   * catching up, so it skips the server call.
   *
   * The ended screen is shown only when the call REALLY ended. `endCall`
   * answers `{ completed: false }` before the start, and a request can fail;
   * either way the call is still on (still under Upcoming, the other person
   * still in the room), so this side has LEFT it, and says so, rather than
   * announcing an end and a recording "under Past" that are not there.
   *
   * Guarded by a ref rather than the `ending` state, because the poll and the
   * button can both fire inside one render and the second must not run the
   * flush twice.
   */
  const finishingRef = useRef(false);
  const finishCall = useCallback(
    async (how: "mine" | "elsewhere") => {
      if (!call || finishingRef.current) return;
      // Nobody else has been here: this is a Leave, not an end. The button is
      // not shown in that state; this holds if something calls it anyway.
      if (how === "mine" && !peerSeenRef.current) {
        void hangUp();
        return;
      }
      finishingRef.current = true;
      setEnding(true);
      try {
        await recorder.stop();
      } catch (err) {
        console.error("[live] recording flush failed", err);
      }
      let completed = how === "elsewhere";
      if (how === "mine") {
        try {
          completed = (await call.onEndCall()).completed;
        } catch (err) {
          // A failed request must not trap anyone in the room. The sweep
          // (/api/cron/call-lifecycle) completes the call when its window
          // closes regardless.
          console.error("[live] end call failed", err);
        }
      }
      screen.stop();
      media.stop();
      setEnding(false);
      // A call that did not end can be rejoined, so the guard is released
      // for the next time this person is in the room.
      if (!completed) finishingRef.current = false;
      setPhase(completed ? "ended" : "left");
      if (how === "mine") router.push(backHref);
    },
    [backHref, call, hangUp, media, recorder, router, screen],
  );
  const finishCallRef = useRef(finishCall);
  finishCallRef.current = finishCall;

  // A 1:1 asks the server whether it is over, because the other person
  // pressing End call and the other person's wifi dropping look identical
  // from here. Without this the remaining person — and, if they are the host,
  // their recorder — sat in the room until the window closed half an hour
  // later.
  const fetchCallStatus = call?.fetchStatus;
  useEffect(() => {
    if (!fetchCallStatus || phase !== "live") return;
    let cancelled = false;
    const timer = setInterval(async () => {
      try {
        const status = await fetchCallStatus();
        if (!cancelled && (!status || status.over)) {
          void finishCallRef.current("elsewhere");
        }
      } catch {
        // A dropped poll is a few seconds of staleness, not a reason to end a
        // call that is probably still going. The next one catches up.
      }
    }, CALL_STATUS_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [fetchCallStatus, phase]);

  /**
   * End the webinar, for everyone.
   *
   * This is the button that was missing, and the order below is the whole of
   * it. Every step has to happen before the one after it, and the previous
   * behaviour — set phase to "left" and stop the tracks — skipped all four:
   *
   *  1. FLUSH THE RECORDING FIRST, and await it. `media.stop()` ends the
   *     tracks the recorder is reading, so stopping them first truncates the
   *     final segment to whatever had already been written. That is the last
   *     few minutes of the webinar — reliably the Q&A, reliably the part
   *     people re-watch.
   *  2. Tell the SERVER. Closing the host's tab already tears the peer
   *     connections down, but from a viewer's browser a host who ended and a
   *     host who dropped off hotel wifi are the same event, so the audience
   *     sits on "waiting for the host to start" until the join window closes
   *     half an hour later. Stamping `live_ended_at` is what distinguishes
   *     them; every client polls it.
   *  3. Only then stop the local devices and leave.
   *
   * The whole thing is wrapped so that a failure at step 2 — a dead network at
   * exactly the wrong moment — still lets the host out of the room. A webinar
   * that says "live" for another twenty minutes is a bad outcome; a host
   * trapped in a room by a failed request is a worse one.
   */
  const endWebinar = useCallback(async () => {
    if (ending) return;
    setEnding(true);
    try {
      await recorder.stop();
    } catch (err) {
      console.error("[live] recording flush failed", err);
    }
    try {
      await webinar?.onEndLive();
    } catch (err) {
      console.error("[live] end failed", err);
    }
    screen.stop();
    media.stop();
    setEnding(false);
    setPhase("left");
  }, [ending, media, recorder, screen, webinar]);

  /** Hand a premiere over to the live room, now. Hosts only. */
  const goLiveNow = useCallback(async () => {
    if (!webinar) return;
    try {
      await webinar.onGoLive();
      setPremierePhase("live");
    } catch (err) {
      console.error("[live] go-live failed", err);
    }
  }, [webinar]);

  if (phase === "ended") {
    return (
      <Centered title="This call has ended">
        {call?.isRecorder && (
          <p className="mb-5 text-sm text-ink-soft">
            {recorder.error
              ? "Part of the recording may not have saved — check it under Past."
              : "The recording is saved with the call — you’ll find it under Past."}
          </p>
        )}
        <ButtonLink href={backHref}>Back to your calls</ButtonLink>
      </Centered>
    );
  }

  if (phase === "left") {
    return (
      <Centered title="You've left">
        <div className="flex flex-wrap justify-center gap-2">
          {/* Back to the green room, not just a refresh: router.refresh()
              keeps this component's state, so on its own it re-rendered the
              same "You've left" and Rejoin did nothing. The refresh still
              runs, so a room that has closed in the meantime (the call ended,
              the window shut) comes back as the server's "this has ended"
              page instead of a green room for a door that is locked. */}
          <Button
            onClick={() => {
              router.refresh();
              setPhase("prejoin");
            }}
          >
            Rejoin
          </Button>
          <ButtonLink variant="secondary" href={backHref}>
            Back
          </ButtonLink>
        </div>
      </Centered>
    );
  }

  if (phase === "prejoin") {
    return (
      <PreJoin
        title={title}
        subtitle={
          call
            ? `A private 1:1 with ${call.otherName}. Your camera and mic will be on.`
            : isHost
              ? "You're the host — your camera and mic will be live."
              : qa
                ? "Your camera and mic stay off, and nobody can see who else is here. You can ask questions beside the video."
                : "You'll be able to watch and listen."
        }
        notice={call ? <CallRecordingNotice call={call} /> : undefined}
        role={role}
        onJoin={onJoin}
        joinLabel={call ? "Join call" : isHost ? "Start" : "Join"}
      />
    );
  }

  // Every broadcaster, not just the first.
  //
  // This used to be `session.remotes[0]`, which was correct for exactly as
  // long as a webinar had one host. With a guest speaker it silently drops
  // one: students see whichever broadcaster's connection came up first,
  // permanently, and the other is not merely off-screen but INAUDIBLE, because
  // the single `<AudioSink>` was wired to that one peer's audio track. Nothing
  // errors — a speaker just never arrives.
  const broadcasters = session.remotes;

  // A premiere is SHOWN while the recording is still running and the viewer is
  // not a host. A host mid-premiere gets the console below instead — they are
  // not on air yet, and watching their own recording is not what they are here
  // for.
  const premiereShowing =
    !!webinar?.premiere && premierePhase === "playing" && !isHost;
  const panel = webinar ?? qa;

  return (
    <div className={panel ? "mx-auto max-w-6xl" : "mx-auto max-w-5xl"}>
      <header className="mb-3 flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <div className="flex min-w-0 items-center gap-2.5">
          <h1 className="truncate font-display text-lg font-semibold tracking-[-0.02em] text-ink">
            {title}
          </h1>
          {/* A premiere reads as live to the audience, and it IS live in every
              way that touches them — the chat, the questions, the polls and
              the host answering at the end are all real and happening now.
              What is pre-recorded is the talk. */}
          {!endedAt && (session.state === "live" || premiereShowing) && (
            <LiveDot />
          )}
          {endedAt && (
            <span className="rounded-full border border-line px-2.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-ink-faint">
              Ended
            </span>
          )}
          {call ? (
            // Shown to BOTH people, always, from the first frame. Only the
            // host's browser knows whether its recorder is running; the
            // student is shown the policy — every 1:1 is recorded — because a
            // consent notice that could be wrong in the direction of "not
            // recording" is not one. The host alone sees it falter.
            <span
              className={`inline-flex items-center gap-1.5 text-xs ${
                call.isRecorder && recorder.state === "error"
                  ? "text-amber-600 dark:text-amber-400"
                  : "text-red-600 dark:text-red-400"
              }`}
              role="status"
              aria-live="polite"
            >
              <CircleDot
                className={`h-3.5 w-3.5 ${
                  !call.isRecorder || recorder.state === "recording"
                    ? "animate-pulse"
                    : ""
                }`}
              />
              {call.isRecorder && recorder.state === "error"
                ? "Not recording"
                : call.isRecorder && recorder.state === "uploading"
                  ? "Saving recording…"
                  : "Recording"}
            </span>
          ) : recorder.state === "recording" ? (
            <span
              className="inline-flex items-center gap-1.5 text-xs text-red-600 dark:text-red-400"
              // The host is recording a room full of students. That fact gets an
              // aria-live region rather than a silent dot, because it is the
              // kind of thing a screen-reader user must not have to go looking
              // for.
              role="status"
              aria-live="polite"
            >
              <CircleDot className="h-3.5 w-3.5 animate-pulse" />
              Recording
            </span>
          ) : (
            recordingElsewhere && (
              <span
                className="inline-flex items-center gap-1.5 text-xs text-ink-faint"
                role="status"
                aria-live="polite"
              >
                <CircleDot className="h-3.5 w-3.5" />
                Recorded from {recordingElsewhere}&rsquo;s browser
              </span>
            )
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {/*
            By default the headcount is host-only and has no viewer
            equivalent — `audienceCount` is null for a viewer, so there is no
            number here to hide. A student must not be able to tell whether
            they are one of three or one of thirty.

            An announced count overrides that for everyone, which is the point
            of the field. The host is not lied to: when the figure is
            announced, the real roster is shown beside it.
          */}
          {headcount && (
            <span className="inline-flex items-center gap-1.5 rounded-full border border-line px-2.5 py-0.5 text-xs text-ink-faint">
              <Users className="h-3.5 w-3.5" />
              {headcount.count.toLocaleString()} watching
              {headcount.announced && isHost && session.audienceCount !== null && (
                <span className="text-ink-faint/70">
                  · {session.audienceCount} really here
                </span>
              )}
            </span>
          )}
          <span
            className={`rounded-full border px-2.5 py-0.5 font-mono text-[10px] uppercase tracking-wider ${
              isHost
                ? "border-phosphor/50 bg-phosphor/10 text-phosphor-ink"
                : "border-line text-ink-faint"
            }`}
          >
            {isHost ? "Hosting" : "Watching"}
          </span>
        </div>
      </header>

      {call && (
        <p className="mb-3 text-xs text-ink-faint">
          This call is recorded. Only you, {call.otherName} and batch0 admins
          can watch it back.
        </p>
      )}

      {session.error && (
        <div className="mb-3 flex items-start gap-2.5 rounded-xl border border-amber-500/40 bg-amber-400/10 p-3">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
          <p className="text-xs text-ink-soft">{session.error}</p>
        </div>
      )}

      <div className="flex flex-col gap-3 lg:flex-row">
        <div className="min-w-0 flex-1 space-y-3">
          {isHost ? (
            <>
              {/* Presenting replaces the big frame; the camera drops to a
                  corner tile, which is what a viewer sees too. */}
              {screen.stream ? (
                <>
                  <VideoTile
                    stream={screen.stream}
                    name="Your screen"
                    label="presenting"
                    muted
                    className="w-full"
                  />
                  <div className="w-48">
                    <VideoTile
                      stream={media.stream}
                      name="You"
                      label="host"
                      cameraOn={media.cameraOn}
                      micOn={media.micOn}
                      mirrored
                      muted
                    />
                  </div>
                </>
              ) : (
                <VideoTile
                  stream={media.stream}
                  name="You"
                  label="host"
                  cameraOn={media.cameraOn}
                  micOn={media.micOn}
                  mirrored
                  muted
                  className="w-full"
                />
              )}

              {/* Other broadcasters — a co-host, or the other party in a 1:1.
                  Never the audience. */}
              {session.remotes.length > 0 && (
                <div className="grid gap-3 sm:grid-cols-2">
                  {session.remotes.map((p) => (
                    <RemoteTile key={p.peerId} peer={p} />
                  ))}
                </div>
              )}
            </>
          ) : premiereShowing ? (
            <PremierePlayer
              src={webinar!.premiere!.url}
              offsetSeconds={webinar!.premiere!.offsetSeconds}
              durationSeconds={webinar!.premiere!.durationSeconds}
              title={title}
              onExpired={() => router.refresh()}
              // The recording finishing is a HINT, not the handover. The server
              // owns that moment (`live_started_at`, or the schedule), and the
              // poll above is what acts on it — so this only nudges the poll
              // rather than switching the room on the browser's say-so.
              onRecordingFinished={() =>
                void webinar?.refreshPremiere().catch(() => {})
              }
              onLeave={hangUp}
            />
          ) : (
            <ViewerStage
              peers={broadcasters}
              waitingLabel={
                endedAt
                  ? "This webinar has ended"
                  : premierePhase === "waiting"
                    ? "Starting shortly"
                    : undefined
              }
            />
          )}

          {webinar && webinar.speakers.length > 0 && (
            <SpeakerStrip speakers={webinar.speakers} compact />
          )}
        </div>

        {(webinar || qa) && (
          <div className="h-[50vh] min-h-[320px] w-full shrink-0 lg:h-[70vh] lg:w-80">
            {webinar && webinar.initialRoomState ? (
              // The rich panel: chat, the question queue with upvotes, polls
              // and reactions, all over Realtime rather than the 5-second poll
              // QAPanel was built around.
              <RoomPanel
                eventId={webinar.eventId}
                isModerator={isHost}
                audienceMode={webinar.audienceMode}
                initial={webinar.initialRoomState}
                roomTopic={session.roomTopic}
                moderationTopic={session.moderationTopic}
                onLiveEnded={(at) => setEndedAt(at)}
              />
            ) : (
              // The fallback, and it is a real one rather than dead code: a
              // deploy that lands before migration 0084 is applied by hand gets
              // a null room state, and a webinar that degrades to the question
              // queue it has always had is very much better than one that
              // renders an error where the panel should be.
              <QAPanel
                eventId={webinar?.eventId ?? qa!.eventId}
                role={role}
                initialQuestions={
                  webinar?.initialQuestions ?? qa!.initialQuestions
                }
              />
            )}
          </div>
        )}
      </div>

      <div className="mt-3 flex flex-wrap items-center justify-center gap-3">
        <CallControls
          micOn={media.micOn}
          cameraOn={media.cameraOn}
          onToggleMic={media.toggleMic}
          onToggleCamera={media.toggleCamera}
          onToggleScreen={isHost && !inPremiere ? screen.toggle : undefined}
          screenSharing={!!screen.stream}
          // Leave, for everyone. A host ALSO gets End beside it — the two are
          // deliberately different buttons rather than one that guesses, because
          // a co-host stepping out and the webinar finishing are different
          // intentions and only one of them is reversible.
          onLeave={() => void hangUp()}
          canBroadcast={isHost && !inPremiere}
        />

        {call && peerSeen && callStarted && (
          <Button
            variant="danger"
            onClick={() => void finishCall("mine")}
            disabled={ending || leaving}
          >
            {ending
              ? recorder.state === "uploading"
                ? "Saving the recording…"
                : "Ending…"
              : "End call"}
          </Button>
        )}

        {isHost && webinar && inPremiere && (
          <Button onClick={goLiveNow}>Go live now</Button>
        )}

        {isHost && webinar && !inPremiere && !endedAt && (
          <Button variant="danger" onClick={endWebinar} disabled={ending}>
            {ending
              ? recorder.state === "uploading"
                ? "Saving the recording…"
                : "Ending…"
              : "End webinar"}
          </Button>
        )}

        {isHost && webinar && endedAt && (
          <Button
            variant="secondary"
            onClick={() =>
              void webinar.onReopenLive().then(() => setEndedAt(null))
            }
          >
            Reopen
          </Button>
        )}
      </div>

      {/* The recorder speaks up only when something is wrong or still in
          flight. A host closing the tab on "Saving the recording…" is how the
          last segment gets lost, so it is said out loud rather than left to a
          spinner nobody reads. */}
      {isHost && recorder.error && (
        <p className="mt-2 text-center text-xs text-amber-600 dark:text-amber-400">
          {recorder.error}
        </p>
      )}
      {leaving && recorder.state === "uploading" && (
        <p className="mt-2 text-center text-xs text-ink-faint">
          Saving the recording before you go — keep this tab open.
        </p>
      )}
    </div>
  );
}

/**
 * The green room's recording notice for a 1:1.
 *
 * Before the Join button, not after it: the participants are often minors, and
 * a notice that appears once they are already on camera is a notice after the
 * fact. It says who can watch the recording, because "recorded" with no
 * audience named reads as "recorded for anyone".
 */
function CallRecordingNotice({ call }: { call: CallRoom }) {
  return (
    <div className="mt-4 flex gap-2.5 rounded-xl border border-red-500/30 bg-red-500/5 p-3">
      <CircleDot className="mt-0.5 h-4 w-4 shrink-0 text-red-600 dark:text-red-400" />
      <div className="text-xs">
        <p className="font-medium text-ink">This call is recorded</p>
        <p className="mt-1 text-ink-soft">
          {call.isRecorder
            ? `Recording starts when you join and saves as you go. Only you, ${call.otherName} and batch0 admins can watch it back.`
            : `The whole call is recorded, both sides. Only you, ${call.otherName} and batch0 admins can watch it back.`}
        </p>
      </div>
    </div>
  );
}

/**
 * What a student sees: the host, large, and nothing else.
 *
 * Audio is rendered through a separate hidden `<audio>` rather than relying on
 * whichever video element happens to carry it. The host's audio arrives on its
 * own transceiver (slot `audio`), and when the host switches to slides the
 * video element being shown changes — if sound rode along with a particular
 * video tag, presenting would silence the webinar.
 */
function ViewerStage({
  peers,
  waitingLabel,
}: {
  peers: {
    peerId: string;
    name: string;
    state: string;
    streams: { camera?: MediaStream; screen?: MediaStream; audio?: MediaStream };
  }[];
  /** Overrides the placeholder copy for a premiere or a finished webinar. */
  waitingLabel?: string;
}) {
  // Who gets the big frame. Presenting wins — slides are the thing being
  // discussed, and a talking head beside them is the sideshow — and otherwise
  // it is simply the first broadcaster who actually has a picture.
  const presenting = peers.find((p) => p.streams.screen);
  const primary = presenting ?? peers.find((p) => p.streams.camera) ?? peers[0];
  const others = peers.filter((p) => p.peerId !== primary?.peerId);
  const connected = !!primary && primary.state === "live";
  const screen = primary?.streams.screen ?? null;
  const camera = primary?.streams.camera ?? null;

  // EVERY broadcaster's audio is mounted, always, including the ones whose
  // video is a thumbnail and the one whose camera is off entirely. Audio rides
  // its own transceiver, so tying it to whichever video element happens to be
  // on screen is how a guest speaker becomes inaudible the moment the host
  // starts presenting — and how a host talking with their camera off silences
  // the whole webinar.
  const audio = (
    <>
      {peers.map((p) => (
        <AudioSink key={p.peerId} stream={p.streams.audio ?? null} />
      ))}
    </>
  );

  if (!camera && !screen) {
    return (
      <>
        {audio}
        <div className="grid aspect-video w-full place-items-center rounded-xl border border-line bg-ink-900">
          <div className="px-6 text-center">
            {!waitingLabel && (
              <Loader2 className="mx-auto h-6 w-6 animate-spin text-ink-faint" />
            )}
            <p className="mt-3 text-sm font-medium text-[#fff]">
              {waitingLabel ??
                (connected
                  ? "The host's camera is off"
                  : "Waiting for the host to start")}
            </p>
            <p className="mt-1 text-xs text-[#fff]/60">
              {waitingLabel
                ? "You can keep chatting and asking questions here."
                : connected
                  ? "You'll hear them, and see them as soon as they turn it on."
                  : "You'll join automatically — no need to refresh."}
            </p>
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      {audio}
      {screen ? (
        <>
          <VideoTile
            stream={screen}
            name={primary!.name}
            label="presenting"
            muted
            className="w-full"
          />
          {camera && (
            <div className="mt-3 w-48">
              <VideoTile stream={camera} name={primary!.name} muted />
            </div>
          )}
        </>
      ) : (
        <VideoTile
          stream={camera}
          name={primary!.name}
          label="host"
          muted
          className="w-full"
        />
      )}

      {/* Co-hosts and guest speakers, beside the main frame rather than
          replacing it. Never the audience — `session.remotes` only ever
          contains broadcasters, because the server never told a viewer that
          another viewer exists. */}
      {others.length > 0 && (
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          {others.map((p) => (
            <VideoTile
              key={p.peerId}
              stream={p.streams.screen ?? p.streams.camera ?? null}
              name={p.name}
              label={p.streams.screen ? "presenting" : undefined}
              cameraOn={!!(p.streams.screen ?? p.streams.camera)}
              micOn={!!p.streams.audio}
              muted
            />
          ))}
        </div>
      )}
    </>
  );
}

/** Remote audio, decoupled from whichever video tile is on screen. */
function AudioSink({ stream }: { stream: MediaStream | null }) {
  const ref = useRef<HTMLAudioElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (el.srcObject !== (stream ?? null)) el.srcObject = stream ?? null;
    // Autoplay can still be refused before any interaction; nothing useful to
    // do beyond not throwing. Joining is a click, so in practice it plays.
    if (stream) el.play?.().catch(() => {});
  }, [stream]);
  return <audio ref={ref} autoPlay playsInline className="hidden" />;
}

function RemoteTile({
  peer,
}: {
  peer: { name: string; streams: { camera?: MediaStream; screen?: MediaStream; audio?: MediaStream } };
}) {
  // `screen` is only ever present while the peer is genuinely presenting —
  // the engine drops a slot whose track is muted, so this no longer picks an
  // empty screen transceiver over a live camera.
  const screen = peer.streams.screen ?? null;
  const camera = peer.streams.camera ?? null;
  return (
    <>
      <AudioSink stream={peer.streams.audio ?? null} />
      <VideoTile
        stream={screen ?? camera}
        name={peer.name}
        label={screen ? "presenting" : undefined}
        cameraOn={!!(screen ?? camera)}
        micOn={!!peer.streams.audio}
        muted
      />
    </>
  );
}

/**
 * Screen sharing.
 *
 * Kept out of `useLocalMedia` because it is a different permission with a
 * different lifecycle: the browser puts its own "Stop sharing" bar on screen,
 * and a share that ends there must be reflected here or the host keeps seeing
 * a control that claims they are still presenting.
 */
function useScreenShare() {
  const [stream, setStream] = useState<MediaStream | null>(null);

  const stop = useCallback(() => {
    setStream((s) => {
      s?.getTracks().forEach((t) => t.stop());
      return null;
    });
  }, []);

  const start = useCallback(async () => {
    const md = navigator.mediaDevices as MediaDevices & {
      getDisplayMedia?: (c: DisplayMediaStreamOptions) => Promise<MediaStream>;
    };
    if (!md?.getDisplayMedia) return;
    try {
      const s = await md.getDisplayMedia({ video: true, audio: false });
      // The browser's own stop button ends the track, not our state.
      s.getVideoTracks()[0]?.addEventListener("ended", () => setStream(null));
      setStream(s);
    } catch {
      // Cancelling the picker is a normal outcome, not an error worth showing.
    }
  }, []);

  const toggle = useCallback(() => {
    if (stream) stop();
    else void start();
  }, [start, stop, stream]);

  useEffect(() => () => stream?.getTracks().forEach((t) => t.stop()), [stream]);

  return { stream, toggle, stop };
}

/** A room with no recording destination. Unreachable while `enabled` is false. */
async function noopSegment(): Promise<void> {}

function Centered({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mx-auto max-w-2xl py-16 text-center">
      <h1 className="font-display text-2xl font-semibold tracking-[-0.02em] text-ink">
        {title}
      </h1>
      <div className="mt-5">{children}</div>
    </div>
  );
}
