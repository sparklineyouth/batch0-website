"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { PreJoin } from "@/components/live/pre-join";
import { LiveDot } from "@/components/live/call-stage";
import { VideoTile } from "@/components/live/video-tile";
import { CallControls } from "@/components/live/call-controls";
import { QAPanel } from "@/components/live/qa-panel";
import { RoomPanel } from "@/components/live/room-panel";
import { PremierePlayer } from "@/components/live/premiere-player";
import { useLocalMedia } from "@/components/live/use-local-media";
import {
  useLiveSession,
  type CloseReason,
  type RemotePeer,
} from "@/components/live/use-live-session";
import { useRecorder } from "@/components/live/use-recorder";
import { SpeakerStrip } from "@/components/live/speaker-strip";
import { Button, ButtonLink } from "@/components/ui/button";
import { LocalTime } from "@/components/ui/local-time";
import { getActionError } from "@/lib/action-error";
import {
  headcountLabel,
  JOIN_CLOSES_MINUTES_AFTER,
  type LiveRole,
  type WebinarQuestion,
} from "@/lib/live";
import type { LivePeer } from "@/lib/live-rooms";
import type { SignalRole } from "@/lib/live-signal";
import type {
  AudienceMode,
  EventSpeaker,
  PremiereState,
} from "@/lib/webinars";
import type { RoomState } from "@/app/dashboard/events/[id]/live/room-actions";
import type { JoinResult, PresenceResult } from "@/app/live/actions";
import { AlertTriangle, Users, Loader2, CircleDot, PhoneOff } from "lucide-react";

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
 *
 * ---------------------------------------------------------------------------
 * Leave vs End — the two ways out, and why they are different buttons
 * ---------------------------------------------------------------------------
 *
 *   Leave        "I go; the room keeps running." Flush this tab's recording,
 *                stop the devices, tear the session down, "You've left" with a
 *                Rejoin that really rejoins. The last broadcaster on air in a
 *                webinar is asked first — End for everyone, or Leave and keep
 *                the room open — because a sole host who simply leaves strands
 *                the audience on "the host stepped away".
 *   End          Webinar: staff (and a guest speaker only when no staff host
 *                is present) end it for EVERYONE — the server stamps it, every
 *                other client hears `room-changed` and closes, and this tab
 *                lands on an ended screen with Reopen for staff. 1:1: only the
 *                owner (the inviter) can End call, for both people.
 *
 * Whichever way the room ends — this tab's End, another host's, a heartbeat
 * saying 'ended', the stage hint, the 8s poll — the teardown is the same and
 * in the same order: flush the recorder, stop screen/camera/mic, and only then
 * leave the live phase (which tears the session down). An End that fails
 * tears nothing down: the host stays live with the error and can retry.
 *
 * ---------------------------------------------------------------------------
 * Rejoin is a remount
 * ---------------------------------------------------------------------------
 *
 * The room is two components: `BroadcastRoom` holds an attempt counter, and
 * the session below is keyed on it. Rejoin bumps the key (and refreshes the
 * server tree), so every hook starts from nothing — phase, media, recorder,
 * the peer engine. `router.refresh()` alone keeps client state, which is why
 * Rejoin used to leave people staring at "You've left" until they reloaded.
 */

type Phase = "prejoin" | "live" | "left" | "ended" | "closed";

export type WebinarRoom = {
  eventId: string;
  audienceMode: AudienceMode;
  /** Staff, as opposed to a guest speaker who also broadcasts. */
  isStaffHost: boolean;
  autoRecord: boolean;
  /** Null for an ordinary live webinar. */
  premiere: (PremiereState & { url: string; durationSeconds: number }) | null;
  liveEndedAt: string | null;
  /**
   * May this reader end the webinar for everyone, as of the page render?
   * Staff always; a guest speaker only when no staff host is present. Kept
   * current by the poll and the panel's reads — the server decides.
   */
  canEnd: boolean;
  speakers: EventSpeaker[];
  deck: { id: string; filename: string; sizeBytes: number | null }[];
  initialQuestions: WebinarQuestion[];
  initialRoomState: RoomState | null;
  onSegment: (blob: Blob, index: number, seconds: number) => Promise<void>;
  /**
   * The next recording segment number, from the server. Seeds the recorder so
   * a reload or a handover appends instead of overwriting segment 0.
   */
  nextRecordingIndex: () => Promise<number>;
  onGoLive: () => Promise<string | null>;
  /** End for everyone. Resolves with the STORED `live_ended_at`. */
  onEndLive: () => Promise<string>;
  onReopenLive: () => Promise<void>;
  /**
   * Re-read the room's live state from the SERVER: the premiere's position
   * (from the server's clock), whether it has been ended, and whether this
   * reader may end it.
   *
   * Polled as a backstop rather than trusted from the browser. A viewer whose
   * laptop is four minutes fast would otherwise drift four minutes ahead of the
   * room — visibly, in chat, reacting to something nobody else has seen — and
   * one whose clock is out by an hour would watch a black screen and conclude
   * the webinar never started.
   */
  refreshPremiere: () => Promise<
    | (PremiereState & {
        liveEndedAt: string | null;
        canEnd: boolean;
        isStaff: boolean;
      })
    | null
  >;
};

/**
 * What makes a room a 1:1 rather than a webinar, from the room's side.
 *
 * Both parties broadcast (signal role `host`), so the role cannot say who owns
 * the call; this does. Only the owner — the inviter, which always includes an
 * admin in a call, because invitees are students — gets End call.
 */
export type CallRoom = {
  isOwner: boolean;
  otherName: string;
  /** Scheduled end. Rejoining stays possible until the window closes after it. */
  endsAt: string;
  onEndCall: () => Promise<void>;
};

type RoomProps = {
  kind: "event" | "call";
  roomId: string;
  title: string;
  role: LiveRole;
  /**
   * Where Back and every after-leave link go. Role-aware, decided by the
   * page: staff webinar hosts go to the admin list, a call's owner to their
   * calls page, students to theirs. Never `history.back()`, which does
   * nothing in a tab opened from a calendar invite.
   */
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
  /** The 1:1 equivalent — see CallRoom. */
  call?: CallRoom;
  join: () => Promise<JoinResult>;
  announce: (joinedAs?: SignalRole) => Promise<PresenceResult>;
  leave: () => Promise<void>;
  listPeers: () => Promise<LivePeer[]>;
};

