"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import type { RealtimeChannel, SupabaseClient } from "@supabase/supabase-js";
import {
  connectionTopic,
  countLiveAudience,
  HEARTBEAT_MS,
  ICE_BATCH_MS,
  isAddressedTo,
  MEDIA_SLOTS,
  nextStatusAction,
  ROOM_CHANGED_THROTTLE_MS,
  shouldApplyAnswer,
  shouldPruneConnection,
  SIGNAL_EVENT,
  slotForMid,
  slotIsActive,
  type LobbyMessage,
  type MediaSlot,
  type PeerLinkState,
  type SignalMessage,
  type SignalRole,
  type StageMessage,
} from "@/lib/live-signal";
import type { LiveCredentials, LivePeer } from "@/lib/live-rooms";
import type {
  JoinRefusal,
  JoinResult,
  PresenceResult,
} from "@/app/live/actions";

/**
 * batch0 Live, browser side: the WebRTC engine behind a webinar or a 1:1.
 *
 * One hook runs both, because they are the same machine with a different
 * number of broadcasters. A webinar is one host and N viewers; a 1:1 is two
 * hosts. In both cases a broadcaster OFFERS to every peer it knows about, and
 * a viewer never offers, never sends media, and only ever holds a connection
 * to a host. That makes a webinar a star and a 1:1 a single edge, with no
 * special-casing in between — and no path by which two viewers are ever
 * introduced to each other.
 *
 * ---------------------------------------------------------------------------
 * Why there is exactly one offer per connection, ever
 * ---------------------------------------------------------------------------
 *
 * Renegotiation is where naive WebRTC falls apart in front of an audience:
 * the host switches to slides, twelve connections renegotiate at once, two
 * collide mid-exchange, and those two students get a frozen frame with
 * nothing in the console to explain it.
 *
 * So this never renegotiates. Each connection is built with a fixed set of
 * transceivers — camera, screen, audio, in that order, always all three, even
 * before the host has a screen to share — and after that the SDP is settled
 * for the life of the call. Every media change is `sender.replaceTrack()`,
 * which the spec allows without renegotiation for a same-kind track.
 *
 * The fixed order is also how the receiver tells camera from screen: slot i
 * is transceiver i is `mid` i (see slotForMid).
 *
 * A corollary the receiving side relies on: a SECOND offer from the same peer
 * can only mean that peer threw its connection away and built a new one (a
 * reload, or a rebuild whose `bye` was lost). It is never a renegotiation of
 * ours, so it is answered on a fresh connection rather than applied to the
 * old one, whose DTLS identity no longer matches anything on the far side.
 *
 * ---------------------------------------------------------------------------
 * Track presence vs. track existence
 * ---------------------------------------------------------------------------
 *
 * Because all three transceivers always exist, `ontrack` fires three times as
 * soon as the offer is applied — including for the screen slot the host is
 * not using. So "a track object exists" cannot mean "they are presenting":
 * read that way, every viewer lands in the presenting layout, staring at a
 * black rectangle where the host's face should be.
 *
 * The receiver's own `muted` flag is not the answer either. Detaching a
 * sender with `replaceTrack(null)` stops the packets but does not reliably
 * mute the remote track, so a host turning their camera off left the audience
 * on a frozen last frame with nothing to explain it — and a decoded-frames
 * check sails straight past both bugs, which is how they reached an audience.
 *
 * So the sender says what it is sending, in a `media` message on the same
 * channel as the rest of the signalling, when a connection comes up and on
 * every change after. `slotIsActive` reconciles that with what the transport
 * can see: the announcement wins where we have one, the track is the fallback
 * for camera and audio so a dropped message cannot cost the webinar, and an
 * unannounced screen slot is off, because nobody is presenting until a host
 * says so.
 *
 * ---------------------------------------------------------------------------
 * Leaving, being ended, and being shut out
 * ---------------------------------------------------------------------------
 *
 * The session ends in exactly one way — `teardown` below — whichever of these
 * set it off:
 *
 *   - the room disabling it (Leave, End, the phase moving on), or unmounting;
 *   - the SERVER saying so. Every heartbeat and every re-check asks
 *     announcePresence for a status, and `nextStatusAction` decides what that
 *     answer means: 'ended' / 'cancelled' close at once, 'closed' / 'revoked'
 *     close on the second consecutive answer, and 'error' (or a request that
 *     failed outright) is ignored, because a database blip must not look like
 *     a revocation. The status used to be a boolean nobody read, so an ended
 *     webinar, a cancelled call and a removed speaker all kept streaming.
 *
 * A `room-changed` hint on the stage makes that re-check happen now rather
 * than at the next heartbeat — End reaches every engine in a second or two —
 * and is throttled, because the stage is public and a forged hint must cost
 * a query and nothing more.
 *
 * Teardown says a `bye` with reason `leave` on every connection BEFORE it
 * forgets its credentials, removes every channel, and bumps the run token so
 * a negotiation still awaiting something can see it has been orphaned and
 * close its peer connection instead of resurrecting the session. A tab being
 * closed takes the same `bye`s plus a beacon to /api/live/leave, because a
 * server action fired from `pagehide` is usually aborted by the browser.
 *
 * A peer who said `bye: leave` is remembered as DEPARTED: drawn as "left"
 * rather than as a camera-off tile, and (in a webinar) not re-dialled by the
 * heartbeat until they signal again. Nothing about a departure is ever
 * treated as a reason to reconnect automatically.
 */

/** A connection's state as the UI sees it — see PeerLinkState in lib/live-signal. */
export type ConnectionState = PeerLinkState;

/** A remote participant as the UI sees them. */
export type RemotePeer = {
  peerId: string;
  name: string;
  role: SignalRole;
  /**
   * `left` is a peer who said a deliberate `bye` (Leave, End, tab closed) and
   * has not signalled since. Their tile says so instead of pretending they
   * are still here with the camera off.
   */
  state: ConnectionState;
  /**
   * Whether this session has ever been connected to them. Separates "waiting
   * for them to arrive" from "they were here and the link dropped".
   */
  seenLive: boolean;
  /**
   * When this connection stopped being live (epoch ms) — or was created, if it
   * never has been. Null while live, and for a departed peer with no
   * connection left to measure. What lets the webinar room stop counting a
   * co-host who has been "reconnecting" for too long as present (see
   * `presentForRecording` in lib/webinars.ts).
   */
  downSince: number | null;
  /**
   * Inbound tracks, by slot — present only while actually carrying media.
   * A slot whose track is muted is absent, not black.
   */
  streams: Partial<Record<MediaSlot, MediaStream>>;
};

/**
 * Why the SERVER ended this session. Terminal: the engine has already torn
 * itself down by the time this is set, and nothing reconnects it.
 *
 *   ended      a webinar ended for everyone, or a 1:1 completed
 *   cancelled  the 1:1 was cancelled
 *   closed     the window ran out (and, for a webinar, no host is left)
 *   revoked    this person no longer has access to the room
 */
export type CloseReason = "ended" | "cancelled" | "closed" | "revoked";

