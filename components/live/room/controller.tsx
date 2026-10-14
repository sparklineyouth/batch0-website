"use client";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { LocalTime } from "@/components/ui/local-time";
import { useLocalMedia } from "@/components/live/use-local-media";
import { useLiveSession, type CloseReason } from "@/components/live/use-live-session";
import { useRoomRecording } from "@/components/live/use-room-recording";
import { getActionError } from "@/lib/action-error";
import type { ActionResult } from "@/lib/action-result";
import { selfIsCallStaff } from "@/lib/call-roster";
import {
  isCallCounterpart,
  ROOM_HARD_CLOSE_MINUTES_AFTER,
  roomWindow,
  type LiveRole,
} from "@/lib/live";
import type { LivePeer } from "@/lib/live-rooms";
import type { SignalRole } from "@/lib/live-signal";
import { panelTabs, type WebinarPanelInitial } from "@/lib/webinar-panel";
import { audienceCanSeeEachOther } from "@/lib/webinars";
import type { JoinResult, PresenceResult } from "@/app/live/actions";
import { LiveRoom } from "./live-room";
import { WebinarPanel } from "./panel/webinar-panel";
import { ReactionsButton, ReactionsOverlay } from "./panel/reactions";
import type {
  LiveRoomProps,
  RoomBusy,
  RoomEnd,
  RoomPanelSlot,
  RoomPhase,
  RoomServerState,
} from "./types";
import { usePresentation, type EventDeck } from "./use-presentation";

/**
 * The room controller: the one place that runs a live room. It owns the phase
 * machine (prejoin → live → left / ended / closed), the devices
 * (useLocalMedia), the presentation (usePresentation), the WebRTC session
 * (useLiveSession), the recording (useRoomRecording) and every way out, and
 * renders the presentational <LiveRoom/>. The route bindings
 * (app/dashboard/{events,calls}/[id]/live/builtin-room.tsx) hand it the
 * server actions, memoised on the room id: useLiveSession treats them as
 * stable, and a new identity would tear every connection down.
 *
 * Ways out, all in one order: the session goes down the moment the exit is
 * committed (bye to every peer — off air now), then the recording's final
 * part is CAPTURED (`recording.stop("leave")`, bounded), then the
 * presentation and devices stop, then the phase changes. The upload finishes
 * behind the left/ended screen; Rejoin, Reopen and Back wait for it
 * (bounded), and the tab's unload prompt holds while anything is unsent
 * (use-room-recording keeps it for the whole tab).
 *
 *   Leave         "I go; the room keeps running." The last host on air sees
 *                 why in the Leave menu, next to End for everyone.
 *   End           Webinar: the server stamps it first; if that fails nothing
 *                 is torn down. 1:1: End call (once the other side has been
 *                 here and the start has come) — completed calls take this
 *                 side back to its list after the upload.
 *   Server close  A heartbeat or `room-changed` answer: ended, cancelled,
 *                 closed, revoked — the same teardown.
 *   Rejoin        A remount (RoomController's key), back through the green
 *                 room; a role the server minted differently remounts too.
 */

export type RoomTransport = {
  join: () => Promise<JoinResult>;
  announce: (joinedAs?: SignalRole) => Promise<PresenceResult>;
  leave: () => Promise<void>;
  listPeers: () => Promise<LivePeer[]>;
};

/** fetchLiveState's answer (room-actions.ts). Null: not in this room now. */
export type WebinarLiveState = {
  liveStartedAt: string | null;
  liveEndedAt: string | null;
  canEnd: boolean;
  isStaff: boolean;
} | null;

export type WebinarBinding = {
  eventId: string;
  startsAt: string;
  endsAt: string | null;
  /** events.manage, as opposed to a guest speaker. */
  isStaffHost: boolean;
  /** events.auto_record. */
  autoRecord: boolean;
  liveStartedAt: string | null;
  liveEndedAt: string | null;
  /** May this reader End for everyone, as the page rendered it. */
  canEnd: boolean;
  /** The event's PDF deck, signed for hours (hosts only). */
  deck: EventDeck | null;
  panel: WebinarPanelInitial;
  /** End for everyone; resolves with the stored live_ended_at. */
  endLive: () => Promise<string>;
  reopenLive: () => Promise<void>;
  fetchLiveState: () => Promise<WebinarLiveState>;
  setPrimaryHost: (userId: string) => Promise<ActionResult>;
  /** Who else is hosting, and whether a take is running (getHostingStatus). */
  hostingStatus: () => Promise<{ hosts: { userId: string; name: string }[]; recording?: boolean }>;
};

export type CallBinding = {
  inviteId: string;
  startsAt: string;
  endsAt: string;
  /**
   * The call's staff side as the page rendered it (host, then co-hosts). From
   * the first heartbeat the room reads the server's list (session.callStaffIds);
   * this one still decides which side THIS person is on (selfIsCallStaff).
   */
  staffIds: string[];
  /** Everyone else on the call, by name. */
  otherName: string;
  /** Mark the call completed (the server refuses before the start). */
  endCall: () => Promise<{ completed: boolean }>;
};

