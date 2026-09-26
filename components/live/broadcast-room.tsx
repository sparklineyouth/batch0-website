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
import {
  useLiveSession,
  type CloseReason,
  type RemotePeer,
} from "@/components/live/use-live-session";
import {
  useRecorder,
  type RecorderRemote,
} from "@/components/live/use-recorder";
import { SpeakerStrip } from "@/components/live/speaker-strip";
import { Button, ButtonLink } from "@/components/ui/button";
import { LocalTime } from "@/components/ui/local-time";
import { getActionError } from "@/lib/action-error";
import {
  headcountLabel,
  JOIN_CLOSES_MINUTES_AFTER,
  roomWindow,
  type LiveRole,
  type WebinarQuestion,
} from "@/lib/live";
import type { LivePeer } from "@/lib/live-rooms";
import type { SignalRole } from "@/lib/live-signal";
import {
  electRecorder,
  presentForRecording,
  RECORDER_LEASE_MS,
  RECORDER_RECONNECT_GRACE_MS,
  RECORDER_SETTLE_MS,
  type AudienceMode,
  type EventSpeaker,
  type PremiereState,
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
 *   Leave        "I go; the room keeps running." Off air at once, capture this
 *                tab's final recording segment, stop the devices, "You've
 *                left" with a Rejoin that really rejoins. The last broadcaster
 *                on air in a webinar is asked first — End for everyone, or
 *                Leave and keep the room open — because a sole host who simply
 *                leaves strands the audience on "the host stepped away".
 *   End          Webinar: staff (and a guest speaker only when no staff host
 *                is present) end it for EVERYONE — the server stamps it, every
 *                other client hears `room-changed` and closes, and this tab
 *                lands on an ended screen with Reopen for staff. 1:1: either
 *                person can End call once both have been in the room and the
 *                start has come (`finishCall`); the other side's room notices
 *                on its status poll (or its heartbeat) and closes too.
 *
 * Whichever way the room ends — this tab's End, another host's, a heartbeat
 * saying 'ended', the stage hint, the 8s poll — the teardown is the same and
 * in the same order. The session goes down the moment the exit is committed
 * (bye to every peer: the host is off air now, not after anything uploads).
 * Then the recorder's final segment is CAPTURED — milliseconds, bounded — and
 * only then are screen/camera/mic stopped, so the file is not cut mid-frame.
 * Then the phase changes. The final upload finishes in the background on the
 * left/ended screen, which says "keep this tab open" and guards the tab until
 * it lands. A webinar End that fails tears nothing down: the host stays live
 * with the error and can retry.
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

/**
 * `left` is this person stepping out — the room carries on and they can
 * rejoin. `ended` is the room being over: a webinar ended for everyone, or a
 * 1:1 whose End call was pressed, that was cancelled, or whose window closed.
 * `closed` is a webinar the server closed for another reason (the window ran
 * out with no host, access revoked) — see closedTitle.
 */
type Phase = "prejoin" | "live" | "left" | "ended" | "closed";

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
  /** Their name, for their own tile if their browser is the one recording. */
  selfName: string;
  /**
   * The schedule, as the server rendered it (`endsAt` null means the default
   * length — see roomWindow). A viewer's stage uses the start to stop saying
   * "waiting for the host to start" once it has started, and the ended screen
   * uses the hard stop to know when to stop watching for a Reopen.
   */
  startsAt: string;
  endsAt: string | null;
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
  /**
   * File one recording segment. `run` is the recording run it belongs to —
   * when this room (and so its recorder) mounted. `useRecorder` numbers
   * segments from zero on every mount, so an index alone cannot say whether
   * segment 2 belongs after segment 1 or is the start of a reload twenty
   * minutes later; the run goes into every segment's name, and the server lays
   * each run out as its own block (recordingSegmentSlot in lib/webinars.ts).
   * Per MOUNT rather than per page load, because Rejoin and Reopen remount the
   * room — a fresh recorder counting from zero again — without a page load.
   */
  onSegment: (
    blob: Blob,
    index: number,
    seconds: number,
    run: number,
  ) => Promise<SegmentOutcome>;
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
 * Everything that makes this room a 1:1 CALL, as `WebinarRoom` is for a
 * webinar — one all-or-nothing bundle, for the same reason.
 *
 * Both parties broadcast (signal role `host`), so the role cannot say whose
 * browser records; `isRecorder` does.
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
  /** Scheduled end. Rejoining stays possible until the window closes after it. */
  endsAt: string;
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
  // useLocalMedia) — the teardown below does, once the recorder has captured
  // its final segment.
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

  // This tab is on its way out: Leave committed (`leaving`), or the room is
  // ending under it — this tab's End succeeded, or the server / another host
  // ended or closed it (`ending`). Not set while a WEBINAR End request is
  // merely in flight: if the server refuses, the host is still live and still
  // on air. A 1:1's End call sets it from the press — that side leaves the
  // room whatever the server answers (see `finishCall`).
  const [ending, setEnding] = useState(false);
  const [leaving, setLeaving] = useState(false);

  // Off air the moment the exit is committed, not when the phase changes.
  // The phase waits for the recorder to capture its final segment (see
  // `finish`), and gating the session on the phase alone kept the host's
  // camera and mic on every viewer's screen for that whole wait — which,
  // when it was the final segment's UPLOAD, was minutes. Disabling it here
  // sends `bye` to every peer at once; the local tracks keep running only
  // for the recorder, and stop a moment later.
  const session = useLiveSession({
    kind,
    roomId,
    role: isHost ? "host" : "viewer",
    enabled: phase === "live" && !leaving && !ending,
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
  // optimisation but the difference between losing two minutes and losing an
  // hour.
  //
  // Gated on `!inPremiere` as well as on the host: a premiere is already a
  // recording, and re-recording the Q&A over the top of it would produce a
  // second asset that starts forty minutes in and looks like a truncated
  // duplicate. And never once this tab is on its way out (`leaving`,
  // `ending`) — the gate closing is the flush.
  //
  // A 1:1 records always, from the host's side only (`call.isRecorder`), and
  // hands the recorder the other person too — their tile and their voice —
  // because half a conversation is not a record of it. A webinar's recorder is
  // handed every co-host on stage for the same reason (see below, and the
  // header of use-recorder.ts).
  //
  // Both kinds wait for the camera and mic to SETTLE (granted, refused, or
  // missing) before starting. Starting while the permission prompt is still up
  // records a first segment with no microphone in it, which the solo recorder
  // then has to rotate away from a second later, leaving a one-second file at
  // the head of every recording.
  const mediaSettled = media.status !== "idle" && media.status !== "requesting";

  // ---- Who records a webinar ---------------------------------------------
  //
  // Exactly one browser in the room, and it records the WHOLE STAGE — every
  // live co-host's camera, screen share and voice, composited and mixed with
  // its own (`recorderRemotes` below) — so which browser it is changes
  // nothing about what is in the recording. Every host, staff and guest
  // speakers alike, runs this component; left to itself every host's tab
  // recorded, and the event's recording came out as the stage twice over,
  // interleaved a segment at a time. So each host's browser works out, from
  // the co-hosts it can see, which ONE of them records (electRecorder: the
  // lowest user id present), and only that one does. A peer's id is its user
  // id, the one fact every browser holds identically, so they agree without
  // talking to each other. When the recorder leaves, the next in line sees it
  // go and takes over; when a host with a lower id arrives, the recorder sees
  // them and stands down, flushing what it has. A co-host who pressed Leave is
  // "left" to the engine, and never counts.
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

  // A co-host whose connection DROPPED counts as present for
  // RECORDER_RECONNECT_GRACE_MS and then stops counting, so one who vanished
  // without a goodbye cannot stay the elected recorder while recording
  // nothing. Nothing re-renders this component when that moment passes, so
  // wake it then. Only future deadlines are scheduled: a peer already past
  // its grace has been counted out, and needs no further tick.
  const [graceClock, setGraceClock] = useState(0);
  useEffect(() => {
    if (!webinar || !isHost) return;
    const now = Date.now();
    let next = Infinity;
    for (const p of session.remotes) {
      if (p.role !== "host" || p.state !== "reconnecting" || p.downSince === null) {
        continue;
      }
      const due = p.downSince + RECORDER_RECONNECT_GRACE_MS;
      if (due > now) next = Math.min(next, due);
    }
    if (next === Infinity) return;
    const t = setTimeout(() => setGraceClock(Date.now()), next - now + 250);
    return () => clearTimeout(t);
  }, [webinar, isHost, session.remotes, graceClock]);

  const selfUserId = webinar?.selfUserId ?? "";
  const recorderId = useMemo(() => {
    if (!webinar || !isHost || !session.joined) return null;
    const now = Date.now();
    const present = [selfUserId];
    for (const p of session.remotes) {
      if (p.role !== "host") continue;
      const downFor = p.downSince === null ? 0 : now - p.downSince;
      if (!presentForRecording(p.state, settling, downFor)) continue;
      present.push(p.peerId);
    }
    return electRecorder(present);
    // `graceClock` is read by nothing here; it is what re-runs this when a
    // dropped co-host's grace runs out.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [webinar, isHost, session.joined, session.remotes, settling, selfUserId, graceClock]);

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
  // This mount's recording run (see WebinarRoom's onSegment). A ref, not
  // state: it must never change for the life of the mount, and nothing
  // renders it.
  const recordingRun = useRef(Date.now());
  const onWebinarSegment = useCallback(
    async (blob: Blob, index: number, seconds: number) => {
      if (!webinarSegment) return;
      const outcome = await webinarSegment(blob, index, seconds, recordingRun.current);
      if (outcome === "refused") {
        setStandDownUntil(Date.now() + RECORDER_LEASE_MS);
      }
    },
    [webinarSegment],
  );

  // Not once the webinar has been ENDED, either — by this host or a co-host.
  // The gate closing flushes what was recorded; a host lingering in an ended
  // room is not more talk.
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
  // Who else goes into the recording. A webinar hands over every co-host whose
  // connection is live — ALWAYS an array, empty when this host is alone, so
  // the recorder starts in its stage mode (fixed at start) and a co-host who
  // arrives later is one more tile rather than someone the file leaves out.
  // Staff moderator intro, guest speaker's slides, panel of three: the elected
  // recorder's file has all of them, whoever's laptop it is.
  const recorderRemotes = useMemo<RecorderRemote[] | undefined>(() => {
    if (webinar) {
      return session.remotes
        .filter((p) => p.role === "host" && p.state === "live")
        .map((p) => ({
          id: p.peerId,
          name: p.name || "Speaker",
          camera: p.streams.camera ?? null,
          screen: p.streams.screen ?? null,
          audio: p.streams.audio ?? null,
          connected: true,
        }));
    }
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
  }, [webinar, call, session.remotes]);
  const recorder = useRecorder({
    eventId: webinar?.eventId ?? roomId,
    enabled:
      (recordWebinar || recordCall) &&
      phase === "live" &&
      mediaSettled &&
      !ending &&
      !leaving,
    cameraStream: media.stream,
    screenStream: screen.stream,
    micStream: media.stream,
    cameraOn: media.cameraOn,
    micOn: media.micOn,
    onSegment: webinar ? onWebinarSegment : call?.onSegment ?? noopSegment,
    remotes: recorderRemotes,
    localName: call?.selfName ?? webinar?.selfName,
    subject: call ? "call" : "webinar",
  });

  const onJoin = useCallback((opts: { cameraOn: boolean; micOn: boolean }) => {
    wanted.current = opts;
    // A fresh stream, and the green room's toggles apply to it.
    applied.current = false;
    setPhase("live");
  }, []);

  // ---- Teardown -----------------------------------------------------------

  /**
   * One way out of the live phase, in the one safe order. Every caller has
   * already set `leaving` or `ending`, so the session is down (bye to every
   * peer, channels removed, leave) and the host is off air before this runs.
   *
   * Then: capture the recording's final segment (awaited — `media.stop()`
   * ends the tracks the recorder reads, so stopping them first truncates the
   * final segment, reliably the Q&A), stop screen, camera and mic, change
   * phase. `recorder.stop()` resolves on CAPTURE, in milliseconds and never
   * more than a few seconds; the upload carries on behind the left/ended
   * screen, which shows it and guards the tab. It used to resolve only once
   * the upload had landed, and with no bound on the final segment, so Leave
   * could hold a host on air — and on "Saving the recording…" — indefinitely.
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

  /**
   * Rejoin (or Reopen) from the left/ended screen — after the recording's
   * uploads, when there are any.
   *
   * A rejoin remounts the whole room, recorder included. Segments this session
   * is still uploading would carry on in the background but drop off the
   * screen and out of the unload guard, so a host who rejoined and then closed
   * the tab would lose them without a word. This is the one place anything
   * still waits for an upload, and it is bounded by the recorder's drain
   * ceiling (UPLOAD_DRAIN_TIMEOUT_MS) and skipped when nothing is on the wire.
   */
  const drainRecording = recorder.drain;
  const recorderStateRef = useRef(recorder.state);
  recorderStateRef.current = recorder.state;
  /** Waiting on the drain before a remount — the button says so. */
  const [savingBeforeRemount, setSavingBeforeRemount] = useState(false);
  const drainBeforeRemount = useCallback(async () => {
    if (recorderStateRef.current !== "uploading") return;
    setSavingBeforeRemount(true);
    try {
      await drainRecording();
    } finally {
      setSavingBeforeRemount(false);
    }
  }, [drainRecording]);
  const rejoinAfterUploads = useCallback(
    async (opts?: RejoinOptions) => {
      await drainBeforeRemount();
      rejoin(opts);
    },
    [drainBeforeRemount, rejoin],
  );
  // Reopen drains FIRST, then reopens: the audience is let back in when the
  // host is actually on the way back, not up to a drain's length before.
  const onReopenLive = webinar?.onReopenLive;
  const reopenAfterUploads = useCallback(async () => {
    if (!onReopenLive) return;
    await drainBeforeRemount();
    await onReopenLive();
  }, [drainBeforeRemount, onReopenLive]);

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
  // itself down; this stops the devices and says what happened. A 1:1 closes
  // the one way a 1:1 closes — `finishCall`, as if its status poll had said
  // the call is over, which is what the server just told the heartbeat.
  useEffect(() => {
    const closed = session.closed;
    if (!closed || phase !== "live") return;
    if (call) {
      void finishCallRef.current("elsewhere");
      return;
    }
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
  }, [session.closed, phase, call, webinar, refreshPremiere, enterEnded, enterClosed]);

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

  // Still on screen? The post-End navigation below waits on the recording's
  // uploads, and must not yank someone back who has already clicked away.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  /**
   * End a 1:1, for both people — or close this side because it already ended.
   *
   * The same teardown as every other exit (`finish`): the session goes down
   * at once, the recording's final segment is captured, the devices stop.
   * Then, for this side's own End call, the server marks the call completed
   * (only once its start has come — see endCall); the other person's room
   * learns it on its next status poll or heartbeat and closes itself, which
   * captures their recording in turn if they are the one recording.
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
   * Nothing here waits on the recording's UPLOAD — that finishes behind the
   * ended screen, which says so. Only the navigation back to the calls list
   * after this side's own End call waits for it (bounded), so the unload
   * guard is still armed while the last segment is on the wire.
   *
   * Guarded by the shared exit ref, because the poll, the heartbeat and the
   * button can all fire inside one render and the second must not run the
   * teardown twice.
   */
  const finishCall = useCallback(
    async (how: "mine" | "elsewhere") => {
      if (!call || exitingRef.current) return;
      // Nobody else has been here: this is a Leave, not an end. The button is
      // not shown in that state; this holds if something calls it anyway.
      if (how === "mine" && !peerSeenRef.current) {
        void leaveNow();
        return;
      }
      exitingRef.current = true;
      setEnding(true);
      let completed = how === "elsewhere";
      try {
        await stopRecording();
      } catch (err) {
        console.error("[live] recording flush failed", err);
      }
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
      setPhase(completed ? "ended" : "left");
      if (how === "mine") {
        await drainRecording();
        if (mountedRef.current) router.push(backHref);
      }
    },
    [backHref, call, drainRecording, leaveNow, media, router, screen, stopRecording],
  );
  const finishCallRef = useRef(finishCall);
  finishCallRef.current = finishCall;

  // A 1:1 asks the server whether it is over, because the other person
  // pressing End call and the other person's wifi dropping look identical
  // from here. Without this the remaining person — and, if they are the host,
  // their recorder — sat in the room until the window closed half an hour
  // later. (The heartbeat hears it too, as 'ended' or 'cancelled'; whichever
  // comes first closes the room, through the same finishCall.)
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

  // Only for whoever records: a webinar host (whichever browser was elected,
  // this one may have recorded a stretch), a 1:1's host.
  const recordingNote =
    (isHost && webinar) || call?.isRecorder ? (
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
          <Button
            disabled={savingBeforeRemount}
            onClick={() => void rejoinAfterUploads({ endedAt })}
          >
            {savingBeforeRemount ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                Saving the recording…
              </>
            ) : (
              "Rejoin"
            )}
          </Button>
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
        <Centered title="This call has ended">
          {call?.isRecorder &&
            (recorder.state === "uploading" || recorder.state === "recording" ? (
              // The final segment is still on the wire: End no longer waits
              // for it, so this screen is where "keep this tab open" is said.
              recordingNote
            ) : (
              <p className="mb-5 text-sm text-ink-soft">
                {recorder.error
                  ? "Part of the recording may not have saved — check it under Past."
                  : "The recording is saved with the call — you’ll find it under Past."}
              </p>
            ))}
          <ButtonLink href={backHref}>Back to your calls</ButtonLink>
        </Centered>
      );
    }
    if (!isHost) {
      return (
        <ViewerEnded
          endedAt={endedAt}
          backHref={backHref}
          refresh={refreshPremiere}
          hardCloseAt={
            webinar
              ? roomWindow(webinar.startsAt, webinar.endsAt).hardCloseAt
              : null
          }
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
        onReopen={isStaffHost && webinar ? reopenAfterUploads : null}
        savingRecording={savingBeforeRemount}
        onReopened={() => rejoin({ endedAt: null })}
      />
    );
  }

  if (phase === "closed") {
    return (
      <Centered title={closedTitle(closedReason)}>
        <p className="-mt-2 mb-4 text-sm text-ink-soft">
          {closedDetail(closedReason)}
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
          banner={endedLine}
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
        notice={call ? <CallRecordingNotice call={call} /> : undefined}
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
            downSince: null,
            streams: {},
          },
        ]
    : broadcasters.filter((p) => p.state !== "left");

  // Brief by construction: the exit waits only for the recorder to capture
  // its final segment. Any upload still running is reported on the screen
  // this lands on, not here.
  const busyNote = leaving
    ? "Leaving…"
    : ending || endPending
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
            {isCall ? "In call" : isHost ? "Hosting" : "Watching"}
          </span>
        </div>
      </header>

      {call && (
        <p className="mb-3 text-xs text-ink-faint">
          This call is recorded. Only you, {call.otherName} and batch0 admins
          can watch it back.
        </p>
      )}

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
              startsAt={webinar?.startsAt ?? null}
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

        {/* End call, for either person — once both have been here and the
            start has come (see `finishCall`). One press: Leave sits beside it
            for anyone who only means to step out. */}
        {call && peerSeen && callStarted && (
          <Button
            variant="danger"
            onClick={() => void finishCall("mine")}
            disabled={ending || leaving}
          >
            {ending ? "Ending…" : "End call"}
          </Button>
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
    return `A private 1:1 with ${otherName ?? "them"}. Your camera and mic will be on.`;
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

/**
 * The closed screen's copy. Webinars only: a 1:1 the server closes goes
 * through `finishCall` to "This call has ended", like one whose status poll
 * says it is over.
 */
function closedTitle(reason: CloseReason | null): string {
  return reason === "revoked"
    ? "You no longer have access to this room"
    : "This webinar is over";
}

function closedDetail(reason: CloseReason | null): string {
  return reason === "revoked"
    ? "If you think that's a mistake, ask the person who invited you."
    : "The host has left and the room has closed.";
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
  savingRecording,
  onReopened,
}: {
  endedByMe: boolean;
  endedAt: string | null;
  backHref: string;
  recordingNote: React.ReactNode;
  /**
   * Staff only; null hides the button. Waits for this session's recording
   * uploads (bounded) before it reopens — see rejoinAfterUploads.
   */
  onReopen: (() => Promise<void>) | null;
  /** Reopen is waiting on those uploads right now. */
  savingRecording: boolean;
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
            {pending
              ? savingRecording
                ? "Saving the recording…"
                : "Reopening…"
              : "Reopen"}
          </Button>
        )}
        <ButtonLink variant="secondary" href={backHref}>
          Back
        </ButtonLink>
      </div>
    </Centered>
  );
}

/** The ended screen's slow poll, and its pace after a null answer. */
const ENDED_POLL_MS = 30_000;
const ENDED_POLL_BACKOFF_MS = 60_000;

/**
 * A viewer's ended screen. Terminal — no media, no Rejoin — unless staff
 * reopen the webinar, which a slow poll (every 30s, paused while the tab is
 * hidden) notices and answers with a Rejoin button. Nothing reconnects them
 * automatically.
 *
 * The poll stops at the webinar's hard stop (end + 3h, from the schedule the
 * page rendered) and at nothing else. A null answer used to stop it for good,
 * but null is not "never": the server also answers null for a moment it
 * cannot place the viewer in the room — after a Reopen past end+30m, until a
 * host is back on air — and that is exactly the Reopen this screen is waiting
 * for. So a null only slows the poll down (60s); a failed read (the server
 * throws rather than answering null when it could not tell — see
 * fetchPremiereState) is retried on the next tick like any other.
 */
function ViewerEnded({
  endedAt,
  backHref,
  refresh,
  hardCloseAt,
  onRejoin,
}: {
  endedAt: string | null;
  backHref: string;
  refresh: WebinarRoom["refreshPremiere"] | undefined;
  /** Epoch ms after which nothing can reopen this webinar; null = unknown. */
  hardCloseAt: number | null;
  onRejoin: () => void;
}) {
  const [reopened, setReopened] = useState(false);
  useEffect(() => {
    if (!refresh || reopened) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const schedule = (ms: number) => {
      if (stopped) return;
      // Past the hard stop nothing can reopen it: the one reason to stop.
      if (hardCloseAt !== null && Date.now() > hardCloseAt) return;
      timer = setTimeout(tick, ms);
    };
    const tick = async () => {
      if (document.hidden) {
        schedule(ENDED_POLL_MS);
        return;
      }
      let next: Awaited<ReturnType<NonNullable<typeof refresh>>> | undefined;
      try {
        next = await refresh();
      } catch {
        // Couldn't tell — the next tick will try again.
      }
      if (stopped) return;
      if (next && !next.liveEndedAt) {
        setReopened(true);
        return;
      }
      schedule(next === null ? ENDED_POLL_BACKOFF_MS : ENDED_POLL_MS);
    };
    schedule(ENDED_POLL_MS);
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [refresh, reopened, hardCloseAt]);

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
 * The placeholder copy is honest about which situation this is: the join
 * failed (Retry — it will not fix itself), a host was here and stepped away
 * (they will reconnect automatically when someone is back on air), the link
 * to the host is recovering, a premiere has not begun, the webinar is past
 * its start with nobody on air, or it has genuinely not started yet.
 */
function ViewerStage({
  peers,
  starting,
  startsAt,
  joinFailed,
  failedMessage,
  onRetry,
}: {
  peers: RemotePeer[];
  /** A premiere that has not begun: "Starting shortly". */
  starting: boolean;
  /** The scheduled start, when this is a webinar. See `pastStart`. */
  startsAt: string | null;
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

  // `hadHost` only knows what THIS mount has seen. A viewer who refreshes (a
  // refresh goes back through the green room, by design) or joins while a
  // sole host has stepped out mounts with no peers and no history — and was
  // told "Waiting for the host to start" forty minutes into a webinar, the
  // one sentence the audience must not be told after it has started. So past
  // the scheduled start, silence gets neutral copy instead: "isn't on air
  // right now" is true whether the host stepped away or is running late.
  // Held as state and flipped by a timer, so a viewer who arrives early sees
  // the copy change at the start without anything else re-rendering.
  const startMs = startsAt ? new Date(startsAt).getTime() : NaN;
  const [pastStart, setPastStart] = useState(
    () => Number.isFinite(startMs) && Date.now() >= startMs,
  );
  useEffect(() => {
    if (pastStart || !Number.isFinite(startMs)) return;
    // Clamped: setTimeout overflows past ~24.8 days (nobody is in a room
    // that early, but an overflow would fire at once).
    const wait = Math.min(Math.max(0, startMs - Date.now()), 2_147_483_647);
    const t = setTimeout(() => setPastStart(true), wait);
    return () => clearTimeout(t);
  }, [pastStart, startMs]);

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
            : pastStart
              ? [
                  "The host isn't on air right now",
                  "You'll join automatically as soon as they are — no need to refresh.",
                ]
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
 *
 * A generation counter guards the picker, the same one useLocalMedia has for
 * the camera. `getDisplayMedia` resolves whenever the person answers the
 * browser's picker — which can be after they pressed Leave or End, or after
 * the room unmounted. Without the guard that late answer was stored as a live
 * capture on a room showing "You've left" (or on nothing at all): the
 * browser's "sharing your screen" indicator stayed on and the capture ran
 * until the tab closed. `stop()` and unmount bump the generation, and a
 * picker that resolves into a newer generation stops its tracks unseen.
 */
function useScreenShare() {
  const [stream, setStream] = useState<MediaStream | null>(null);
  const genRef = useRef(0);
  /** A picker is open; a second press must not open another. */
  const pendingRef = useRef(false);

  const stop = useCallback(() => {
    genRef.current += 1;
    setStream((s) => {
      s?.getTracks().forEach((t) => t.stop());
      return null;
    });
  }, []);

  const start = useCallback(async () => {
    if (pendingRef.current) return;
    const md = navigator.mediaDevices as MediaDevices & {
      getDisplayMedia?: (c: DisplayMediaStreamOptions) => Promise<MediaStream>;
    };
    if (!md?.getDisplayMedia) return;
    const gen = ++genRef.current;
    pendingRef.current = true;
    try {
      const s = await md.getDisplayMedia({ video: true, audio: false });
      if (gen !== genRef.current) {
        // Answered after Leave, End, a stop or an unmount: nobody wants it.
        s.getTracks().forEach((t) => t.stop());
        return;
      }
      // The browser's own stop button ends the track, not our state.
      s.getVideoTracks()[0]?.addEventListener("ended", () =>
        setStream((cur) => (cur === s ? null : cur)),
      );
      setStream(s);
    } catch {
      // Cancelling the picker is a normal outcome, not an error worth showing.
    } finally {
      // Only ever one picker in flight (see the guard above), so this start
      // owns the flag whatever happened to the generation meanwhile.
      pendingRef.current = false;
    }
  }, []);

  const toggle = useCallback(() => {
    if (stream) stop();
    else void start();
  }, [start, stop, stream]);

  useEffect(() => () => stream?.getTracks().forEach((t) => t.stop()), [stream]);
  // Unmount-only: a picker still open when the room goes away resolves into
  // a stale generation and is stopped, not stored.
  useEffect(
    () => () => {
      genRef.current += 1;
    },
    [],
  );

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