export type LiveSession = {
  state: ConnectionState;
  /**
   * The room's Realtime topics, once joined — chat, questions, polls and
   * reactions, and (hosts only) the moderation queue.
   *
   * Surfaced here rather than fetched separately because they arrive in the
   * join payload, which only this hook holds. Both are null until the join
   * lands, and `roomTopic` STAYS null for a viewer in a `private` webinar —
   * that null is the feature, not a disabled button: it is the absence of any
   * channel on which one student could learn that another is here.
   */
  roomTopic: string | null;
  moderationTopic: string | null;
  /** Broadcasters you can see. For a viewer, this is the whole call. */
  remotes: RemotePeer[];
  /**
   * The join has landed AND every peer it named has been handed to the
   * engine — so `remotes` now includes every broadcaster who was already in
   * the room when this one arrived (most still "connecting"). The webinar
   * room waits for this before deciding who records: deciding earlier is
   * deciding with an empty roster, and every host would elect themselves.
   */
  joined: boolean;
  /**
   * How many viewers are watching RIGHT NOW (live connections only), for the
   * host's header. Always null for a viewer — the audience count is the one
   * number a webinar exists to keep from them — and null in a 1:1, which has
   * no audience to count.
   */
  audienceCount: number | null;
  error: string | null;
  /**
   * The role the server minted the credentials with — the only one to trust.
   * Null until joined. The room compares it with the role it rendered and
   * remounts on a mismatch, rather than running a host engine on viewer
   * credentials (or the reverse).
   */
  serverRole: SignalRole | null;
  /** Set once the server has ended this session. See CloseReason. */
  closed: { reason: CloseReason } | null;
  /**
   * The join itself was refused or failed for a reason that is NOT terminal —
   * a transient error, or the window not open yet. The room offers Retry.
   */
  joinFailed: { reason: JoinRefusal } | null;
  /**
   * Ask the server for this room's status now (throttled). What the room
   * calls when it hears, from somewhere other than the stage, that the room
   * may have changed — the panel's `stage-change` bump, for one.
   */
  recheck: () => void;
};

type PeerConnection = {
  pc: RTCPeerConnection;
  peer: LivePeer;
  /**
   * The channel this connection is negotiated on, in BOTH directions. For
   * host↔viewer that is the viewer's inbox, which is precisely why a viewer
   * never learns the host's topic. See connectionTopic() in lib/live-signal.
   */
  topic: string;
  /** Our outbound senders, one per slot. Empty for a viewer. */
  senders: Partial<Record<MediaSlot, RTCRtpSender>>;
  streams: Partial<Record<MediaSlot, MediaStream>>;
  /** Which slots to render — `slotIsActive` over the two fields below. */
  active: Partial<Record<MediaSlot, boolean>>;
  /**
   * What the peer SAID it is sending, from its `media` messages. Authoritative
   * where present: only the sender can tell a detached slot from a quiet one.
   */
  announced: Partial<Record<MediaSlot, boolean>>;
  /** What the transport can see — a present, unmuted, live receiver track. */
  trackLive: Partial<Record<MediaSlot, boolean>>;
  /** Buffered ICE candidates, flushed together (see ICE_BATCH_MS). */
  pending: RTCIceCandidateInit[];
  flushTimer: ReturnType<typeof setTimeout> | null;
  /**
   * Candidates that arrived before the remote description was set. Adding one
   * too early throws, and dropping it can cost the connection on networks
   * where that candidate was the only viable path.
   */
  earlyCandidates: RTCIceCandidateInit[];
  state: ConnectionState;
  /** True once connected at least once — drives "reconnecting" vs "failed". */
  wasLive: boolean;
  /**
   * When the connection last stopped being live, or was created if it never
   * has been. Unlike `progressAt` it does not move while the connection
   * flaps between not-live states, so it measures how long the peer has been
   * gone rather than how long since the last ICE event.
   */
  downSince: number;
  /**
   * When the CURRENT negotiation attempt started. Re-stamped on every state
   * change, so the stuck-watchdog below measures "how long has it been
   * wedged" and not "how long has this call been running".
   */
  progressAt: number;
  /** When this connection object was built. */
  createdAt: number;
  /**
   * When it was last seen live (stamped on connecting and on leaving 'live'),
   * or null if it never was. What the pruning rules measure staleness from.
   */
  lastLiveAt: number | null;
};

/**
 * How long a connection may sit mid-negotiation before we rebuild it.
 *
 * A healthy connection is live in about a second. Past this, something was
 * lost — a signalling message that fell in the gap before the other side
 * subscribed, a tab that slept through the handshake — and nothing will
 * arrive to finish it, so the useful move is to throw it away and offer
 * again.
 *
 * Measured from `progressAt`, which advances on every state change. An
 * earlier version stamped it once at creation, which made the condition
 * trivially true for any connection older than 12 seconds: a routine ICE dip
 * into "disconnected" on a wifi handover would then be torn down by the very
 * next heartbeat instead of being allowed to recover on its own.
 */
const STUCK_MS = 12_000;

/**
 * How long an offer may sit unanswered before a fresh `host-online` from its
 * addressee makes us rebuild it on the spot. Short, because the case it
 * exists for is "they were not listening yet when we offered"; not zero, so
 * an offer that is simply still in flight is not thrown away.
 */
const UNANSWERED_OFFER_MS = 2_000;

/**
 * Floor on how often an untrusted stage message may make us re-announce.
 *
 * The stage channel is public by design (see lib/live-signal.ts), so anyone
 * signed in who can derive the topic can publish to it. Nothing there is
 * trusted — the only thing a stage message triggers is a re-announce, which
 * is idempotent — but without a floor a student could spam it and turn every
 * viewer into a server-action generator.
 */
const REANNOUNCE_FLOOR_MS = 3_000;