export type RoomControllerProps = {
  title: string;
  self: { id: string; name: string };
  role: LiveRole;
  /** Role-aware list page: where Back and after-call navigation go. */
  backHref: string;
  transport: RoomTransport;
  webinar?: WebinarBinding;
  call?: CallBinding;
  /**
   * False before migration 0095: no take can start, so nobody is told the
   * room is recorded, and the people who would record are told it is off.
   */
  recordingReady?: boolean;
};

type RejoinOptions = { endedAt?: string | null; role?: LiveRole };

/** A webinar's call staff: nobody (one array, so memos keyed on it hold). */
const NO_STAFF: readonly string[] = [];
/** How often the green room asks who is hosting. */
const HOSTING_POLL_MS = 10_000;
/** Join's last look at who is hosting waits this long at most. */
const JOIN_RECHECK_MS = 4_000;
/** Ended screens poll for a Reopen: 15 s, 30 s after an empty answer, jittered. */
const ENDED_POLL_MS = 15_000;
const ENDED_POLL_BACKOFF_MS = 30_000;
const ENDED_POLL_JITTER_MS = 3_000;

/**
 * Holds what must survive a remount: the attempt key (Rejoin, Retry and a
 * role mismatch remount the whole session), what the room knew about End,
 * the server-minted role, and a 1:1's "the other side has been here" latch.
 */
export function RoomController(props: RoomControllerProps) {
  const router = useRouter();
  const [attempt, setAttempt] = useState(0);
  const [roleOverride, setRoleOverride] = useState<LiveRole | null>(null);
  const [endedOverride, setEndedOverride] = useState<{ at: string | null } | null>(null);

  const rejoin = useCallback(
    (opts?: RejoinOptions) => {
      if (opts && "endedAt" in opts) setEndedOverride({ at: opts.endedAt ?? null });
      if (opts?.role) setRoleOverride(opts.role);
      setAttempt((n) => n + 1);
      router.refresh();
    },
    [router],
  );

  // A fresh server render (Rejoin's refresh) is the truth about End from then
  // on: what a Rejoin carried across only covers the gap until it lands.
  const propEndedAt = props.webinar?.liveEndedAt ?? null;
  const lastPropEndedAt = useRef(propEndedAt);
  useEffect(() => {
    if (lastPropEndedAt.current === propEndedAt) return;
    lastPropEndedAt.current = propEndedAt;
    setEndedOverride(null);
  }, [propEndedAt]);

  // A 1:1's latch lives above the remount (and in sessionStorage across a
  // reload): someone back in the room after the other person left keeps End call.
  const roomId = props.webinar?.eventId ?? props.call?.inviteId ?? "";
  const isCall = !!props.call;
  const [peerSeenIn, setPeerSeenIn] = useState<string | null>(null);
  useEffect(() => {
    if (isCall && readPeerSeen(roomId)) setPeerSeenIn(roomId);
  }, [isCall, roomId]);
  const markPeerSeen = useCallback(() => {
    setPeerSeenIn(roomId);
    writePeerSeen(roomId);
  }, [roomId]);

  return (
    <RoomSession
      key={attempt}
      {...props}
      role={roleOverride ?? props.role}
      initialEndedAt={endedOverride ? endedOverride.at : (props.webinar?.liveEndedAt ?? null)}
      rejoin={rejoin}
      peerSeenCarried={peerSeenIn === roomId}
      onPeerSeen={markPeerSeen}
    />
  );
}

const peerSeenKey = (roomId: string) => `live:peerSeen:${roomId}`;

function readPeerSeen(roomId: string): boolean {
  try {
    return window.sessionStorage.getItem(peerSeenKey(roomId)) === "1";
  } catch {
    return false; // storage blocked: the in-memory latch still survives remounts
  }
}

function writePeerSeen(roomId: string): void {
  try {
    window.sessionStorage.setItem(peerSeenKey(roomId), "1");
  } catch {
    /* see readPeerSeen */
  }
}