type RejoinOptions = {
  /** What the room currently knows about End, carried across the remount. */
  endedAt?: string | null;
  /** The role the server minted, when it disagreed with the page. */
  role?: LiveRole;
};

export function BroadcastRoom(props: RoomProps) {
  const router = useRouter();
  const [attempt, setAttempt] = useState(0);
  const [roleOverride, setRoleOverride] = useState<LiveRole | null>(null);
  // The remount can land before the refreshed server props do, so what the
  // room last knew about End is carried across explicitly — otherwise a host
  // coming back from Reopen would mount on the stale "ended" prop.
  const [endedOverride, setEndedOverride] = useState<{
    at: string | null;
  } | null>(null);

  const rejoin = useCallback(
    (opts?: RejoinOptions) => {
      if (opts && "endedAt" in opts) {
        setEndedOverride({ at: opts.endedAt ?? null });
      }
      if (opts?.role) setRoleOverride(opts.role);
      setAttempt((n) => n + 1);
      router.refresh();
    },
    [router],
  );

  return (
    <BroadcastSession
      key={attempt}
      {...props}
      role={roleOverride ?? props.role}
      initialEndedAt={
        endedOverride ? endedOverride.at : (props.webinar?.liveEndedAt ?? null)
      }
      rejoin={rejoin}
    />
  );
}