export function useLiveSession({
  kind,
  roomId,
  role,
  enabled,
  localStream,
  screenStream,
  cameraOn,
  micOn,
  join,
  announce,
  leave,
  listPeers,
}: {
  kind: "event" | "call";
  /** The raw event or invite id — also what the leave beacon names. */
  roomId: string;
  role: SignalRole;
  /** Gate the whole machine on the green room being done. */
  enabled: boolean;
  /** Camera + mic. Null for a viewer, who has nothing to send. */
  localStream: MediaStream | null;
  /** The screen share, when one is running. */
  screenStream: MediaStream | null;
  /**
   * Whether the host currently intends to send camera / mic.
   *
   * Passed in rather than read off `track.enabled` because a disabled track
   * still transmits — black frames and silence — which reaches a viewer as a
   * frozen picture rather than as "camera off". Turning these off detaches
   * the track instead, which mutes the receiver's track and lets the remote
   * UI say so.
   */
  cameraOn: boolean;
  micOn: boolean;
  join: () => Promise<JoinResult>;
  /**
   * The heartbeat. `joinedAs` is the role our credentials were minted with,
   * so the server can tell a host whose grant was removed mid-session
   * ('revoked') from one it should keep announcing.
   */
  announce: (joinedAs?: SignalRole) => Promise<PresenceResult>;
  leave: () => Promise<void>;
  listPeers: () => Promise<LivePeer[]>;
}): LiveSession & { refreshTracks: () => void } {
  const [state, setState] = useState<ConnectionState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [remotes, setRemotes] = useState<RemotePeer[]>([]);
  const [audienceCount, setAudienceCount] = useState<number | null>(null);
  const [joined, setJoined] = useState(false);
  const [topics, setTopics] = useState<{
    roomTopic: string | null;
    moderationTopic: string | null;
  }>({ roomTopic: null, moderationTopic: null });
  const [serverRole, setServerRole] = useState<SignalRole | null>(null);
  const [closed, setClosed] = useState<{ reason: CloseReason } | null>(null);
  const [joinFailed, setJoinFailed] = useState<{ reason: JoinRefusal } | null>(
    null,
  );

  const supabaseRef = useRef<SupabaseClient | null>(null);
  const credsRef = useRef<LiveCredentials | null>(null);
  const connections = useRef(new Map<string, PeerConnection>());
  /**
   * Every Realtime channel this session holds, keyed by topic.
   *
   * Deliberately owned by the session rather than by a connection. Channels
   * used to be torn down with their connection, which broke in two ways when
   * a stuck connection was rebuilt: realtime-js dedupes `channel(topic)` by
   * topic and only removes the old entry asynchronously, so the rebuild got
   * the SAME channel object back — re-registering a second handler on it (two
   * dispatches per message) and then stalling on `subscribe()` of a channel
   * mid-unsubscribe. Subscribing once per topic and keeping it for the life
   * of the session avoids the whole class.
   */
  const channels = useRef(new Map<string, RealtimeChannel>());
  /**
   * For a channel that belongs to exactly one peer, who that peer is.
   *
   * A host subscribes to each viewer's inbox. Without this pin, a student
   * could publish on THEIR OWN inbox with `from` set to another student's id
   * — a `bye` would then evict that student from the host's star. Messages
   * are only accepted from the peer whose topic they arrived on.
   */
  const topicOwner = useRef(new Map<string, string>());
  /**
   * Broadcasters who said `bye` with reason `leave` and have not signalled
   * since, by peer id. Only hosts are ever recorded here — a viewer leaving
   * is a headcount change, not something anybody draws.
   */
  const departed = useRef(new Map<string, LivePeer>());
  /** Peers this session has been connected to at least once. */
  const everLive = useRef(new Set<string>());
  /**
   * Bumped whenever a run starts or is torn down. A negotiation that awaited
   * something (a channel subscribe, createOffer) compares it on the way back
   * and closes its peer connection if the session it belonged to is gone —
   * otherwise a late signal could rebuild a connection after Leave that
   * nothing would ever close.
   */
  const runRef = useRef(0);
  const recheckRef = useRef<() => void>(() => {});
  const lastReannounce = useRef(0);
  const localRef = useRef<MediaStream | null>(localStream);
  const screenRef = useRef<MediaStream | null>(screenStream);
  const wantRef = useRef({ cameraOn, micOn });
  localRef.current = localStream;
  screenRef.current = screenStream;
  wantRef.current = { cameraOn, micOn };

  const isBroadcaster = role === "host";

  // --- UI projection -------------------------------------------------------
  const publish = useCallback(() => {
    const all = [...connections.current.values()];
    const shown: RemotePeer[] = all
      // A viewer is shown the hosts. A host is shown other hosts; the
      // audience is a count in the header, not a wall of tiles.
      .filter((c) => c.peer.role === "host")
      .map((c) => {
        // Only slots actually carrying media. A muted track is absent
        // rather than black — see the note at the top of this file.
        const streams: Partial<Record<MediaSlot, MediaStream>> = {};
        for (const slot of MEDIA_SLOTS) {
          if (c.active[slot] && c.streams[slot]) streams[slot] = c.streams[slot];
        }
        // A departed peer we are still (re)dialling — a 1:1 keeps trying the
        // other party — reads as "left" until the link is actually up, never
        // as a connecting tile that looks like they are here.
        const gone = departed.current.has(c.peer.peerId) && c.state !== "live";
        return {
          peerId: c.peer.peerId,
          name: c.peer.name,
          role: c.peer.role,
          state: gone ? ("left" as const) : c.state,
          seenLive: everLive.current.has(c.peer.peerId),
          downSince: c.state === "live" ? null : c.downSince,
          streams: gone ? {} : streams,
        };
      });
    // Departed broadcasters with no connection at all still get a "left"
    // entry, so the room can say "<name> left" instead of silently dropping
    // the tile and leaving the reader to wonder.
    for (const [peerId, peer] of departed.current) {
      if (connections.current.has(peerId) || peer.role !== "host") continue;
      shown.push({
        peerId,
        name: peer.name,
        role: peer.role,
        state: "left",
        seenLive: everLive.current.has(peerId),
        downSince: null,
        streams: {},
      });
    }
    setRemotes(shown);
    setAudienceCount(
      isBroadcaster && kind === "event"
        ? countLiveAudience(
            all.map((c) => ({ role: c.peer.role, state: c.state })),
          )
        : null,
    );
  }, [isBroadcaster, kind]);

  const recomputeOverall = useCallback(() => {
    const all = [...connections.current.values()];
    if (kind === "call") {
      // A 1:1 is live only while the other person is actually connected. A
      // lone party — the other side not here yet, or gone — is waiting, not
      // "live", whatever the connection map happens to hold.
      if (all.some((c) => c.state === "live")) setState("live");
      else if (all.some((c) => c.state === "reconnecting"))
        setState("reconnecting");
      else setState("connecting");
      return;
    }
    if (all.length === 0) {
      // A host alone is live — they are broadcasting, there is simply nobody
      // here yet. A viewer alone is still waiting for the host to start.
      setState(isBroadcaster ? "live" : "connecting");
      return;
    }
    if (all.some((c) => c.state === "live")) setState("live");
    else if (all.some((c) => c.state === "reconnecting")) setState("reconnecting");
    else if (all.every((c) => c.state === "failed")) setState("failed");
    else setState("connecting");
  }, [isBroadcaster, kind]);

  // --- signalling transport -----------------------------------------------
  const onSignalRef = useRef<(m: SignalMessage, expectFrom?: string) => void>(
    () => {},
  );

  /** Subscribe to a topic once, and keep it for the life of the session. */
  const ensureChannel = useCallback(
    async (topic: string, owner?: string): Promise<RealtimeChannel | null> => {
      const supabase = supabaseRef.current;
      if (!supabase || !topic) return null;
      if (owner) topicOwner.current.set(topic, owner);
      const existing = channels.current.get(topic);
      if (existing) return existing;

      const ch = supabase.channel(topic);
      // Registered before the entry is published, and the entry is published
      // before the await, so a teardown mid-subscribe still finds and removes
      // it rather than orphaning a permanently subscribed channel.
      ch.on("broadcast", { event: SIGNAL_EVENT }, (m) => {
        onSignalRef.current(
          m.payload as SignalMessage,
          topicOwner.current.get(topic),
        );
      });
      channels.current.set(topic, ch);
      await subscribe(ch);
      return ch;
    },
    [],
  );

  const sendOn = useCallback(
    async (topic: string, message: SignalMessage) => {
      const supabase = supabaseRef.current;
      if (!supabase || !topic) return;
      const held = channels.current.get(topic);
      if (held) {
        await held.send({
          type: "broadcast",
          event: SIGNAL_EVENT,
          payload: message,
        });
        return;
      }
      // A topic we do not hold: send once (realtime-js falls back to its REST
      // endpoint for an unjoined channel) and remove the channel again. It
      // used to be left registered, so every such send leaked a channel that
      // no teardown knew about.
      const ch = supabase.channel(topic, {
        config: { broadcast: { ack: false } },
      });
      try {
        await ch.send({ type: "broadcast", event: SIGNAL_EVENT, payload: message });
      } finally {
        void supabase.removeChannel(ch).catch(() => {});
      }
    },
    [],
  );

  // --- local media ---------------------------------------------------------
  /**
   * Tell one peer which of our slots are live.
   *
   * Best-effort and unacknowledged, like every other signal here: a lost
   * message costs a stale label until the next toggle or reconnect, never
   * the media itself. Skipped entirely before the connection has a topic.
   */
  const announceMedia = useCallback(
    (conn: PeerConnection, slots: Record<MediaSlot, boolean>) => {
      const creds = credsRef.current;
      if (!creds || !conn.topic) return;
      void sendOn(conn.topic, { t: "media", from: creds.peerId, slots }).catch(
        () => {},
      );
    },
    [sendOn],
  );

  /**
   * Put the current camera/mic/screen tracks onto a connection's senders.
   *
   * A slot the host has turned off is detached (`replaceTrack(null)`) rather
   * than left attached-but-disabled. Both stop the picture, but only
   * detaching mutes the RECEIVER's track, which is what lets a viewer's tile
   * say "camera off" instead of showing a black rectangle.
   */
  const attachLocalTracks = useCallback(
    (conn: PeerConnection) => {
      if (!isBroadcasterRef.current) return;
      const { cameraOn: wantCam, micOn: wantMic } = wantRef.current;
      const want: Record<MediaSlot, MediaStreamTrack | null> = {
        camera: wantCam ? (localRef.current?.getVideoTracks()[0] ?? null) : null,
        screen: screenRef.current?.getVideoTracks()[0] ?? null,
        audio: wantMic ? (localRef.current?.getAudioTracks()[0] ?? null) : null,
      };
      for (const slot of MEDIA_SLOTS) {
        const sender = conn.senders[slot];
        if (!sender || sender.track === want[slot]) continue;
        // Rejected only in states where the connection is going away anyway.
        sender.replaceTrack(want[slot]).catch(() => {});
      }
      // And say what we just did. Detaching a sender stops the packets
      // without reliably muting the remote track, so without this the other
      // end has no way to tell "camera off" from "frozen", and no way to
      // tell a screen slot that has never carried anything from one that
      // has gone quiet. Sent on every call rather than only on a change:
      // this also runs when a connection is built, which is exactly when a
      // newly arrived viewer needs the current state.
      announceMedia(conn, {
        camera: !!want.camera,
        screen: !!want.screen,
        audio: !!want.audio,
      });
    },
    [announceMedia],
  );
  const isBroadcasterRef = useRef(isBroadcaster);
  isBroadcasterRef.current = isBroadcaster;

  const refreshTracks = useCallback(() => {
    for (const conn of connections.current.values()) attachLocalTracks(conn);
  }, [attachLocalTracks]);

  useEffect(() => {
    refreshTracks();
  }, [localStream, screenStream, cameraOn, micOn, refreshTracks]);

  // --- connection lifecycle ------------------------------------------------
  /**
   * Drop one connection. `bye` says whether (and why) to tell the far side:
   * `leave` when this person is going, `rebuild` when only this connection is
   * being replaced, `false` when the far side already knows (it said bye, or
   * it is gone).
   */
  const disconnectFrom = useCallback(
    (peerId: string, bye: false | "leave" | "rebuild") => {
      const conn = connections.current.get(peerId);
      if (!conn) return;
      connections.current.delete(peerId);
      if (conn.flushTimer) clearTimeout(conn.flushTimer);
      const creds = credsRef.current;
      if (bye && creds) {
        // Addressed: on a viewer's inbox every connected host is listening,
        // and a rebuild of ONE of those links must not drop the others.
        void sendOn(conn.topic, {
          t: "bye",
          from: creds.peerId,
          reason: bye,
          to: peerId,
        }).catch(() => {});
      }
      // The channel is NOT removed here — it belongs to the session, and
      // tearing it down under a rebuild is what used to double-register
      // handlers and stall the retry. Teardown removes them all.
      try {
        conn.pc.close();
      } catch {
        /* already closed */
      }
      publish();
      recomputeOverall();
    },
    [publish, recomputeOverall, sendOn],
  );
  const disconnectFromRef = useRef(disconnectFrom);
  disconnectFromRef.current = disconnectFrom;

  /**
   * Build the connection to one peer.
   *
   * Idempotent per peer id: a duplicate lobby message, a heartbeat that
   * re-announces someone already connected, and a reconcile poll all land
   * here, and only the first creates anything — unless the existing
   * connection is wedged, in which case this is also the retry. `force`
   * treats any connection that is not live as wedged; it is only passed when
   * the peer has just told us they (re)arrived.
   */
  const connectTo = useCallback(
    async (peer: LivePeer, opts?: { force?: boolean }) => {
      const creds = credsRef.current;
      const supabase = supabaseRef.current;
      if (!creds || !supabase || peer.peerId === creds.peerId) return;
      const run = runRef.current;

      const existing = connections.current.get(peer.peerId);
      if (existing) {
        const wedged =
          existing.state !== "live" &&
          (opts?.force || Date.now() - existing.progressAt > STUCK_MS);
        if (!wedged) return;
        // Tell the far side, so it drops its half instead of holding a dead
        // peer connection that our new offer would be applied to.
        disconnectFromRef.current(peer.peerId, "rebuild");
      }

      // A viewer only ever connects to a host. The server already refuses to
      // tell a viewer that another viewer exists, so reaching here with one
      // would mean the disclosure rule had already failed — this keeps that
      // from becoming a visible connection on top of it.
      if (!isBroadcasterRef.current && peer.role !== "host") return;

      const topic = connectionTopic({
        selfRole: role,
        selfInbox: creds.inboxTopic,
        peerRole: peer.role,
        peerInbox: peer.inbox,
      });

      const pc = new RTCPeerConnection({
        iceServers: creds.iceServers as RTCIceServer[],
        iceCandidatePoolSize: 1,
      });

      const now = Date.now();
      const conn: PeerConnection = {
        pc,
        peer,
        topic,
        senders: {},
        streams: {},
        active: {},
        announced: {},
        trackLive: {},
        pending: [],
        flushTimer: null,
        earlyCandidates: [],
        state: "connecting",
        wasLive: false,
        downSince: now,
        progressAt: now,
        createdAt: now,
        lastLiveAt: null,
      };
      connections.current.set(peer.peerId, conn);
      publish();

      /** Has this connection been orphaned (teardown, or a newer rebuild)? */
      const stale = () =>
        runRef.current !== run || connections.current.get(peer.peerId) !== conn;

      // The three handlers go on BEFORE anything is awaited.
      //
      // The connection is already in the map, so from this line on an offer
      // from this peer can find it and be applied to it — and one routinely
      // does: two hosts arriving together each bootstrap a `connectTo` for
      // the other, and the offerer's offer lands while the answerer is still
      // awaiting the channel subscribe below. The handlers used to be
      // attached after that await, so the offer was applied to a peer
      // connection with no `ontrack`: its three track events were lost, the
      // early ICE candidates with them, and the link came up with no streams
      // for its whole life — a co-host shown camera-off and inaudible, with
      // nothing that would ever rebuild a connection that reports itself
      // live. None of the handlers needs the subscription: each checks
      // `stale()` or writes only to `conn`, and the ICE flush's `sendOn`
      // finds the channel `ensureChannel` registers before it awaits (an
      // unjoined broadcast goes over REST, as the answer already does).

      pc.ontrack = (ev) => {
        const slot = slotForMid(ev.transceiver?.mid ?? null);
        if (!slot) return;
        // One MediaStream per slot, reused across track replacements so the
        // <video> keeps playing instead of flashing black.
        const stream = conn.streams[slot] ?? new MediaStream();
        for (const t of stream.getTracks()) stream.removeTrack(t);
        stream.addTrack(ev.track);
        conn.streams[slot] = stream;

        // All three transceivers exist from the first offer, so this fires
        // for the screen slot even when nobody is presenting — with a MUTED
        // track. Presence follows the mute state, not the object's existence.
        const sync = () => {
          conn.trackLive[slot] =
            !ev.track.muted && ev.track.readyState === "live";
          conn.active[slot] = slotIsActive({
            slot,
            announced: conn.announced[slot],
            trackLive: conn.trackLive[slot]!,
          });
          publish();
        };
        ev.track.addEventListener("unmute", sync);
        ev.track.addEventListener("mute", sync);
        ev.track.addEventListener("ended", sync);
        sync();
      };

      pc.onicecandidate = (ev) => {
        if (!ev.candidate) return;
        conn.pending.push(ev.candidate.toJSON());
        if (conn.flushTimer) return;
        // Batched: a connection trickles 5-15 candidates in a burst, and one
        // Realtime message each turns a two-second handshake into a flood.
        conn.flushTimer = setTimeout(() => {
          conn.flushTimer = null;
          const candidates = conn.pending.splice(0);
          if (candidates.length === 0 || stale()) return;
          void sendOn(conn.topic, {
            t: "ice",
            from: creds.peerId,
            candidates,
            // Addressed, like the answer: a viewer's candidates for one host
            // arrive on an inbox every connected host is listening to.
            to: peer.peerId,
          }).catch(() => {});
        }, ICE_BATCH_MS);
      };

      pc.onconnectionstatechange = () => {
        // A replaced or orphaned connection reports its own close; that is
        // not news about the peer.
        if (stale()) return;
        const s = pc.connectionState;
        const at = Date.now();
        // Any transition is progress: it resets the wedged clock, so the
        // watchdog only fires on a connection that is genuinely going nowhere.
        conn.progressAt = at;
        if (conn.state === "live") conn.lastLiveAt = at;
        const before = conn.state;
        if (s === "connected") {
          conn.state = "live";
          conn.wasLive = true;
          conn.lastLiveAt = at;
          everLive.current.add(peer.peerId);
          // Connected to them again, so whatever "left" we remembered is over.
          departed.current.delete(peer.peerId);
        } else if (s === "disconnected") {
          // Not fatal on its own — ICE routinely dips through "disconnected"
          // on a network change and recovers by itself.
          conn.state = "reconnecting";
        } else if (s === "failed" || s === "closed") {
          conn.state = conn.wasLive ? "reconnecting" : "failed";
        }
        if (before === "live" && conn.state !== "live") conn.downSince = Date.now();
        publish();
        recomputeOverall();
      };

      // A host talking to a viewer negotiates on the VIEWER's inbox, so it
      // subscribes there — pinned to that viewer, so nothing arriving on it
      // can claim to be from someone else. Our own inbox is already
      // subscribed and is open to any host, so it carries no owner pin.
      if (topic !== creds.inboxTopic) {
        await ensureChannel(topic, peer.peerId);
        // The session may have been torn down (or this connection replaced)
        // while we waited on the subscribe. Nothing would ever close a peer
        // connection finished after that point, so close it here.
        if (stale()) {
          try {
            pc.close();
          } catch {
            /* already closed */
          }
          return;
        }
      }

      // Whoever offers creates the transceivers, in the fixed slot order, so
      // both ends agree that mid 0 is camera, 1 is screen, 2 is audio.
      if (shouldOffer(creds.peerId, role, peer)) {
        // Transceiver creation is inside the try as well: on a peer connection
        // that teardown closed a moment ago, addTransceiver throws, and that
        // used to surface as an unhandled rejection after Leave.
        try {
          for (const slot of MEDIA_SLOTS) {
            const direction: RTCRtpTransceiverDirection = isBroadcasterRef.current
              ? peer.role === "host"
                ? "sendrecv" // two broadcasters: a 1:1
                : "sendonly" // host -> viewer
              : "recvonly";
            const tr = pc.addTransceiver(slot === "audio" ? "audio" : "video", {
              direction,
            });
            conn.senders[slot] = tr.sender;
          }
          attachLocalTracks(conn);
          const offer = await pc.createOffer();
          if (stale()) return;
          await pc.setLocalDescription(offer);
          if (stale()) return;
          await sendOn(conn.topic, {
            t: "offer",
            from: creds.peerId,
            name: creds.name,
            sdp: offer.sdp ?? "",
          });
        } catch (err) {
          // Torn down under us is not an error anyone needs to read.
          if (stale()) return;
          if (conn.state === "live") conn.downSince = Date.now();
          conn.state = "failed";
          conn.progressAt = Date.now();
          publish();
          setError(readableError(err));
        }
      }
    },
    [attachLocalTracks, ensureChannel, publish, recomputeOverall, role, sendOn],
  );

  /** A peer we know how to reach, from any of the places we might know them. */
  const knownPeer = useCallback((peerId: string): LivePeer | null => {
    return (
      connections.current.get(peerId)?.peer ??
      credsRef.current?.peers.find((p) => p.peerId === peerId) ??
      departed.current.get(peerId) ??
      null
    );
  }, []);

  const onSignal = useCallback(
    async (msg: SignalMessage, expectFrom?: string) => {
      const creds = credsRef.current;
      if (!creds || !msg || msg.from === creds.peerId) return;
      // A channel that belongs to one peer only accepts that peer. Without
      // this, a student publishing on their own inbox could set `from` to a
      // classmate's id and have the host evict them.
      if (expectFrom && msg.from !== expectFrom) return;
      // ...and a message that peer addressed to somebody else is not ours.
      // Every host connected to a viewer listens on that viewer's inbox, so
      // with a staff host and a guest speaker both on air, each hears the
      // viewer's answer, candidates and byes for the OTHER one too. See `to`
      // on SignalMessage; a message with no `to` (an older tab) still counts.
      if (!isAddressedTo(msg, creds.peerId)) return;

      if (msg.t === "bye") {
        // `leave` is a person going; anything else (`rebuild`, or an older
        // tab that does not say) is only this connection being replaced.
        if (msg.reason === "leave") {
          const peer = knownPeer(msg.from);
          if (peer && peer.role === "host") departed.current.set(msg.from, peer);
        }
        disconnectFrom(msg.from, false);
        // disconnectFrom publishes only when a connection existed; a
        // departure is news either way.
        publish();
        return;
      }

      if (msg.t === "offer") {
        // They are here: whatever "left" we remembered is over.
        departed.current.delete(msg.from);
        // One offer per connection, ever (see the header). A second offer on
        // a connection that has already applied one is the peer's NEW
        // connection — they reloaded, or rebuilt and their `bye` was lost —
        // and belongs on a fresh one of ours.
        const existing = connections.current.get(msg.from);
        if (existing?.pc.remoteDescription) disconnectFrom(msg.from, false);
        // An offer is also how a viewer first learns a host exists: the
        // server never told it, so the peer is constructed from the message.
        // It answers on the topic the offer arrived on — for a viewer that is
        // its own inbox, so it never needs to know the host's.
        if (!connections.current.has(msg.from)) {
          await connectTo(
            creds.peers.find((p) => p.peerId === msg.from) ?? {
              peerId: msg.from,
              name: msg.name,
              role: "host",
              inbox: creds.inboxTopic,
            },
          );
        }
        const conn = connections.current.get(msg.from);
        if (!conn) return;
        try {
          await conn.pc.setRemoteDescription({ type: "offer", sdp: msg.sdp });
          for (const c of conn.earlyCandidates.splice(0)) {
            await conn.pc.addIceCandidate(c).catch(() => {});
          }
          // Map the transceivers the offer created onto our slots.
          //
          // The direction fix-up is load-bearing and easy to miss: when
          // setRemoteDescription builds a transceiver from a remote offer it
          // makes it RECVONLY, whatever the offer asked for, and
          // `replaceTrack` on a recvonly sender is accepted while sending
          // nothing. Without this a 1:1 connects and exactly one direction
          // carries video — a bug a webinar test can never catch, because
          // there the viewer is MEANT to be recvonly.
          for (const tr of conn.pc.getTransceivers()) {
            const slot = slotForMid(tr.mid);
            if (!slot) continue;
            conn.senders[slot] = tr.sender;
            if (isBroadcasterRef.current && tr.direction === "recvonly") {
              tr.direction = "sendrecv";
            }
          }
          attachLocalTracks(conn);
          const answer = await conn.pc.createAnswer();
          await conn.pc.setLocalDescription(answer);
          await sendOn(conn.topic, {
            t: "answer",
            from: creds.peerId,
            name: creds.name,
            sdp: answer.sdp ?? "",
            // For the host whose offer this answers, and nobody else. On a
            // viewer's inbox a second host is listening, and it used to
            // apply this SDP to its own half-built connection.
            to: conn.peer.peerId,
          });
        } catch (err) {
          // Torn down or replaced mid-answer is not a failure to report.
          if (connections.current.get(msg.from) !== conn || !credsRef.current) {
            return;
          }
          if (conn.state === "live") conn.downSince = Date.now();
          conn.state = "failed";
          conn.progressAt = Date.now();
          publish();
          setError(readableError(err));
        }
        return;
      }

      const conn = connections.current.get(msg.from);
      if (!conn) return;

      if (msg.t === "media") {
        // The sender's own account of what it is sending, which beats
        // anything the receiver can infer. This is what turns a camera
        // switched off into "the host's camera is off" rather than a frozen
        // last frame, and what keeps the presenting layout away until
        // somebody is genuinely presenting.
        for (const slot of MEDIA_SLOTS) {
          const announced = msg.slots?.[slot];
          if (typeof announced !== "boolean") continue;
          conn.announced[slot] = announced;
          conn.active[slot] = slotIsActive({
            slot,
            announced,
            trackLive: conn.trackLive[slot] ?? false,
          });
        }
        publish();
        return;
      }

      if (msg.t === "answer") {
        departed.current.delete(msg.from);
        // Only onto our own outstanding offer. A connection that is already
        // `stable` has had its answer; this one is a duplicate, a straggler,
        // or — from a tab older than `to` — another host's. Applying it
        // throws "Called in wrong state: stable", which used to land in a
        // permanent error banner over a webinar that was working fine.
        if (!shouldApplyAnswer(conn.pc.signalingState)) return;
        try {
          await conn.pc.setRemoteDescription({ type: "answer", sdp: msg.sdp });
          for (const c of conn.earlyCandidates.splice(0)) {
            await conn.pc.addIceCandidate(c).catch(() => {});
          }
        } catch {
          // A real refusal of our own offer's answer. Marked failed rather
          // than bannered: a host prunes a failed viewer link on its next
          // heartbeat and the viewer's re-announce builds a fresh one, and
          // between two hosts the heartbeat's wedged check rebuilds it — at
          // once, because `progressAt` is wound back rather than restarted.
          // That rebuild IS the recovery, and a banner would outlive it.
          if (connections.current.get(msg.from) === conn && credsRef.current) {
            conn.state = "failed";
            conn.progressAt = 0;
            recomputeOverall();
          }
        }
        publish();
        return;
      }

      if (msg.t === "ice") {
        for (const raw of msg.candidates as RTCIceCandidateInit[]) {
          if (!conn.pc.remoteDescription) {
            // Too early to add — hold it rather than drop it. On some
            // networks the held candidate is the only one that works.
            conn.earlyCandidates.push(raw);
            continue;
          }
          await conn.pc.addIceCandidate(raw).catch(() => {});
        }
      }
    },
    [
      attachLocalTracks,
      connectTo,
      disconnectFrom,
      knownPeer,
      publish,
      recomputeOverall,
      sendOn,
    ],
  );

  onSignalRef.current = (m, expectFrom) => void onSignal(m, expectFrom);

  // --- session lifecycle ---------------------------------------------------
  useEffect(() => {
    if (!enabled) return;

    /**
     * Per-run cancellation token.
     *
     * Deliberately a local `let` and not a shared ref: a ref is re-armed by
     * the next mount, which under StrictMode let a torn-down run's async
     * bootstrap continue and install intervals that nothing would ever clear.
     * Every handler this run installs checks it first, so a message that was
     * already queued when teardown ran is dropped rather than acted on.
     */
    let cancelled = false;
    let tornDown = false;
    runRef.current += 1;
    const timers: ReturnType<typeof setInterval>[] = [];
    /** Install a timer, or immediately drop it if teardown already ran. */
    const addTimer = (t: ReturnType<typeof setInterval>) => {
      if (cancelled) clearInterval(t);
      else timers.push(t);
    };
    let strikes = 0;
    let lastCheck = 0;
    let trailing: ReturnType<typeof setTimeout> | null = null;

    // A fresh run starts from nothing, whatever the last one left behind.
    departed.current.clear();
    everLive.current.clear();
    setClosed(null);
    setJoinFailed(null);
    setServerRole(null);

    /**
     * End this run: the one teardown, whoever calls it. Idempotent, because
     * the server can close the session and the room can then disable it.
     */
    const teardown = () => {
      if (tornDown) return;
      tornDown = true;
      cancelled = true;
      runRef.current += 1;
      for (const t of timers) clearInterval(t);
      if (trailing) clearTimeout(trailing);
      // `bye: leave` on every connection, while the credentials and channels
      // still exist to send it on. The far side then draws "left" (or "the
      // host stepped away") instead of waiting out ICE on a frozen frame.
      for (const peerId of [...connections.current.keys()]) {
        disconnectFromRef.current(peerId, "leave");
      }
      const supabase = supabaseRef.current;
      for (const ch of channels.current.values()) {
        try {
          void supabase?.removeChannel(ch);
        } catch {
          /* already gone */
        }
      }
      channels.current.clear();
      topicOwner.current.clear();
      departed.current.clear();
      // Forgotten last, so nothing that arrives from here on — a late stage
      // message, a lobby arrival, an offer — can find credentials to act on.
      credsRef.current = null;
      supabaseRef.current = null;
      setRemotes([]);
      setAudienceCount(null);
      setJoined(false);
      setTopics({ roomTopic: null, moderationTopic: null });
      setState("idle");
      void leave().catch(() => {});
    };

    /** The server said this session is over. */
    const closeWith = (reason: CloseReason) => {
      if (cancelled) return;
      teardown();
      setClosed({ reason });
    };

    /** Act on one status answer (a heartbeat, or a re-check). */
    const onStatus = (res: PresenceResult | null) => {
      if (cancelled) return;
      const next = nextStatusAction(res?.status ?? null, strikes);
      strikes = next.strikes;
      if (next.close && res) closeWith(res.status as CloseReason);
    };

    /** Announce and act on the answer. Never rejects. */
    const runAnnounce = async () => {
      const held = credsRef.current;
      if (cancelled || !held) return;
      const res = await announce(held.role).catch(() => null);
      onStatus(res);
    };

    /**
     * Re-ask the server now — the answer to a `room-changed` hint. Throttled
     * to one per ROOM_CHANGED_THROTTLE_MS with a trailing call, so a burst of
     * hints (forged or real) costs one query a second, and a real hint that
     * lands just after a forged one is still acted on.
     */
    const recheck = () => {
      if (cancelled) return;
      const wait = lastCheck + ROOM_CHANGED_THROTTLE_MS - Date.now();
      if (wait > 0) {
        trailing ??= setTimeout(() => {
          trailing = null;
          recheck();
        }, wait);
        return;
      }
      lastCheck = Date.now();
      void runAnnounce();
    };
    recheckRef.current = recheck;

    /**
     * Housekeeping on every heartbeat.
     *
     * Hosts drop VIEWER connections that are dead or have not been live for
     * PEER_TIMEOUT_MS (a laptop that slept sends no bye) — a viewer who is
     * really still there re-announces and gets a fresh one. Viewers drop a
     * host connection that has been down for two stuck-periods, so the host's
     * next offer lands on a fresh connection and the stage can say the host
     * stepped away instead of holding a frozen frame.
     */
    const prune = () => {
      const now = Date.now();
      for (const c of [...connections.current.values()]) {
        if (isBroadcasterRef.current) {
          if (
            shouldPruneConnection({
              peerRole: c.peer.role,
              state: c.state,
              lastLiveAt: c.lastLiveAt,
              createdAt: c.createdAt,
              now,
            })
          ) {
            disconnectFromRef.current(c.peer.peerId, false);
          }
        } else if (
          c.peer.role === "host" &&
          c.state !== "live" &&
          now - (c.lastLiveAt ?? c.createdAt) > 2 * STUCK_MS
        ) {
          disconnectFromRef.current(c.peer.peerId, false);
        }
      }
    };

    (async () => {
      try {
        setState("connecting");
        setError(null);

        const result = await join().catch((err) => {
          setError(readableError(err));
          return null;
        });
        if (cancelled) return;
        if (!result) {
          setState("failed");
          setJoinFailed({ reason: "error" });
          setError((e) => e ?? "You can't join this room right now.");
          return;
        }
        if (!result.ok) {
          const reason = closeReasonForRefusal(result.reason);
          setState(reason ? "idle" : "failed");
          if (reason) setClosed({ reason });
          else {
            setJoinFailed({ reason: result.reason });
            setError(refusalText(result.reason));
          }
          return;
        }
        const creds = result.creds;
        credsRef.current = creds;
        setServerRole(result.role);
        // Published to the UI so the text panels can subscribe. Set before any
        // channel work below, so a panel mounting alongside the room does not
        // have to wait out the whole media handshake to start listening.
        setTopics({
          roomTopic: creds.roomTopic,
          moderationTopic: creds.moderationTopic,
        });

        const supabase = createClient();
        supabaseRef.current = supabase;

        // My inbox: every offer/answer/candidate addressed to me — and, when I
        // am a viewer, the line I answer on too. No owner pin: only a host can
        // publish here, and any host is legitimate.
        await ensureChannel(creds.inboxTopic);
        if (cancelled) return;

        // The stage: room-wide hints, heard by everyone. Nothing here is
        // trusted (the topic is derivable from the room id by design), so
        // each message only makes us do something we were allowed to do
        // anyway — re-announce, re-check the server, or retry a connection
        // that is not up. See StageMessage in lib/live-signal.ts.
        const supabaseStage = supabase.channel(creds.stageTopic);
        supabaseStage.on("broadcast", { event: SIGNAL_EVENT }, (m) => {
          if (cancelled) return;
          const msg = m.payload as StageMessage;
          if (!msg) return;
          if (msg.t === "room-changed") {
            // Ended, reopened, cancelled or completed — ask the server which.
            recheck();
            return;
          }
          if (msg.t !== "host-online" || msg.hostId === creds.peerId) return;
          if (isBroadcasterRef.current) {
            // Another broadcaster came up. Only a host is ever given a host's
            // inbox, so only a host can dial one directly.
            const known = knownPeer(msg.hostId);
            if (known) {
              departed.current.delete(msg.hostId);
              const existing = connections.current.get(msg.hostId);
              // Our offer to them has been sitting unanswered — they were not
              // listening yet when we sent it — so rebuild it NOW rather than
              // up to a heartbeat later. Never touches a live connection, so
              // a forged host-online cannot tear anything down.
              const stalled =
                !!existing &&
                existing.state !== "live" &&
                (existing.state === "failed" ||
                  (existing.pc.signalingState === "have-local-offer" &&
                    Date.now() - existing.createdAt > UNANSWERED_OFFER_MS));
              void connectTo(known, { force: stalled });
              publish();
            }
          }
          const now = Date.now();
          if (now - lastReannounce.current < REANNOUNCE_FLOOR_MS) return;
          lastReannounce.current = now;
          // A host came up. Re-announce so it discovers us now rather than at
          // our next heartbeat — this is what makes a room of waiting students
          // assemble the instant the host presses Start.
          void runAnnounce();
        });
        channels.current.set(creds.stageTopic, supabaseStage);
        await subscribe(supabaseStage);
        if (cancelled) return;

        // The lobby: arrivals, hosts only.
        if (creds.lobbyTopic) {
          const lobby = supabase.channel(creds.lobbyTopic);
          lobby.on("broadcast", { event: SIGNAL_EVENT }, (m) => {
            if (cancelled) return;
            const msg = m.payload as LobbyMessage;
            if (!msg) return;
            if (msg.t === "peer-online" && msg.peerId !== creds.peerId) {
              departed.current.delete(msg.peerId);
              void connectTo({
                peerId: msg.peerId,
                name: msg.name,
                role: msg.role,
                inbox: msg.inbox,
              });
            } else if (msg.t === "peer-offline") {
              // The server's word that they left (leaveRoom / the beacon). A
              // co-host is remembered as departed; a viewer is just gone.
              const peer = knownPeer(msg.peerId);
              if (peer && peer.role === "host") {
                departed.current.set(msg.peerId, peer);
              }
              disconnectFromRef.current(msg.peerId, false);
              publish();
            }
          });
          channels.current.set(creds.lobbyTopic, lobby);
          await subscribe(lobby);
          if (cancelled) return;
        }

        // Say I'm hosting, so anyone already waiting re-announces at once.
        if (isBroadcasterRef.current && creds.stageProof) {
          await supabaseStage.send({
            type: "broadcast",
            event: SIGNAL_EVENT,
            payload: {
              t: "host-online",
              hostId: creds.peerId,
              name: creds.name,
              proof: creds.stageProof,
            } satisfies StageMessage,
          });
        }
        if (cancelled) return;

        // The heartbeat goes in BEFORE the first announce, so a first announce
        // that fails (a blip, a cold function) costs twelve seconds instead of
        // stalling the session forever with no retry installed.
        //
        // It is the retry path as well as the keepalive: every BROADCASTER the
        // server told us about is re-attempted, and connectTo's wedged check
        // makes that a no-op for healthy connections and a rebuild for stuck
        // ones. A 1:1 has no reconcile poll, so without this a single lost
        // offer would deadlock the call forever — and a 1:1 keeps dialling the
        // other party even after they left, drawing them as "left" until they
        // are actually back. In a webinar a departed co-host is not re-dialled
        // until they signal again, and viewers are never dialled from here at
        // all: a viewer who is still present re-announces, which reaches us
        // through the lobby.
        //
        // And every OTHER broadcaster this one is connected to, not just the
        // join-time roster. A host who arrived after us was found through the
        // lobby and is not in `held.peers`; if they then vanish without a
        // goodbye (battery, crash, closed lid — no pagehide, so no bye and no
        // peer-offline), their connection sits in "reconnecting" forever with
        // nothing to reconnect to. In a webinar that is a co-host the recorder
        // election keeps counting as present — possibly the elected recorder,
        // recording nothing while everyone else stands down for them. Retried
        // here, a wedged connection is rebuilt to "connecting" like any other,
        // which the election stops counting once settling is over.
        addTimer(
          setInterval(() => {
            if (cancelled) return;
            void runAnnounce();
            const held = credsRef.current;
            if (held) {
              const dial = new Map<string, LivePeer>();
              for (const peer of held.peers) dial.set(peer.peerId, peer);
              if (isBroadcasterRef.current) {
                for (const c of connections.current.values()) {
                  if (!dial.has(c.peer.peerId)) dial.set(c.peer.peerId, c.peer);
                }
              }
              for (const peer of dial.values()) {
                if (peer.role !== "host") continue;
                if (kind === "event" && departed.current.has(peer.peerId)) {
                  continue;
                }
                void connectTo(peer);
              }
            }
            prune();
            publish();
            recomputeOverall();
          }, HEARTBEAT_MS),
        );

        // Reconcile is the backstop for a webinar host, catching whatever a
        // dropped lobby message lost. Hosts only — it is the one call that
        // returns the audience.
        if (isBroadcasterRef.current && kind === "event") {
          addTimer(
            setInterval(() => {
              if (cancelled) return;
              void listPeers()
                .then((peers) => {
                  if (cancelled) return;
                  for (const p of peers) {
                    if (p.role === "host" && departed.current.has(p.peerId)) {
                      continue;
                    }
                    void connectTo(p);
                  }
                })
                .catch(() => {});
            }, HEARTBEAT_MS * 2),
          );
        }

        // ONLY NOW announce. Every channel above is subscribed, so the offer a
        // host sends in response cannot land before we are listening. joinRoom
        // deliberately does not announce for exactly this reason — doing it
        // there raced the subscription and silently dropped the offer, leaving
        // the host at `have-local-offer` and the student with no connection.
        await runAnnounce();
        if (cancelled) return;

        for (const peer of creds.peers) void connectTo(peer);
        recomputeOverall();
        // After the loop, not before: connectTo publishes each peer
        // synchronously, so by this line `remotes` names everyone the server
        // said was here.
        setJoined(true);
      } catch (err) {
        // Anything the bootstrap did not expect. Said out loud, with a retry
        // offered by the room, rather than a spinner that never resolves.
        if (cancelled) return;
        setState("failed");
        setJoinFailed({ reason: "error" });
        setError(readableError(err));
      }
    })();

    return teardown;
    // The server-action props are stable references from the page. Including
    // them would tear down every live connection on each render, so they are
    // deliberately omitted.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, roomId, kind]);

  // Closing the tab counts as Leave: `bye` (reason leave) on every connection,
  // so the far side draws "left" at once, and a beacon to /api/live/leave for
  // the server's half (markLeft, peer-offline). A beacon rather than the
  // `leave` server action, which the browser usually aborts on unload.
  // `pagehide` rather than `beforeunload`: it fires on mobile Safari's
  // back-forward cache path, which `beforeunload` does not.
  useEffect(() => {
    if (!enabled) return;
    const onHide = () => {
      const creds = credsRef.current;
      if (!creds) return;
      for (const conn of connections.current.values()) {
        void sendOn(conn.topic, {
          t: "bye",
          from: creds.peerId,
          reason: "leave",
          to: conn.peer.peerId,
        }).catch(() => {});
      }
      beaconLeave(kind, roomId);
    };
    // Back from the back-forward cache, the page would resume a session every
    // peer has already been told is over. A reload goes back through the
    // green room, which is what a refresh does too.
    const onShow = (e: PageTransitionEvent) => {
      if (e.persisted) window.location.reload();
    };
    window.addEventListener("pagehide", onHide);
    window.addEventListener("pageshow", onShow);
    return () => {
      window.removeEventListener("pagehide", onHide);
      window.removeEventListener("pageshow", onShow);
    };
  }, [enabled, kind, roomId, sendOn]);

  const recheck = useCallback(() => recheckRef.current(), []);

  return useMemo(
    () => ({
      state,
      remotes,
      joined,
      audienceCount,
      error,
      refreshTracks,
      roomTopic: topics.roomTopic,
      moderationTopic: topics.moderationTopic,
      serverRole,
      closed,
      joinFailed,
      recheck,
    }),
    [
      state,
      remotes,
      joined,
      audienceCount,
      error,
      refreshTracks,
      topics,
      serverRole,
      closed,
      joinFailed,
      recheck,
    ],
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Who offers, so both sides independently agree without asking.
 *
 * A broadcaster offers to a viewer — the viewer cannot, having no media and
 * no knowledge of anyone until an offer arrives. Two broadcasters compare ids
 * and the smaller offers. Deterministic on both sides, which is what makes
 * glare impossible rather than merely unlikely.
 */
function shouldOffer(
  selfId: string,
  selfRole: SignalRole,
  peer: LivePeer,
): boolean {
  if (selfRole !== "host") return false;
  if (peer.role === "viewer") return true;
  return selfId < peer.peerId;
}

/**
 * Which join refusals are terminal (the room is over for this person) and
 * which the room should offer a Retry for. Terminal ones become `closed`.
 */
function closeReasonForRefusal(reason: JoinRefusal): CloseReason | null {
  switch (reason) {
    case "ended":
    case "completed":
      return "ended";
    case "cancelled":
      return "cancelled";
    case "closed":
      return "closed";
    case "declined":
    case "no-access":
      return "revoked";
    default:
      // early, not-hosted, error
      return null;
  }
}

function refusalText(reason: JoinRefusal): string {
  switch (reason) {
    case "early":
      return "This room isn't open yet.";
    case "not-hosted":
      return "This event isn't hosted on batch0.";
    default:
      return "Couldn't reach the room — try again.";
  }
}

/**
 * Leave from a page that is going away. `sendBeacon` is the one request a
 * browser promises to deliver after unload; a string body goes as text/plain,
 * which needs no CORS preflight. `fetch` with `keepalive` is the fallback for
 * a browser that refuses the beacon (a queue limit, a privacy extension).
 */
function beaconLeave(kind: "event" | "call", id: string): void {
  const body = JSON.stringify({ kind, id });
  try {
    if (navigator.sendBeacon?.("/api/live/leave", body)) return;
  } catch {
    /* fall through to fetch */
  }
  try {
    void fetch("/api/live/leave", {
      method: "POST",
      body,
      keepalive: true,
      credentials: "same-origin",
      headers: { "content-type": "text/plain" },
    }).catch(() => {});
  } catch {
    /* nothing left to try on a page that is closing */
  }
}

/** Subscribe, resolving when the channel is actually joined. */
function subscribe(channel: RealtimeChannel): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    channel.subscribe((status) => {
      // Resolve even on error: Realtime retries on its own, and blocking the
      // join on a first-attempt failure would strand the participant.
      if (
        status === "SUBSCRIBED" ||
        status === "CHANNEL_ERROR" ||
        status === "TIMED_OUT"
      ) {
        done();
      }
    });
    setTimeout(done, 8000);
  });
}

function readableError(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  if (typeof err === "string" && err) return err;
  return "Something went wrong connecting to the room.";
}