function RoomSession({
  title,
  self,
  role,
  backHref,
  transport,
  webinar,
  call,
  initialEndedAt,
  rejoin,
  peerSeenCarried,
  onPeerSeen,
  recordingReady = true,
}: RoomControllerProps & {
  initialEndedAt: string | null;
  rejoin: (opts?: RejoinOptions) => void;
  peerSeenCarried: boolean;
  onPeerSeen: () => void;
}) {
  const router = useRouter();
  const kind = webinar ? "webinar" : "call";
  const roomId = webinar?.eventId ?? call?.inviteId ?? "";
  const broadcaster = role === "host";
  const isStaffHost = broadcaster && !!webinar?.isStaffHost;

  // ── Phase ─────────────────────────────────────────────────────────────────
  // A host arriving on an ended webinar lands on the ended screen (Reopen for
  // staff); pressing Start never reopens anything. Viewers never get here
  // ended: the page renders the ended shell for them.
  const [phase, setPhase] = useState<RoomPhase>(webinar && initialEndedAt ? "ended" : "prejoin");
  const [endedAt, setEndedAt] = useState<string | null>(initialEndedAt);
  const [endedByMe, setEndedByMe] = useState(false);
  const [closedReason, setClosedReason] = useState<CloseReason | null>(null);
  const [busy, setBusy] = useState<RoomBusy>(null);
  /** Join, Reopen: shown where they happened (green room, end screen). */
  const [actionError, setActionError] = useState<string | null>(null);
  /** End for everyone failed: shown in the End confirm, nowhere else. */
  const [endError, setEndError] = useState<string | null>(null);
  // Off air the moment an exit is committed, not when the phase changes (the
  // phase waits for the recorder's final part).
  const [leaving, setLeaving] = useState(false);
  const [ending, setEnding] = useState(false);

  // ── Devices, presentation, session ────────────────────────────────────────
  const media = useLocalMedia({ autoStart: broadcaster && (phase === "prejoin" || phase === "live") });
  const presentation = usePresentation({ enabled: broadcaster, eventDeck: webinar?.deck ?? null });

  const session = useLiveSession({
    kind: webinar ? "event" : "call",
    roomId,
    role: broadcaster ? "host" : "viewer",
    enabled: phase === "live" && !leaving && !ending,
    localStream: broadcaster ? media.stream : null,
    screenStream: broadcaster ? presentation.stream : null,
    // Passed rather than read off track.enabled: the engine detaches a track
    // that is off, so a viewer is told "camera off" instead of a black frame.
    cameraOn: media.cameraOn,
    micOn: media.micOn,
    join: transport.join,
    announce: transport.announce,
    leave: transport.leave,
    listPeers: transport.listPeers,
  });
  const { recheck } = session;

  // Server truth (every join / heartbeat answer); the page's render until then.
  const room = useMemo<RoomServerState>(
    () =>
      session.room ?? {
        primaryId: null,
        liveStartedAt: webinar?.liveStartedAt ?? null,
        liveEndedAt: endedAt,
        canEnd: webinar ? webinar.canEnd : false,
        recording: null,
      },
    [session.room, webinar?.liveStartedAt, webinar?.canEnd, webinar, endedAt],
  );
  const roomEndedAt = session.room?.liveEndedAt ?? null;
  useEffect(() => {
    if (roomEndedAt) setEndedAt(roomEndedAt);
  }, [roomEndedAt]);

  // ── 1:1 team and "the other side has been here" ───────────────────────────
  // The staff list as the server last read it: people can be added mid-call.
  const staffIds = call ? (session.callStaffIds ?? call.staffIds) : NO_STAFF;
  // A heartbeat can add other people to the team, never the student's laptop.
  const isCallStaff =
    !!call && selfIsCallStaff({ selfId: self.id, rendered: call.staffIds, live: session.callStaffIds });
  // End call only once the OTHER side (for staff: the student) has been live
  // here: a lone host pressing the red button is trying to get out of an
  // empty room, and completing the call then refunds nothing and tells the
  // student it happened. Latched above the remount.
  const peerLive =
    !!call &&
    session.remotes.some((p) => p.state === "live" && isCallCounterpart(staffIds, self.id, p.peerId));
  useEffect(() => {
    if (peerLive) onPeerSeen();
  }, [peerLive, onPeerSeen]);
  const peerSeen = !!call && (peerLive || peerSeenCarried);
  const peerSeenRef = useRef(peerSeen);
  peerSeenRef.current = peerSeen;
  const canEnd = webinar ? room.canEnd && !endedAt : room.canEnd && peerSeen;

  // The start makes End available (webinarHasBegun / mayEndCall): ask then,
  // not a heartbeat later.
  const startsAt = webinar?.startsAt ?? call?.startsAt ?? null;
  useEffect(() => {
    if (phase !== "live" || !startsAt) return;
    const wait = Date.parse(startsAt) - Date.now();
    if (!(wait > 0)) return;
    const t = setTimeout(recheck, Math.min(wait + 1_000, 2_147_483_647));
    return () => clearTimeout(t);
  }, [phase, startsAt, recheck]);

  // ── Recording ─────────────────────────────────────────────────────────────
  // One take under the server's lease, composited the way the room sees it.
  // Webinar hosts and a call's staff may record; calls start on their own,
  // webinars when the event records automatically and has gone live (not a
  // rehearsal). Everyone's REC badge reads session.room.recording.
  const [layout, setLayout] = useState<{ mainId: string | null; mainIsPresentation: boolean }>({
    mainId: null,
    mainIsPresentation: false,
  });
  const onSharedLayout = useCallback((l: { mainId: string | null; mainIsPresentation: boolean }) => {
    setLayout((cur) => (cur.mainId === l.mainId && cur.mainIsPresentation === l.mainIsPresentation ? cur : l));
  }, []);
  const otherName = call?.otherName;
  const recorderRemotes = useMemo(
    () =>
      session.remotes
        .filter((p) => p.role === "host" && p.state === "live")
        .map((p) => ({ peerId: p.peerId, name: p.name || otherName || "Speaker", streams: p.streams })),
    [session.remotes, otherName],
  );
  const mediaSettled = !broadcaster || (media.status !== "idle" && media.status !== "requesting");
  const canRecord = webinar ? broadcaster : isCallStaff;
  const recording = useRoomRecording({
    kind,
    roomId,
    canRecord,
    autoStart: call ? true : !!webinar?.autoRecord && !endedAt && !!room.liveStartedAt,
    live: phase === "live" && mediaSettled && !ending && !leaving && !endedAt,
    serverRecording: session.room?.recording ?? null,
    selfId: self.id,
    localStream: broadcaster ? media.stream : null,
    screenStream: broadcaster ? presentation.stream : null,
    cameraOn: media.cameraOn,
    micOn: media.micOn,
    selfName: self.name,
    remotes: recorderRemotes,
    layout,
  });

  // This tab recorded in this session: the end screens then say how it went.
  const [recordedHere, setRecordedHere] = useState(false);
  useEffect(() => {
    if (recording.mine) setRecordedHere(true);
  }, [recording.mine]);

  // ── Green room ────────────────────────────────────────────────────────────
  // Who else is hosting decides the CTA: "Start webinar" or "Join as co-host";
  // the same answer says whether the room is recording right now, so the
  // recording notice is as current as the hosting line (hosts only — they are
  // the ones on camera).
  const hostingStatus = webinar?.hostingStatus;
  const [hosting, setHosting] = useState<string[] | null>(null);
  // A webinar that isn't auto-recorded may still be recording right now.
  const autoRecord = !!webinar?.autoRecord;
  const [recordingNow, setRecordingNow] = useState(false);
  const hostingRef = useRef(hosting);
  hostingRef.current = hosting;
  const recordingNowRef = useRef(recordingNow);
  recordingNowRef.current = recordingNow;
  /** One read of the green room's server truth; null when it couldn't be read. */
  const readHosting = useCallback(async (): Promise<{ hosts: string[]; recording: boolean } | null> => {
    if (!hostingStatus) return null;
    try {
      const r = await hostingStatus();
      return { hosts: r.hosts.map((h) => h.name), recording: !!r.recording };
    } catch {
      return null; // The next tick asks again; the server still decides who is primary.
    }
  }, [hostingStatus]);
  useEffect(() => {
    if (!hostingStatus || !broadcaster || phase !== "prejoin") return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      if (!document.hidden) {
        const r = await readHosting();
        if (!stopped && r) {
          setHosting(r.hosts);
          setRecordingNow(r.recording);
        }
      }
      if (!stopped) timer = setTimeout(tick, HOSTING_POLL_MS);
    };
    void tick();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [hostingStatus, readHosting, broadcaster, phase]);

  // Viewers aren't recorded; they are told once whether hosts are.
  useEffect(() => {
    if (kind !== "webinar" || broadcaster || autoRecord || phase !== "prejoin") return;
    let stopped = false;
    fetch(`/api/recordings/active?kind=webinar&room=${encodeURIComponent(roomId)}`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((b: { recording?: unknown } | null) => {
        if (!stopped && b?.recording) setRecordingNow(true);
      })
      .catch(() => {});
    return () => {
      stopped = true;
    };
  }, [kind, broadcaster, autoRecord, phase, roomId]);

  // Co-hosts join with camera and mic off, applied once the stream exists.
  const joinMuted = useRef(false);
  useEffect(() => {
    if (!joinMuted.current || phase !== "live" || media.status !== "ready") return;
    joinMuted.current = false;
    if (media.cameraOn) media.toggleCamera();
    if (media.micOn) media.toggleMic();
  }, [media, phase]);

  const joiningRef = useRef(false);
  const join = useCallback(async () => {
    if (joiningRef.current) return;
    setActionError(null);
    // A webinar host re-reads who is hosting and whether a take is running
    // before going in: a host who went live, or pressed Record, since the last
    // poll changes what this person joins as. If it changed, they stay here to
    // see the notice and the "Join as co-host" line first, and press again.
    if (webinar && broadcaster && hostingStatus) {
      joiningRef.current = true;
      setBusy("joining");
      const fresh = await Promise.race([
        readHosting(),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), JOIN_RECHECK_MS)),
      ]);
      joiningRef.current = false;
      setBusy(null);
      if (fresh) {
        const before = (hostingRef.current ?? []).some((n) => n.trim());
        const newlyRecorded = fresh.recording && !recordingNowRef.current && !autoRecord;
        hostingRef.current = fresh.hosts;
        setHosting(fresh.hosts);
        setRecordingNow(fresh.recording);
        if ((fresh.hosts.some((n) => n.trim()) && !before) || newlyRecorded) return;
      }
    }
    joinMuted.current =
      !!webinar && broadcaster && !!hostingRef.current && hostingRef.current.some((n) => n.trim());
    setPhase("live");
  }, [webinar, broadcaster, hostingStatus, readHosting, autoRecord]);

  // ── Teardown ──────────────────────────────────────────────────────────────
  const stopRecording = recording.stop;
  const stopPresenting = presentation.stop;
  const stopMedia = media.stop;
  /** Capture the recording's final part, then stop the tracks it reads, then move on. */
  const finish = useCallback(
    async (next: Exclude<RoomPhase, "prejoin" | "live">) => {
      try {
        await stopRecording("leave");
      } catch (err) {
        console.error("[live] recording flush failed", err);
      }
      stopPresenting();
      stopMedia();
      // What went wrong in the room (a failed End) isn't news on the screen
      // after it; errors raised there (Reopen) are set later and stay.
      setActionError(null);
      setEndError(null);
      setPhase(next);
    },
    [stopRecording, stopPresenting, stopMedia],
  );

  // In the green room, a fresh server render (after Rejoin's refresh) is the
  // truth about End: a host who left, and comes back after another host ended
  // the webinar, lands on the ended screen (Reopen for staff), not on Start —
  // and the camera the green room opened goes off. Only a change of the prop
  // counts; the mount already used what it knew.
  const propEndedAt = webinar?.liveEndedAt ?? null;
  const seenPropEndedAt = useRef(propEndedAt);
  useEffect(() => {
    if (seenPropEndedAt.current === propEndedAt) return;
    seenPropEndedAt.current = propEndedAt;
    if (phase !== "prejoin") return;
    setEndedAt(propEndedAt);
    if (!propEndedAt) return;
    stopPresenting();
    stopMedia();
    setPhase("ended");
  }, [propEndedAt, phase, stopPresenting, stopMedia]);

  // Ways off the left/ended screens wait for the uploads (bounded), one at a time.
  const drain = recording.drain;
  const pendingRef = useRef(recording.pendingUploads);
  pendingRef.current = recording.pendingUploads;
  /** An exit off the end screen was chosen: a 1:1's automatic return must not override it. */
  const exitChosen = useRef(false);
  const afterUploads = useCallback(
    async (waiting: RoomBusy) => {
      exitChosen.current = true;
      if (pendingRef.current === 0) return;
      setBusy(waiting);
      try {
        await drain();
      } finally {
        setBusy(null);
      }
    },
    [drain],
  );

  // Read from the URL, not from being mounted: a re-render can unmount the
  // room while the person is still on its page.
  const roomPath = useRef<string | null>(null);
  useEffect(() => {
    roomPath.current = window.location.pathname;
  }, []);
  const stillHere = useCallback(
    () => roomPath.current === null || window.location.pathname === roomPath.current,
    [],
  );

  /** One exit at a time: End and the hint it causes must not both tear down. */
  const exiting = useRef(false);

  const enterEnded = useCallback(() => {
    if (exiting.current) return;
    exiting.current = true;
    setEnding(true);
    void finish("ended");
  }, [finish]);

  const enterClosed = useCallback(
    (reason: CloseReason) => {
      if (exiting.current) return;
      exiting.current = true;
      setEnding(true);
      setClosedReason(reason);
      void finish("closed");
    },
    [finish],
  );

  useEffect(() => {
    if (phase === "live" && endedAt && webinar) enterEnded();
  }, [phase, endedAt, webinar, enterEnded]);

  // An End that FAILED may still have landed (the response was lost); what
  // would have acted on it ran while the End held the exit.
  const closedRef = useRef(session.closed);
  closedRef.current = session.closed;
  const endedAtRef = useRef(endedAt);
  endedAtRef.current = endedAt;
  const afterFailedEnd = useCallback(() => {
    const closed = closedRef.current;
    if (closed && closed.reason !== "ended") enterClosed(closed.reason);
    else if (closed || endedAtRef.current) enterEnded();
  }, [enterClosed, enterEnded]);

  const leaveNow = useCallback(async () => {
    if (exiting.current) return;
    exiting.current = true;
    setLeaving(true);
    setBusy("leaving");
    await finish("left");
    setBusy(null);
  }, [finish]);

  const endLive = webinar?.endLive;
  const endWebinar = useCallback(async () => {
    if (!endLive || exiting.current) return;
    exiting.current = true;
    setBusy("ending");
    setEndError(null);
    let stored: string;
    try {
      stored = await endLive();
    } catch (err) {
      // Nothing torn down: still live, told why (in the confirm), can press it again.
      exiting.current = false;
      setBusy(null);
      setEndError(getActionError(err, "Couldn't end the webinar. Try again."));
      afterFailedEnd();
      return;
    }
    setEnding(true);
    setEndedByMe(true);
    setEndedAt(stored);
    await finish("ended");
    setBusy(null);
  }, [endLive, finish, afterFailedEnd]);

  /**
   * End a 1:1 for everyone ("mine"), or close this side because the server
   * says it is over ("elsewhere"). The server call and the recorder's final
   * capture run side by side; the ended screen shows only when the call
   * really ended (endCall answers completed:false before the start, and a
   * request can fail — then this side has LEFT). After this side's own End
   * call, it goes back to its calls list once the upload is done, if still on
   * the room's page and no other exit was chosen. endCall revalidates
   * nothing, so the room stays mounted through the upload.
   */
  const endCall = call?.endCall;
  const finishCall = useCallback(
    async (how: "mine" | "elsewhere", reason?: CloseReason) => {
      if (!endCall || exiting.current) return;
      if (how === "mine" && !peerSeenRef.current) {
        void leaveNow();
        return;
      }
      exiting.current = true;
      setEnding(true);
      if (how === "mine") setBusy("ending");
      const ended =
        how === "mine"
          ? endCall().then(
              (r) => r.completed,
              (err) => {
                // Never trap anyone in the room; the sweep completes it at the hard close.
                console.error("[live] end call failed", err);
                return false;
              },
            )
          : null;
      try {
        await stopRecording("leave");
      } catch (err) {
        console.error("[live] recording flush failed", err);
      }
      stopPresenting();
      stopMedia();
      const completed = ended ? await ended : true;
      setActionError(null);
      setEndError(null);
      if (how === "elsewhere" && (reason === "closed" || reason === "revoked")) {
        setClosedReason(reason);
        setPhase("closed");
      } else {
        if (reason === "cancelled") setClosedReason("cancelled");
        setPhase(completed ? "ended" : "left");
      }
      setBusy(null);
      if (how === "mine" && completed) {
        await drain();
        if (!exitChosen.current && stillHere()) {
          exitChosen.current = true;
          router.push(backHref);
        }
      }
    },
    [endCall, leaveNow, stopRecording, stopPresenting, stopMedia, drain, stillHere, router, backHref],
  );
  const finishCallRef = useRef(finishCall);
  finishCallRef.current = finishCall;

  // The server closed the session: a heartbeat or a room-changed re-check.
  const fetchLiveState = webinar?.fetchLiveState;
  useEffect(() => {
    const closed = session.closed;
    if (!closed || phase !== "live") return;
    if (call) {
      void finishCallRef.current("elsewhere", closed.reason);
      return;
    }
    if (closed.reason === "ended") {
      // The stored time, for the ended screen; the teardown doesn't wait.
      void fetchLiveState?.()
        .then((s) => {
          if (s?.liveEndedAt) setEndedAt(s.liveEndedAt);
        })
        .catch(() => {});
      enterEnded();
    } else {
      enterClosed(closed.reason);
    }
  }, [session.closed, phase, call, fetchLiveState, enterEnded, enterClosed]);

  // The server minted another role than the page rendered: never run a host
  // engine on viewer credentials (or the reverse). Remount as what it says.
  const pageRole: SignalRole = broadcaster ? "host" : "viewer";
  const minted = session.serverRole;
  useEffect(() => {
    if (!minted || minted === pageRole || phase !== "live") return;
    rejoin({ role: minted, endedAt: endedAtRef.current });
  }, [minted, pageRole, phase, rejoin]);

  // ── Hosts on air ──────────────────────────────────────────────────────────
  const otherHostLive = session.remotes.some((r) => r.role === "host" && r.state === "live");
  // Before the go-live window a host is rehearsing: nothing is stamped,
  // students stay out, and Leave is the way out.
  const rehearsing = !!webinar && broadcaster && phase === "live" && session.joined && !room.liveStartedAt;
  const soleOnAir =
    !!webinar && broadcaster && phase === "live" && !endedAt && !otherHostLive && !!room.liveStartedAt;
  // Whether a guest speaker may End depends on who else is present right now.
  useEffect(() => {
    if (soleOnAir) recheck();
  }, [soleOnAir, recheck]);

  // The last host closing the tab strands the audience: the browser's prompt.
  const guardUnload = soleOnAir && session.state === "live";
  useEffect(() => {
    if (!guardUnload) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [guardUnload]);

  const leaveHint = soleOnAir
    ? canEnd
      ? "You're the only host on air."
      : "You're the only host on air. Viewers wait until a host is back."
    : null;

  const opensAt = webinar ? roomWindow(webinar.startsAt, webinar.endsAt).goLiveOpensAt : null;
  const notice: ReactNode =
    rehearsing && opensAt !== null ? (
      <span>
        Not live yet: students can join from <LocalTime value={new Date(opensAt)} mode="time" />
      </span>
    ) : null;

  // The green room before the go-live window says so (and "Enter room", not
  // "Start webinar"). Read after mount, so the server render never disagrees.
  const [beforeOpen, setBeforeOpen] = useState(false);
  useEffect(() => {
    if (opensAt === null) return;
    const wait = opensAt - Date.now();
    setBeforeOpen(wait > 0);
    if (!(wait > 0)) return;
    const t = setTimeout(() => setBeforeOpen(false), Math.min(wait + 500, 2_147_483_647));
    return () => clearTimeout(t);
  }, [opensAt]);
  const rehearsalUntil =
    phase === "prejoin" && broadcaster && beforeOpen && opensAt !== null && !webinar?.liveStartedAt
      ? new Date(opensAt).toISOString()
      : null;

  // A rehearsal turns into the real thing on a heartbeat inside the window:
  // the host is told, once (students are let in; an auto-recorded event starts
  // recording).
  const [flash, setFlash] = useState<{ id: string; message: string } | null>(null);
  const wasRehearsing = useRef(false);
  useEffect(() => {
    if (rehearsing) {
      wasRehearsing.current = true;
      return;
    }
    if (!wasRehearsing.current || phase !== "live" || !room.liveStartedAt) return;
    wasRehearsing.current = false;
    setFlash({
      id: "went-live",
      message: autoRecord
        ? "You're live. Students can join now. Recording starts automatically."
        : "You're live. Students can join now.",
    });
  }, [rehearsing, phase, room.liveStartedAt, autoRecord]);

  // ── Pin for everyone (webinar staff) ──────────────────────────────────────
  // The outcome goes back to the room, which says it where the pin was made
  // (a toast); it never lands in the room-wide action error.
  const setPrimaryHost = webinar?.setPrimaryHost;
  const pinForEveryone = useCallback(
    async (peerId: string): Promise<ActionResult> => {
      if (!setPrimaryHost) return { ok: false, error: "Couldn't pin that host. Try again." };
      const res = await setPrimaryHost(peerId).catch(
        (err): ActionResult => ({ ok: false, error: getActionError(err, "Couldn't pin that host. Try again.") }),
      );
      if (res.ok) recheck();
      return res;
    },
    [setPrimaryHost, recheck],
  );

  // ── Ended screens: watch for a Reopen ─────────────────────────────────────
  const hardCloseAt = webinar ? roomWindow(webinar.startsAt, webinar.endsAt).hardCloseAt : null;
  const reopened = useReopenWatch(phase === "ended" && fetchLiveState ? fetchLiveState : null, hardCloseAt);

  const reopenLive = webinar?.reopenLive;
  const reopen = useCallback(async () => {
    if (!reopenLive) return;
    setActionError(null);
    // The audience is let back in when the host is really on the way back.
    await afterUploads("reopening");
    setBusy("reopening");
    try {
      await reopenLive();
    } catch (err) {
      setBusy(null);
      setActionError(getActionError(err, "Couldn't reopen the webinar."));
      return;
    }
    rejoin({ endedAt: null });
  }, [reopenLive, afterUploads, rejoin]);

  const doRejoin = useCallback(async () => {
    await afterUploads("rejoining");
    rejoin({ endedAt: reopened ? null : endedAt });
  }, [afterUploads, rejoin, reopened, endedAt]);

  const back = useCallback(async () => {
    await afterUploads("back");
    if (stillHere()) router.push(backHref);
  }, [afterUploads, stillHere, router, backHref]);

  const retry = useCallback(() => rejoin({ endedAt }), [rejoin, endedAt]);

  // ── View ──────────────────────────────────────────────────────────────────
  const rejoinUntil = call
    ? new Date(Date.parse(call.endsAt) + ROOM_HARD_CLOSE_MINUTES_AFTER * 60_000).toISOString()
    : null;
  const end: RoomEnd = {
    at: endedAt,
    byMe: endedByMe,
    reopened,
    canReopen: isStaffHost,
    rejoinUntil,
    reason:
      closedReason === "cancelled" || closedReason === "closed" || closedReason === "revoked"
        ? closedReason
        : undefined,
    // Said once the upload is done: saved, or what went wrong (a take that
    // lost its lease while draining says so here, not in a toast nobody sees).
    recording: canRecord && (recordedHere || recording.error) ? { saved: recordedHere, error: recording.error } : null,
  };

  const recordingNotice = !recordingReady ? (
    // Said only to the people who would record; nobody else is told anything.
    canRecord && (call || autoRecord) ? (
      <>
        <p className="font-medium">This {call ? "call" : "webinar"} isn&rsquo;t recorded</p>
        <p className="mt-0.5 text-[#e8b4b5]">Recording turns on after a pending site update.</p>
      </>
    ) : null
  ) : call ? (
    <CallRecordingNotice staff={isCallStaff} people={staffIds.length + 1} otherName={call.otherName} />
  ) : webinar && (autoRecord || recordingNow) ? (
    <>
      <p className="font-medium">This webinar is recorded</p>
      <p className="mt-0.5 text-[#e8b4b5]">Hosts are recorded. Viewers aren&rsquo;t.</p>
    </>
  ) : null;

  // In a recorded 1:1, everyone on it keeps being told who can watch it back
  // (read from the live staff list: a co-host added mid-call changes it).
  const callRecorded =
    !!call && phase === "live" && (!!room.recording || recording.mine || !!recording.by);
  const subline = callRecorded ? (
    <span data-testid="call-recorded-line">
      This call is recorded. {whoCanWatch(staffIds.length + 1, call.otherName)}
    </span>
  ) : null;

  const panelRole = isStaffHost ? "staff" : broadcaster ? "speaker" : "viewer";
  const panelInitial = webinar?.panel ?? null;
  const chatOn = panelInitial ? audienceCanSeeEachOther(panelInitial.audienceMode) : false;
  const tabs = useMemo(() => panelTabs(panelRole, chatOn), [panelRole, chatOn]);
  const eventId = webinar?.eventId ?? null;
  const { roomTopic, moderationTopic, joined, audienceCount } = session;
  const hasEnded = !!endedAt;
  const panel = useMemo<RoomPanelSlot | null>(
    () =>
      eventId && panelInitial
        ? {
            tabs,
            render: ({ tab, onTabChange, onUnread }) => (
              <WebinarPanel
                eventId={eventId}
                role={panelRole}
                selfId={self.id}
                selfName={self.name}
                roomTopic={roomTopic}
                moderationTopic={moderationTopic}
                live={joined}
                ended={hasEnded}
                tab={tab}
                onTabChange={onTabChange}
                audienceCount={audienceCount}
                onUnread={onUnread}
                initial={panelInitial}
              />
            ),
          }
        : null,
    [eventId, panelInitial, tabs, panelRole, self.id, self.name, roomTopic, moderationTopic, joined, hasEnded, audienceCount],
  );
  const reactions = useMemo(
    () =>
      eventId
        ? {
            button: <ReactionsButton eventId={eventId} roomTopic={roomTopic} />,
            overlay: <ReactionsOverlay roomTopic={roomTopic} />,
          }
        : null,
    [eventId, roomTopic],
  );

  const actions = useMemo<LiveRoomProps["actions"]>(
    () => ({
      join: () => void join(),
      leave: () => void leaveNow(),
      end: broadcaster || call ? () => void (call ? finishCall("mine") : endWebinar()) : undefined,
      rejoin: () => void doRejoin(),
      reopen: isStaffHost ? () => void reopen() : undefined,
      retry,
      pinForEveryone: webinar && isStaffHost ? pinForEveryone : undefined,
      back: () => void back(),
    }),
    [join, leaveNow, broadcaster, call, finishCall, endWebinar, doRejoin, isStaffHost, reopen, retry, webinar, pinForEveryone, back],
  );

  const connection = useMemo(
    () => ({
      state: session.state,
      joined: session.joined,
      error: session.error,
      joinFailed: session.joinFailed
        ? { message: session.error ?? "Couldn't reach the room. Try again." }
        : null,
    }),
    [session.state, session.joined, session.error, session.joinFailed],
  );

  return (
    <LiveRoom
      kind={kind}
      title={title}
      self={{
        id: self.id,
        name: self.name,
        broadcaster,
        staff: webinar ? isStaffHost : isCallStaff,
      }}
      phase={phase}
      backHref={backHref}
      startsAt={webinar?.startsAt ?? null}
      media={broadcaster ? media : null}
      presentation={broadcaster ? presentation : null}
      remotes={session.remotes}
      connection={connection}
      room={{ ...room, canEnd }}
      audienceCount={broadcaster ? audienceCount : null}
      recording={recording}
      canRecord={canRecord}
      hosting={hosting}
      recordingNotice={recordingNotice}
      panel={panel}
      reactions={reactions}
      end={end}
      busy={busy}
      actionError={actionError}
      endError={endError}
      leaveHint={leaveHint}
      notice={notice}
      subline={subline}
      rehearsalUntil={rehearsalUntil}
      flash={flash}
      actions={actions}
      onSharedLayout={onSharedLayout}
    />
  );
}