function BroadcastSession({
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
  initialEndedAt,
  rejoin,
}: RoomProps & {
  initialEndedAt: string | null;
  rejoin: (opts?: RejoinOptions) => void;
}) {
  const router = useRouter();
  const isHost = role === "host";
  const isCall = kind === "call";
  const isStaffHost = isHost && !!webinar?.isStaffHost;

  // ---- Premiere, End, and who may End -------------------------------------
  //
  // Tracked as state because they CHANGE under everyone during the session:
  // the recording runs out, a host presses "go live" thirty minutes into a
  // forty-minute talk, someone ends the webinar. Seeded from the server render
  // so the first paint is already correct.
  const [premierePhase, setPremierePhase] = useState(
    webinar?.premiere?.phase ?? null,
  );
  const [endedAt, setEndedAt] = useState<string | null>(initialEndedAt);
  const [canEnd, setCanEnd] = useState(!!webinar?.canEnd);
  // A viewer who arrives on an ended webinar (only ever via a stale page — the
  // server renders the ended shell for them) goes straight to the ended screen.
  const [phase, setPhase] = useState<Phase>(
    !isHost && webinar && initialEndedAt ? "ended" : "prejoin",
  );
  const [closedReason, setClosedReason] = useState<CloseReason | null>(null);
  const [endedByMe, setEndedByMe] = useState(false);
  const inPremiere =
    !!webinar?.premiere &&
    (premierePhase === "playing" || premierePhase === "waiting");

  // A fresh server render (after Rejoin's refresh) is the truth about End
  // while we are still in the green room. Skipped on mount, where the seed
  // above already accounts for anything Rejoin carried across.
  const propEndedAt = webinar?.liveEndedAt ?? null;
  const firstProp = useRef(true);
  useEffect(() => {
    if (firstProp.current) {
      firstProp.current = false;
      return;
    }
    if (phase === "prejoin") setEndedAt(propEndedAt);
    // Only a change of the prop should re-seed; the phase is read, not watched.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [propEndedAt]);

  const hasPremiere = !!webinar?.premiere;
  const applyServer = useCallback(
    (next: {
      phase: PremiereState["phase"];
      liveEndedAt: string | null;
      canEnd: boolean;
    }) => {
      // Only a premiere tracks a premiere phase. A hosted webinar is live the
      // whole time; reading it as a premiere hid the host's camera and End.
      if (hasPremiere) setPremierePhase(next.phase);
      setEndedAt(next.liveEndedAt);
      setCanEnd(next.canEnd);
    },
    [hasPremiere],
  );

  // The live-state poll: the backstop under the stage hint and the panel's
  // bump. Only while live — it used to run from the green room through the
  // "You've left" screen for as long as the tab stayed open — and paused
  // while the tab is hidden.
  const refreshPremiere = webinar?.refreshPremiere;
  const pollNow = useRef<() => void>(() => {});
  useEffect(() => {
    if (!refreshPremiere || phase !== "live") return;
    let cancelled = false;
    const tick = async () => {
      if (typeof document !== "undefined" && document.hidden) return;
      try {
        const next = await refreshPremiere();
        if (cancelled || !next) return;
        applyServer(next);
      } catch {
        // A dropped poll costs a few seconds of staleness; the next one
        // catches up. Surfacing it would put an error banner over a webinar
        // that is working.
      }
    };
    pollNow.current = () => void tick();
    void tick();
    // Every eight seconds. Frequent enough that "go live early" reaches the
    // room while the host is still saying "we're going live now", cheap enough
    // that fifty viewers cost about six requests a second between them — an
    // order of magnitude below the 5-second Q&A poll this feature replaced.
    const timer = setInterval(tick, 8_000);
    const onVisibility = () => {
      if (!document.hidden) void tick();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      cancelled = true;
      pollNow.current = () => {};
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [refreshPremiere, phase, applyServer]);

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
  // forty minutes before anyone can see it is both wasteful and alarming. Nor
  // on an ended webinar. The gate closing does not stop the devices (see
  // useLocalMedia) — the teardown below does, after the recorder has flushed.
  const media = useLocalMedia({
    autoStart: isHost && phase === "live" && !inPremiere && !endedAt,
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
  // truth, viewer sees nothing" comes out of `headcountLabel` directly. The
  // engine reports null in a 1:1, so a call never grows a "0 watching" chip.
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
  // optimisation but the difference between losing five minutes and losing an
  // hour.
  //
  // Exactly one recorder per webinar: a staff host the SERVER has picked
  // (`session.isRecorder`, recomputed every heartbeat), never a guest speaker.
  // Two staff hosts each recording used to interleave — and, before segment
  // numbers were seeded from the server, overwrite — each other's files.
  //
  // Gated on `!inPremiere` as well: a premiere is already a recording, and
  // re-recording the Q&A over the top of it would produce a second asset that
  // starts forty minutes in and looks like a truncated duplicate. And never
  // after End, or once this tab is on its way out — the gate closing is the
  // flush. (Not while an End request is merely in flight: if the server
  // refuses, the host is still live and still recording.)
  const [ending, setEnding] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const recorderEnabled =
    !!webinar?.autoRecord &&
    isStaffHost &&
    phase === "live" &&
    !inPremiere &&
    !endedAt &&
    !ending &&
    !leaving &&
    session.isRecorder;
  const recorder = useRecorder({
    eventId: webinar?.eventId ?? roomId,
    enabled: recorderEnabled,
    cameraStream: media.stream,
    screenStream: screen.stream,
    micStream: media.stream,
    cameraOn: media.cameraOn,
    micOn: media.micOn,
    onSegment: webinar?.onSegment ?? noopSegment,
  });

  // The trigger that was missing: nothing ever called `start()`, so
  // auto-record never recorded a thing. Starts once this host is the picked
  // recorder and the camera is up, numbering from the server's next segment
  // index so a reload or a handover appends. A failed index read is retried
  // rather than guessed at — starting from 0 would overwrite the opening.
  const [seedRetry, setSeedRetry] = useState(0);
  const seedIndex = webinar?.nextRecordingIndex;
  const startRecording = recorder.start;
  useEffect(() => {
    if (!recorderEnabled || media.status !== "ready") return;
    if (recorder.state !== "idle" || !seedIndex) return;
    let cancelled = false;
    let retry: ReturnType<typeof setTimeout> | null = null;
    seedIndex().then(
      (startIndex) => {
        if (!cancelled) startRecording({ startIndex });
      },
      (err) => {
        if (cancelled) return;
        console.error("[live] couldn't read the next recording index", err);
        retry = setTimeout(() => setSeedRetry((n) => n + 1), 10_000);
      },
    );
    return () => {
      cancelled = true;
      if (retry) clearTimeout(retry);
    };
  }, [
    recorderEnabled,
    media.status,
    recorder.state,
    seedIndex,
    startRecording,
    seedRetry,
  ]);

  const onJoin = useCallback((opts: { cameraOn: boolean; micOn: boolean }) => {
    wanted.current = opts;
    setPhase("live");
  }, []);

  // ---- Teardown -----------------------------------------------------------

  /**
   * One way out of the live phase, in the one safe order: flush the recording
   * (awaited — `media.stop()` ends the tracks the recorder reads, so stopping
   * them first truncates the final segment, reliably the Q&A), stop screen,
   * camera and mic, then change phase, which disables and tears down the
   * session (bye to every peer, channels removed, leave).
   */
  const stopRecording = recorder.stop;
  const finish = useCallback(
    async (next: Exclude<Phase, "prejoin" | "live">) => {
      try {
        await stopRecording();
      } catch (err) {
        console.error("[live] recording flush failed", err);
      }
      screen.stop();
      media.stop();
      setPhase(next);
    },
    [stopRecording, screen, media],
  );

  /** Guards every exit so two of them (End + the hint it causes) never race. */
  const exitingRef = useRef(false);
  /** An End request is with the server; nothing has been torn down yet. */
  const [endPending, setEndPending] = useState(false);
  const [leavePrompt, setLeavePrompt] = useState(false);
  const [endError, setEndError] = useState<string | null>(null);

  /** Someone else ended it (or the server says so): the same teardown. */
  const enterEnded = useCallback(() => {
    if (exitingRef.current) return;
    exitingRef.current = true;
    setEnding(true);
    setLeavePrompt(false);
    void finish("ended");
  }, [finish]);

  /** The server closed the room for a reason other than End. */
  const enterClosed = useCallback(
    (reason: CloseReason) => {
      if (exitingRef.current) return;
      exitingRef.current = true;
      setEnding(true);
      setLeavePrompt(false);
      setClosedReason(reason);
      void finish("closed");
    },
    [finish],
  );

  // End is terminal however it arrives — the poll, the panel's read, or this
  // tab's own End button (which has already claimed the exit).
  useEffect(() => {
    if (phase === "live" && endedAt) enterEnded();
  }, [phase, endedAt, enterEnded]);

  // Read by an End that FAILED: while its request was out, the room may have
  // been ended or closed anyway (the server stamped it and the response was
  // lost), and the effects that would have acted on that already ran while
  // the End held the exit.
  const closedRef = useRef(session.closed);
  closedRef.current = session.closed;
  const endedAtRef = useRef(endedAt);
  endedAtRef.current = endedAt;
  const afterFailedEnd = useCallback(() => {
    const closed = closedRef.current;
    if (closed && closed.reason !== "ended") enterClosed(closed.reason);
    else if (closed || endedAtRef.current) enterEnded();
  }, [enterClosed, enterEnded]);

  // ...or the engine: a heartbeat or a `room-changed` re-check that came back
  // 'ended', 'cancelled', 'closed' or 'revoked'. The engine has already torn
  // itself down; this stops the devices and says what happened.
  useEffect(() => {
    const closed = session.closed;
    if (!closed || phase !== "live") return;
    if (closed.reason === "ended") {
      // Fetch the stored time for the ended screen; the teardown does not wait.
      if (webinar && refreshPremiere) {
        void refreshPremiere()
          .then((next) => {
            if (next?.liveEndedAt) setEndedAt(next.liveEndedAt);
          })
          .catch(() => {});
      }
      enterEnded();
    } else {
      enterClosed(closed.reason);
    }
  }, [session.closed, phase, webinar, refreshPremiere, enterEnded, enterClosed]);

  // The server minted a different role than the page rendered (a speaker row
  // removed between render and Start, a profile read that fell back). Never
  // run a host engine on viewer credentials or the reverse: remount as what
  // the server says, back through the green room.
  const pageRole: SignalRole = isHost ? "host" : "viewer";
  useEffect(() => {
    const minted = session.serverRole;
    if (!minted || minted === pageRole || phase !== "live") return;
    rejoin({ role: minted, endedAt });
    // endedAt is carried, not watched.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.serverRole, pageRole, phase, rejoin]);

  const otherBroadcasterLive = session.remotes.some(
    (r) => r.role === "host" && r.state === "live",
  );
  /** The last broadcaster on air in a running webinar — Leave asks first. */
  const soleOnAirHost =
    !!webinar && isHost && phase === "live" && !endedAt && !otherBroadcasterLive;

  /** Leave, without ending anything for anybody else. */
  const leaveNow = useCallback(async () => {
    if (exitingRef.current) return;
    exitingRef.current = true;
    setLeavePrompt(false);
    setLeaving(true);
    await finish("left");
  }, [finish]);

  /**
   * The Leave button. What a viewer's does, what a host's does when another
   * broadcaster is still on air — and, for the last one on air, a question
   * first, because a sole host who just leaves strands the whole audience.
   */
  const hangUp = useCallback(() => {
    if (soleOnAirHost) {
      setLeavePrompt(true);
      // Whether a guest speaker may End depends on who else is present right
      // now, which the server knows and the page render may not.
      pollNow.current();
      return;
    }
    void leaveNow();
  }, [soleOnAirHost, leaveNow]);

  /**
   * End the webinar, for everyone.
   *
   *  1. Tell the SERVER, first and alone. If this fails nothing has been torn
   *     down: the host is still live, sees why, and can press it again. (It
   *     used to swallow the error and leave anyway, so a webinar past its
   *     window "ended" on screen and stayed live for everyone else.)
   *  2. Flush the recording, then stop the devices, then the ended screen —
   *     `finish`, in that order. Every other client hears `room-changed` and
   *     does the same on their side.
   */
  const endWebinar = useCallback(async () => {
    if (!webinar || exitingRef.current) return;
    exitingRef.current = true;
    setEndPending(true);
    setEndError(null);
    setLeavePrompt(false);
    let stored: string;
    try {
      stored = await webinar.onEndLive();
    } catch (err) {
      exitingRef.current = false;
      setEndPending(false);
      setEndError(getActionError(err, "Couldn't end the webinar — try again."));
      afterFailedEnd();
      return;
    }
    setEndPending(false);
    setEnding(true);
    setEndedByMe(true);
    setEndedAt(stored);
    await finish("ended");
  }, [webinar, finish, afterFailedEnd]);

  /** End a 1:1 for both people. The owner only; same shape as endWebinar. */
  const endCallNow = useCallback(async () => {
    if (!call || exitingRef.current) return;
    exitingRef.current = true;
    setEndPending(true);
    setEndError(null);
    try {
      await call.onEndCall();
    } catch (err) {
      exitingRef.current = false;
      setEndPending(false);
      setEndError(getActionError(err, "Couldn't end the call — try again."));
      afterFailedEnd();
      return;
    }
    setEndPending(false);
    setEnding(true);
    setEndedByMe(true);
    await finish("ended");
  }, [call, finish, afterFailedEnd]);

  /** Hand a premiere over to the live room, now. Hosts only. */
  const goLiveNow = useCallback(async () => {
    if (!webinar) return;
    try {
      await webinar.onGoLive();
      setPremierePhase("live");
    } catch (err) {
      setEndError(getActionError(err, "Couldn't go live — try again."));
    }
  }, [webinar]);

  // Reopen from the green room ("Ended at 19:40 — Reopen and go live"): an
  // explicit choice, never a side effect of pressing Start.
  const [joinBusy, setJoinBusy] = useState(false);
  const [joinError, setJoinError] = useState<string | null>(null);
  const reopenAndJoin = useCallback(
    async (opts: { cameraOn: boolean; micOn: boolean }) => {
      if (!webinar) return;
      setJoinBusy(true);
      setJoinError(null);
      try {
        await webinar.onReopenLive();
        setEndedAt(null);
        wanted.current = opts;
        setPhase("live");
      } catch (err) {
        setJoinError(getActionError(err, "Couldn't reopen the webinar."));
      } finally {
        setJoinBusy(false);
      }
    },
    [webinar],
  );

  // A tab closed mid-webinar by its last host strands the audience, and one
  // closed while segments are still uploading loses them. Both get the
  // browser's own "leave this page?" — and nothing else does.
  const guardUnload =
    (soleOnAirHost && session.state === "live") ||
    recorder.state === "uploading";
  useEffect(() => {
    if (!guardUnload) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [guardUnload]);

  // The panel heard `stage-change` (go-live, End, Reopen): re-ask the server
  // now instead of waiting out the poll.
  const recheck = session.recheck;
  const onStageChange = useCallback(() => {
    recheck();
    pollNow.current();
  }, [recheck]);

  const rejoinUntil = call
    ? new Date(
        new Date(call.endsAt).getTime() + JOIN_CLOSES_MINUTES_AFTER * 60_000,
      ).toISOString()
    : null;

  const recordingNote =
    isHost && webinar ? (
      <RecordingStatus
        state={recorder.state}
        uploaded={recorder.uploaded}
        error={recorder.error}
      />
    ) : null;

  // ---- Terminal and between-sessions screens ------------------------------

  if (phase === "left") {
    return (
      <Centered title={isCall ? "You left the call" : "You've left"}>
        {isCall && rejoinUntil && (
          <p className="-mt-2 mb-4 text-sm text-ink-soft">
            You can rejoin until <LocalTime value={rejoinUntil} mode="time" />.
          </p>
        )}
        {!isCall && webinar && !endedAt && (
          <p className="-mt-2 mb-4 text-sm text-ink-soft">
            The webinar is still running.
          </p>
        )}
        {recordingNote}
        <div className="flex flex-wrap justify-center gap-2">
          <Button onClick={() => rejoin({ endedAt })}>Rejoin</Button>
          <ButtonLink variant="secondary" href={backHref}>
            Back
          </ButtonLink>
        </div>
      </Centered>
    );
  }

  if (phase === "ended") {
    if (isCall) {
      return (
        <Centered title="The call has ended">
          <p className="-mt-2 mb-4 text-sm text-ink-soft">
            {endedByMe
              ? "You ended the call for both of you."
              : "This call is over."}
          </p>
          <ButtonLink variant="secondary" href={backHref}>
            Back
          </ButtonLink>
        </Centered>
      );
    }
    if (!isHost) {
      return (
        <ViewerEnded
          endedAt={endedAt}
          backHref={backHref}
          refresh={refreshPremiere}
          onRejoin={() => rejoin({ endedAt: null })}
        />
      );
    }
    return (
      <HostEnded
        endedByMe={endedByMe}
        endedAt={endedAt}
        backHref={backHref}
        recordingNote={recordingNote}
        onReopen={isStaffHost && webinar ? webinar.onReopenLive : null}
        onReopened={() => rejoin({ endedAt: null })}
      />
    );
  }

  if (phase === "closed") {
    return (
      <Centered title={closedTitle(closedReason, isCall)}>
        <p className="-mt-2 mb-4 text-sm text-ink-soft">
          {closedDetail(closedReason, isCall)}
        </p>
        {recordingNote}
        <ButtonLink variant="secondary" href={backHref}>
          Back
        </ButtonLink>
      </Centered>
    );
  }

  if (phase === "prejoin") {
    // A host arriving after End. Pressing Start never reopens a webinar —
    // staff get an explicit "Reopen and go live", with the camera left off
    // until they choose it; anyone else is told it is over.
    if (isHost && webinar && endedAt) {
      const endedLine = (
        <>
          This webinar was ended at <LocalTime value={endedAt} mode="time" />.
        </>
      );
      return (
        <PreJoin
          title={title}
          subtitle={
            isStaffHost
              ? "Reopening lets the audience back in and puts you on air."
              : "Only staff can reopen it."
          }
          notice={endedLine}
          role={role}
          selfLabel="host"
          autoStartMedia={false}
          onJoin={reopenAndJoin}
          joinLabel={isStaffHost ? "Reopen and go live" : undefined}
          hideJoin={!isStaffHost}
          busy={joinBusy}
          joinError={joinError}
          backHref={backHref}
        />
      );
    }
    return (
      <PreJoin
        title={title}
        subtitle={prejoinCopy({
          isCall,
          isHost,
          isStaffHost,
          inPremiere,
          otherName: call?.otherName ?? null,
          isWebinar: !!(webinar || qa),
        })}
        role={role}
        selfLabel={isCall ? null : "host"}
        onJoin={onJoin}
        // "Start" for a webinar host is kept as-is (scripts/webinar-e2e.mts
        // clicks it by name); the subtitle carries the co-host / premiere /
        // guest-speaker nuance instead.
        joinLabel={isCall ? "Join call" : isHost ? "Start" : "Join"}
        backHref={backHref}
      />
    );
  }

  // ---- Live ---------------------------------------------------------------

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
  // for. Never after End: a recording that kept playing under "Ended" was a bug.
  const premiereShowing =
    !!webinar?.premiere && premierePhase === "playing" && !isHost && !endedAt;
  const panel = webinar ?? qa;

  // What a host sees of the other broadcasters. In a 1:1 the other person is
  // always accounted for — waiting, here, reconnecting or left — so there is
  // never a ghost camera-off tile for someone who is not there. In a webinar a
  // co-host who left simply drops out.
  const hostTiles: RemotePeer[] = isCall
    ? broadcasters.length > 0
      ? broadcasters
      : [
          {
            peerId: "pending",
            name: call?.otherName ?? "them",
            role: "host",
            state: "connecting",
            seenLive: false,
            streams: {},
          },
        ]
    : broadcasters.filter((p) => p.state !== "left");

  const saving =
    recorder.state === "uploading" || recorder.state === "recording";
  const busyNote = leaving
    ? saving
      ? "Saving the recording before you leave…"
      : "Leaving…"
    : ending
      ? saving
        ? "Saving the recording…"
        : "Ending…"
      : endPending
        ? "Ending…"
        : null;

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
          {recorder.state === "recording" && (
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
            {isCall ? "In call" : isHost ? "Hosting" : "Watching"}
          </span>
        </div>
      </header>

      {session.error && !session.joinFailed && (
        <div className="mb-3 flex items-start gap-2.5 rounded-xl border border-amber-500/40 bg-amber-400/10 p-3">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
          <p className="text-xs text-ink-soft">{session.error}</p>
        </div>
      )}

      <div className="flex flex-col gap-3 lg:flex-row">
        <div className="min-w-0 flex-1 space-y-3">
          {isHost && session.joinFailed ? (
            <JoinFailedCard
              message={session.error}
              onRetry={() => rejoin({ endedAt })}
              backHref={backHref}
            />
          ) : isHost ? (
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
                      label={isCall ? undefined : "host"}
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
                  label={isCall ? undefined : "host"}
                  cameraOn={media.cameraOn}
                  micOn={media.micOn}
                  mirrored
                  muted
                  className="w-full"
                />
              )}

              {/* Other broadcasters — a co-host, or the other party in a 1:1.
                  Never the audience. */}
              {hostTiles.length > 0 && (
                <div className="grid gap-3 sm:grid-cols-2">
                  {hostTiles.map((p) => (
                    <RemoteTile
                      key={p.peerId}
                      peer={p}
                      isCall={isCall}
                      rejoinUntil={rejoinUntil}
                    />
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
              onRecordingFinished={() => pollNow.current()}
              onLeave={hangUp}
            />
          ) : (
            <ViewerStage
              peers={broadcasters}
              starting={premierePhase === "waiting"}
              joinFailed={!!session.joinFailed}
              failedMessage={session.error}
              onRetry={() => rejoin({ endedAt })}
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
              // QAPanel was built around. The ended state is OURS, passed in;
              // the panel reports what the server tells it and never keeps a
              // second copy (two copies is how a Reopen used to leave an
              // "ended" banner up in one half of the room).
              <RoomPanel
                eventId={webinar.eventId}
                isModerator={isHost}
                audienceMode={webinar.audienceMode}
                initial={webinar.initialRoomState}
                roomTopic={session.roomTopic}
                moderationTopic={session.moderationTopic}
                liveEndedAt={endedAt}
                onServerState={(s) => {
                  if (s.liveEndedAt) setEndedAt(s.liveEndedAt);
                  setCanEnd(s.canEnd);
                }}
                onStageChange={onStageChange}
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
          // Leave, for everyone. A host who may end ALSO gets End beside it —
          // the two are deliberately different buttons rather than one that
          // guesses, because stepping out and the webinar finishing are
          // different intentions and only one of them is easy to undo.
          onLeave={hangUp}
          canBroadcast={isHost && !inPremiere}
        />

        {isHost && webinar && inPremiere && !endedAt && (
          <Button onClick={goLiveNow} disabled={ending}>
            Go live now
          </Button>
        )}

        {/* The one End for everyone. Staff only in the bar (a guest speaker
            reaches it only through the last-broadcaster Leave prompt), shown
            during a premiere too, and two-step — it ends the session for
            everyone watching, so it must not be one mis-aimed click. */}
        {isStaffHost && webinar && canEnd && !endedAt && (
          <ArmButton
            label="End for everyone"
            confirmLabel="Confirm end"
            warning="This ends the webinar for everyone watching."
            busy={endPending || ending}
            busyLabel={busyNote ?? "Ending…"}
            onConfirm={() => void endWebinar()}
          />
        )}

        {isCall && call?.isOwner && (
          <ArmButton
            label="End call"
            confirmLabel="End for both"
            warning={`This ends the call for you and ${call.otherName}.`}
            busy={endPending || ending}
            busyLabel="Ending…"
            onConfirm={() => void endCallNow()}
          />
        )}
      </div>

      {leavePrompt && (
        <LeavePrompt
          canEnd={canEnd}
          busy={endPending || ending || leaving}
          onEnd={() => void endWebinar()}
          onLeave={() => void leaveNow()}
          onCancel={() => setLeavePrompt(false)}
        />
      )}

      {busyNote && (
        <p
          className="mt-2 text-center text-xs text-ink-soft"
          role="status"
          aria-live="polite"
        >
          {busyNote}
        </p>
      )}

      {endError && (
        <div className="mx-auto mt-2 flex max-w-md items-center justify-center gap-2 text-xs text-amber-600 dark:text-amber-400">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
          <span>{endError}</span>
        </div>
      )}

      {/* The recorder speaks up only when something is wrong or still in
          flight. A host closing the tab on "Saving the recording…" is how the
          last segment gets lost, so it is said out loud rather than left to a
          spinner nobody reads. */}
      {isHost && recorder.error && (
        <p className="mt-2 text-center text-xs text-amber-600 dark:text-amber-400">
          {recorder.error}
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Copy
// ---------------------------------------------------------------------------

function prejoinCopy({
  isCall,
  isHost,
  isStaffHost,
  inPremiere,
  otherName,
  isWebinar,
}: {
  isCall: boolean;
  isHost: boolean;
  isStaffHost: boolean;
  inPremiere: boolean;
  otherName: string | null;
  isWebinar: boolean;
}): string {
  // Both parties to a 1:1 broadcast, so the student invitee used to be told
  // "You're the host". Neither of them is hosting an audience; it is a call.
  if (isCall) {
    return `It's just you and ${otherName ?? "them"} — your camera and mic will be on.`;
  }
  if (isHost && inPremiere) {
    return "This is a premiere: the recording plays first. You go on air when it hands over — or when you press Go live now — and your camera stays off until then.";
  }
  if (isHost) {
    return isStaffHost
      ? "You're hosting — your camera and mic will be live."
      : "You're a guest speaker — your camera and mic will be live.";
  }
  return isWebinar
    ? "Your camera and mic stay off, and nobody can see who else is here. You can ask questions beside the video."
    : "You'll be able to watch and listen.";
}

function closedTitle(reason: CloseReason | null, isCall: boolean): string {
  switch (reason) {
    case "cancelled":
      return isCall ? "This call was cancelled" : "This webinar was cancelled";
    case "revoked":
      return "You no longer have access to this room";
    default:
      return isCall ? "This call's time is up" : "This webinar is over";
  }
}

function closedDetail(reason: CloseReason | null, isCall: boolean): string {
  switch (reason) {
    case "cancelled":
      return "There's nothing to join any more.";
    case "revoked":
      return "If you think that's a mistake, ask the person who invited you.";
    default:
      return isCall
        ? "The window for this call has closed."
        : "The host has left and the room has closed.";
  }
}

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------

/**
 * A two-step destructive button: press to arm, press again to confirm.
 *
 * Two-step rather than a dialog, for two reasons: it ends the session for
 * other people, so it must not be a single mis-aimed click mid-talk; and there
 * is no Dialog-on-top-of-a-live-room pattern in this tree worth inventing
 * here, where the host is mid-sentence on camera. The armed state releases
 * itself after a few seconds, so an abandoned press does not leave a red
 * button armed for the rest of the webinar.
 */
function ArmButton({
  label,
  confirmLabel,
  warning,
  busy,
  busyLabel,
  onConfirm,
}: {
  label: string;
  confirmLabel: string;
  warning: string;
  busy: boolean;
  busyLabel: string;
  onConfirm: () => void;
}) {
  const [armed, setArmed] = useState(false);
  const disarm = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (disarm.current) clearTimeout(disarm.current);
    },
    [],
  );

  if (busy) {
    return (
      <Button variant="danger" disabled>
        <Loader2 className="h-4 w-4 animate-spin" />
        {busyLabel}
      </Button>
    );
  }
  if (!armed) {
    return (
      <Button
        variant="danger"
        onClick={() => {
          setArmed(true);
          if (disarm.current) clearTimeout(disarm.current);
          disarm.current = setTimeout(() => setArmed(false), 5000);
        }}
      >
        <PhoneOff className="h-4 w-4" />
        {label}
      </Button>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-xs text-ink-soft">{warning}</span>
      <Button variant="ghost" size="sm" onClick={() => setArmed(false)}>
        Cancel
      </Button>
      <Button
        variant="danger"
        size="sm"
        onClick={() => {
          setArmed(false);
          onConfirm();
        }}
      >
        {confirmLabel}
      </Button>
    </div>
  );
}

/**
 * The last broadcaster on air pressed Leave. Three choices, because "leave"
 * alone cannot say which of two very different things they meant.
 */
function LeavePrompt({
  canEnd,
  busy,
  onEnd,
  onLeave,
  onCancel,
}: {
  canEnd: boolean;
  busy: boolean;
  onEnd: () => void;
  onLeave: () => void;
  onCancel: () => void;
}) {
  return (
    <div
      role="dialog"
      aria-label="Leave the webinar"
      className="mx-auto mt-3 max-w-lg rounded-xl border border-line bg-wash p-4 text-center"
    >
      <p className="text-sm font-medium text-ink">
        You&rsquo;re the only one on air.
      </p>
      <p className="mt-1 text-xs text-ink-soft">
        {canEnd
          ? "End the webinar for everyone, or step out and keep the room open — viewers will see that the host stepped away and reconnect when someone is back on air."
          : "A staff host is in the room and will close it. If you step out, viewers will see that the host stepped away until someone is back on air."}
      </p>
      <div className="mt-3 flex flex-wrap justify-center gap-2">
        {canEnd && (
          <Button variant="danger" size="sm" onClick={onEnd} disabled={busy}>
            End for everyone
          </Button>
        )}
        <Button variant="secondary" size="sm" onClick={onLeave} disabled={busy}>
          Leave — keep the room open
        </Button>
        <Button variant="ghost" size="sm" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

/** The recorder's state, said plainly on the screens a host lands on. */
function RecordingStatus({
  state,
  uploaded,
  error,
}: {
  state: string;
  uploaded: number;
  error: string | null;
}) {
  if (state === "uploading" || state === "recording") {
    return (
      <p className="mb-4 inline-flex items-center gap-2 text-sm text-ink-soft">
        <Loader2 className="h-4 w-4 animate-spin" />
        Saving the recording — keep this tab open.
      </p>
    );
  }
  if (uploaded === 0 && !error) return null;
  return (
    <div className="mb-4 space-y-1 text-sm">
      {uploaded > 0 && (
        <p className="text-ink-soft">
          Recording saved ({uploaded} segment{uploaded === 1 ? "" : "s"} this
          session).
        </p>
      )}
      {error && <p className="text-amber-600 dark:text-amber-400">{error}</p>}
    </div>
  );
}

/** The host's ended screen: what happened, the recording, Reopen for staff. */
function HostEnded({
  endedByMe,
  endedAt,
  backHref,
  recordingNote,
  onReopen,
  onReopened,
}: {
  endedByMe: boolean;
  endedAt: string | null;
  backHref: string;
  recordingNote: React.ReactNode;
  /** Staff only; null hides the button. */
  onReopen: (() => Promise<void>) | null;
  onReopened: () => void;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <Centered
      title={
        endedByMe ? "You ended the webinar for everyone" : "The webinar was ended"
      }
    >
      {endedAt && (
        <p className="-mt-2 mb-4 text-sm text-ink-soft">
          Ended at <LocalTime value={endedAt} mode="time" />.
        </p>
      )}
      {recordingNote}
      {error && (
        <p className="mb-3 text-xs text-amber-600 dark:text-amber-400">{error}</p>
      )}
      <div className="flex flex-wrap justify-center gap-2">
        {onReopen && (
          <Button
            variant="secondary"
            disabled={pending}
            onClick={async () => {
              setPending(true);
              setError(null);
              try {
                await onReopen();
                onReopened();
              } catch (err) {
                setError(getActionError(err, "Couldn't reopen the webinar."));
                setPending(false);
              }
            }}
          >
            {pending ? "Reopening…" : "Reopen"}
          </Button>
        )}
        <ButtonLink variant="secondary" href={backHref}>
          Back
        </ButtonLink>
      </div>
    </Centered>
  );
}

/**
 * A viewer's ended screen. Terminal — no media, no Rejoin — unless staff
 * reopen the webinar, which a slow poll (every 30s, paused while the tab is
 * hidden) notices and answers with a Rejoin button. Nothing reconnects them
 * automatically.
 */
function ViewerEnded({
  endedAt,
  backHref,
  refresh,
  onRejoin,
}: {
  endedAt: string | null;
  backHref: string;
  refresh: WebinarRoom["refreshPremiere"] | undefined;
  onRejoin: () => void;
}) {
  const [reopened, setReopened] = useState(false);
  useEffect(() => {
    if (!refresh || reopened) return;
    let stopped = false;
    const tick = async () => {
      if (document.hidden) return;
      try {
        const next = await refresh();
        if (stopped) return;
        // Null: the room is gone for us (past the hard stop, or no access).
        if (!next) {
          stopped = true;
          clearInterval(timer);
          return;
        }
        if (!next.liveEndedAt) setReopened(true);
      } catch {
        /* the next tick will try again */
      }
    };
    const timer = setInterval(tick, 30_000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [refresh, reopened]);

  return (
    <Centered title={reopened ? "The webinar was reopened" : "This webinar has ended"}>
      {!reopened && endedAt && (
        <p className="-mt-2 mb-4 text-sm text-ink-soft">
          It ended at <LocalTime value={endedAt} mode="time" />. Thanks for
          watching.
        </p>
      )}
      <div className="flex flex-wrap justify-center gap-2">
        {reopened && <Button onClick={onRejoin}>Rejoin</Button>}
        <ButtonLink variant="secondary" href={backHref}>
          Back
        </ButtonLink>
      </div>
    </Centered>
  );
}

function JoinFailedCard({
  message,
  onRetry,
  backHref,
}: {
  message: string | null;
  onRetry: () => void;
  backHref: string;
}) {
  return (
    <div className="grid aspect-video w-full place-items-center rounded-xl border border-line bg-ink-900">
      <div className="px-6 text-center">
        <AlertTriangle className="mx-auto h-6 w-6 text-amber-400" />
        <p className="mt-3 text-sm font-medium text-[#fff]">
          Couldn&rsquo;t join this room
        </p>
        {message && <p className="mt-1 text-xs text-[#fff]/60">{message}</p>}
        <div className="mt-4 flex flex-wrap justify-center gap-2">
          <Button size="sm" onClick={onRetry}>
            Try again
          </Button>
          <ButtonLink size="sm" variant="secondary" href={backHref}>
            Back
          </ButtonLink>
        </div>
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
 *
 * The placeholder copy is honest about which of four situations this is: the
 * join failed (Retry — it will not fix itself), the webinar has not started,
 * a host was here and stepped away (they will reconnect automatically when
 * someone is back on air), or the link to the host is recovering.
 */
function ViewerStage({
  peers,
  starting,
  joinFailed,
  failedMessage,
  onRetry,
}: {
  peers: RemotePeer[];
  /** A premiere that has not begun: "Starting shortly". */
  starting: boolean;
  joinFailed: boolean;
  failedMessage: string | null;
  onRetry: () => void;
}) {
  // Who is actually on air for us right now. A peer who left, or a link still
  // coming up, is not someone to put in the big frame.
  const onAir = peers.filter(
    (p) => p.state === "live" || p.state === "reconnecting",
  );
  // Once any host has been live, silence means "stepped away", not "hasn't
  // started" — that difference is what the audience most needs told.
  const hadHost = useRef(false);
  if (peers.some((p) => p.seenLive || p.state === "live")) hadHost.current = true;

  // Who gets the big frame. Presenting wins — slides are the thing being
  // discussed, and a talking head beside them is the sideshow — and otherwise
  // it is simply the first broadcaster who actually has a picture.
  const presenting = onAir.find((p) => p.streams.screen);
  const primary =
    presenting ?? onAir.find((p) => p.streams.camera) ?? onAir[0] ?? null;
  const others = onAir.filter((p) => p.peerId !== primary?.peerId);
  const connected = !!primary && primary.state === "live";
  const reconnecting = !!primary && primary.state === "reconnecting";
  const screen = primary?.streams.screen ?? null;
  const camera = primary?.streams.camera ?? null;

  // EVERY on-air broadcaster's audio is mounted, always, including the ones
  // whose video is a thumbnail and the one whose camera is off entirely. Audio
  // rides its own transceiver, so tying it to whichever video element happens
  // to be on screen is how a guest speaker becomes inaudible the moment the
  // host starts presenting — and how a host talking with their camera off
  // silences the whole webinar.
  const audio = (
    <>
      {onAir.map((p) => (
        <AudioSink key={p.peerId} stream={p.streams.audio ?? null} />
      ))}
    </>
  );

  if (joinFailed) {
    return (
      <div className="grid aspect-video w-full place-items-center rounded-xl border border-line bg-ink-900">
        <div className="px-6 text-center">
          <AlertTriangle className="mx-auto h-6 w-6 text-amber-400" />
          <p className="mt-3 text-sm font-medium text-[#fff]">
            Couldn&rsquo;t join this room
          </p>
          <p className="mt-1 text-xs text-[#fff]/60">
            {failedMessage ?? "Something went wrong connecting."}
          </p>
          <div className="mt-4">
            <Button size="sm" onClick={onRetry}>
              Try again
            </Button>
          </div>
        </div>
      </div>
    );
  }

  if (!camera && !screen) {
    const [headline, detail] = connected
      ? [
          "The host's camera is off",
          "You'll hear them, and see them as soon as they turn it on.",
        ]
      : reconnecting
        ? ["Reconnecting to the host…", "This usually takes a few seconds."]
        : hadHost.current
          ? [
              "The host stepped away",
              "You'll reconnect automatically when they're back — no need to refresh.",
            ]
          : starting
            ? ["Starting shortly", "You'll join automatically — no need to refresh."]
            : [
                "Waiting for the host to start",
                "You'll join automatically — no need to refresh.",
              ];
    return (
      <>
        {audio}
        <div className="grid aspect-video w-full place-items-center rounded-xl border border-line bg-ink-900">
          <div className="px-6 text-center">
            {!connected && (
              <Loader2 className="mx-auto h-6 w-6 animate-spin text-ink-faint" />
            )}
            <p className="mt-3 text-sm font-medium text-[#fff]">{headline}</p>
            <p className="mt-1 text-xs text-[#fff]/60">{detail}</p>
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      {audio}
      <div className="relative">
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
        {/* The link dropped. Say so over the last frame rather than letting a
            frozen picture pass for a live one. */}
        {reconnecting && <ReconnectingOverlay />}
      </div>

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

function ReconnectingOverlay() {
  return (
    <div className="pointer-events-none absolute inset-0 grid place-items-center rounded-xl bg-ink-900/60">
      <p className="inline-flex items-center gap-2 text-sm font-medium text-[#fff]">
        <Loader2 className="h-4 w-4 animate-spin" />
        Reconnecting…
      </p>
    </div>
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

/**
 * Another broadcaster, as a host sees them — a co-host, or the other person
 * in a 1:1.
 *
 * Only a LIVE (or recovering) connection gets a video tile. Anything else is
 * said in words: waiting for them to arrive, or that they left and until when
 * they can come back. A connection that is merely being dialled used to be
 * drawn as a "camera off" tile, which told the first person into a 1:1 that
 * the other was already there — and, after they left, that they still were.
 */
function RemoteTile({
  peer,
  isCall,
  rejoinUntil,
}: {
  peer: RemotePeer;
  isCall: boolean;
  rejoinUntil: string | null;
}) {
  if (peer.state === "left") {
    return (
      <PeerNotice
        title={isCall ? `${peer.name} left the call` : `${peer.name} left`}
        detail={
          isCall && rejoinUntil ? (
            <>
              They can rejoin until <LocalTime value={rejoinUntil} mode="time" />.
            </>
          ) : null
        }
      />
    );
  }
  if (peer.state !== "live" && peer.state !== "reconnecting") {
    return (
      <PeerNotice
        spinner
        title={
          peer.seenLive
            ? `Reconnecting to ${peer.name}…`
            : isCall
              ? `Waiting for ${peer.name} to join`
              : `Connecting to ${peer.name}…`
        }
        detail={
          isCall && !peer.seenLive
            ? "They'll appear here as soon as they're in."
            : null
        }
      />
    );
  }

  // `screen` is only ever present while the peer is genuinely presenting —
  // the engine drops a slot whose track is muted, so this no longer picks an
  // empty screen transceiver over a live camera.
  const screen = peer.streams.screen ?? null;
  const camera = peer.streams.camera ?? null;
  return (
    <div className="relative">
      <AudioSink stream={peer.streams.audio ?? null} />
      <VideoTile
        stream={screen ?? camera}
        name={peer.name}
        label={screen ? "presenting" : undefined}
        cameraOn={!!(screen ?? camera)}
        micOn={!!peer.streams.audio}
        muted
      />
      {peer.state === "reconnecting" && <ReconnectingOverlay />}
    </div>
  );
}

function PeerNotice({
  title,
  detail,
  spinner = false,
}: {
  title: string;
  detail?: React.ReactNode;
  spinner?: boolean;
}) {
  return (
    <div className="grid aspect-video w-full place-items-center rounded-xl border border-line bg-ink-900">
      <div className="px-6 text-center">
        {spinner && (
          <Loader2 className="mx-auto h-5 w-5 animate-spin text-ink-faint" />
        )}
        <p className="mt-2 text-sm font-medium text-[#fff]">{title}</p>
        {detail && <p className="mt-1 text-xs text-[#fff]/60">{detail}</p>}
      </div>
    </div>
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

/** A 1:1 has no event to attach a recording to, and never records. */
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