/** Who can watch a 1:1's recording: "recorded" with no audience named reads as "for anyone". */
function whoCanWatch(people: number, otherName: string): string {
  return people <= 2
    ? `Only you, ${otherName} and batch0 admins can watch it back.`
    : "Only the people on this call and batch0 admins can watch it back.";
}

/** The 1:1 green-room notice: before Join, for everyone (minors are on these calls). */
function CallRecordingNotice({ staff, people, otherName }: { staff: boolean; people: number; otherName: string }) {
  const who = whoCanWatch(people, otherName);
  return (
    <>
      <p className="font-medium">This call is recorded</p>
      <p className="mt-0.5 text-[#e8b4b5]">
        {staff ? `Recording starts when the first of the team joins. ${who}` : who}
      </p>
    </>
  );
}

/**
 * Watch an ended webinar for a Reopen pressed elsewhere (the admin pages,
 * another host). Nobody on an ended screen has a session to hear the
 * room-changed hint, so it polls the server's live state: every 15 s, 30 s
 * after a null answer (null is "can't place you in the room right now", not
 * "never" — e.g. a Reopen past end+30m until a host is back), paused while
 * hidden, jittered, until the hard stop. True once the room is open again;
 * nothing reconnects anyone.
 */
function useReopenWatch(
  read: (() => Promise<WebinarLiveState>) | null,
  hardCloseAt: number | null,
): boolean {
  const [reopened, setReopened] = useState(false);
  useEffect(() => {
    if (!read || reopened) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const schedule = (ms: number) => {
      if (stopped) return;
      if (hardCloseAt !== null && Date.now() > hardCloseAt) return;
      timer = setTimeout(tick, ms + Math.floor(Math.random() * ENDED_POLL_JITTER_MS));
    };
    const tick = async () => {
      if (document.hidden) {
        schedule(ENDED_POLL_MS);
        return;
      }
      let next: WebinarLiveState | undefined;
      try {
        next = await read();
      } catch {
        // Couldn't tell; ask again next tick.
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
  }, [read, reopened, hardCloseAt]);
  return reopened;
}
