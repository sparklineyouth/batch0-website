"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import type { RealtimeChannel, SupabaseClient } from "@supabase/supabase-js";
import {
  connectionTopic,
  HEARTBEAT_MS,
  ICE_BATCH_MS,
  MEDIA_SLOTS,
  SIGNAL_EVENT,
  slotForMid,
  slotIsActive,
  type LobbyMessage,
  type MediaSlot,
  type SignalMessage,
  type SignalRole,
  type StageMessage,
} from "@/lib/live-signal";
import type { LiveCredentials, LivePeer } from "@/lib/live-rooms";

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
 */

export type ConnectionState =
  | "idle"
  | "connecting"
  | "live"
  /** Connected once, currently re-establishing. Not an error. */
  | "reconnecting"
  | "failed";

/** A remote participant as the UI sees them. */
export type RemotePeer = {
  peerId: string;
  name: string;
  role: SignalRole;
  state: ConnectionState;
  /**
   * Inbound tracks, by slot — present only while actually carrying media.
   * A slot whose track is muted is absent, not black.
   */
  streams: Partial<Record<MediaSlot, MediaStream>>;
};

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
   * How many viewers are watching, for the host's header. Always null for a
   * viewer — the audience count is the one number a webinar exists to keep
   * from them.
   */
  audienceCount: number | null;
  error: string | null;
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
   * When the CURRENT negotiation attempt started. Re-stamped on every state
   * change, so the stuck-watchdog below measures "how long has it been
   * wedged" and not "how long has this call been running".
   */
  progressAt: number;
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
  join: () => Promise<LiveCredentials | null>;
  announce: () => Promise<boolean>;
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
    setRemotes(
      all
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
          return {
            peerId: c.peer.peerId,
            name: c.peer.name,
            role: c.peer.role,
            state: c.state,
            streams,
          };
        }),
    );
    setAudienceCount(
      isBroadcaster ? all.filter((c) => c.peer.role === "viewer").length : null,
    );
  }, [isBroadcaster]);

  const recomputeOverall = useCallback(() => {
    const all = [...connections.current.values()];
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
  }, [isBroadcaster]);

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
      await supabase
        .channel(topic, { config: { broadcast: { ack: false } } })
        .send({ type: "broadcast", event: SIGNAL_EVENT, payload: message });
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
  const disconnectFrom = useCallback(
    (peerId: string, sayBye: boolean) => {
      const conn = connections.current.get(peerId);
      if (!conn) return;
      connections.current.delete(peerId);
      if (conn.flushTimer) clearTimeout(conn.flushTimer);
      const creds = credsRef.current;
      if (sayBye && creds) {
        void sendOn(conn.topic, { t: "bye", from: creds.peerId });
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
   * connection is wedged, in which case this is also the retry.
   */
  const connectTo = useCallback(
    async (peer: LivePeer) => {
      const creds = credsRef.current;
      const supabase = supabaseRef.current;
      if (!creds || !supabase || peer.peerId === creds.peerId) return;

      const existing = connections.current.get(peer.peerId);
      if (existing) {
        const wedged =
          existing.state !== "live" &&
          Date.now() - existing.progressAt > STUCK_MS;
        if (!wedged) return;
        // Tell the far side, so it drops its half instead of holding a dead
        // peer connection that our new offer would be applied to.
        disconnectFromRef.current(peer.peerId, true);
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
        progressAt: Date.now(),
      };
      connections.current.set(peer.peerId, conn);
      publish();

      // A host talking to a viewer negotiates on the VIEWER's inbox, so it
      // subscribes there — pinned to that viewer, so nothing arriving on it
      // can claim to be from someone else. Our own inbox is already
      // subscribed and is open to any host, so it carries no owner pin.
      if (topic !== creds.inboxTopic) {
        await ensureChannel(topic, peer.peerId);
      }

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
          if (candidates.length === 0) return;
          void sendOn(conn.topic, { t: "ice", from: creds.peerId, candidates });
        }, ICE_BATCH_MS);
      };

      pc.onconnectionstatechange = () => {
        const s = pc.connectionState;
        // Any transition is progress: it resets the wedged clock, so the
        // watchdog only fires on a connection that is genuinely going nowhere.
        conn.progressAt = Date.now();
        if (s === "connected") {
          conn.state = "live";
          conn.wasLive = true;
        } else if (s === "disconnected") {
          // Not fatal on its own — ICE routinely dips through "disconnected"
          // on a network change and recovers by itself.
          conn.state = "reconnecting";
        } else if (s === "failed" || s === "closed") {
          conn.state = conn.wasLive ? "reconnecting" : "failed";
        }
        publish();
        recomputeOverall();
      };

      // Whoever offers creates the transceivers, in the fixed slot order, so
      // both ends agree that mid 0 is camera, 1 is screen, 2 is audio.
      if (shouldOffer(creds.peerId, role, peer)) {
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
        try {
          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          await sendOn(conn.topic, {
            t: "offer",
            from: creds.peerId,
            name: creds.name,
            sdp: offer.sdp ?? "",
          });
        } catch (err) {
          conn.state = "failed";
          conn.progressAt = Date.now();
          publish();
          setError(readableError(err));
        }
      }
    },
    [attachLocalTracks, ensureChannel, publish, recomputeOverall, role, sendOn],
  );

  const onSignal = useCallback(
    async (msg: SignalMessage, expectFrom?: string) => {
      const creds = credsRef.current;
      if (!creds || !msg || msg.from === creds.peerId) return;
      // A channel that belongs to one peer only accepts that peer. Without
      // this, a student publishing on their own inbox could set `from` to a
      // classmate's id and have the host evict them.
      if (expectFrom && msg.from !== expectFrom) return;

      if (msg.t === "bye") {
        disconnectFrom(msg.from, false);
        return;
      }

      if (msg.t === "offer") {
        // An offer is also how a viewer first learns a host exists: the
        // server never told it, so the peer is constructed from the message.
        // It answers on the topic the offer arrived on — for a viewer that is
        // its own inbox, so it never needs to know the host's.
        if (!connections.current.has(msg.from)) {
          await connectTo({
            peerId: msg.from,
            name: msg.name,
            role: "host",
            inbox: creds.inboxTopic,
          });
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
          });
        } catch (err) {
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
        try {
          await conn.pc.setRemoteDescription({ type: "answer", sdp: msg.sdp });
          for (const c of conn.earlyCandidates.splice(0)) {
            await conn.pc.addIceCandidate(c).catch(() => {});
          }
        } catch (err) {
          setError(readableError(err));
        }
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
    [attachLocalTracks, connectTo, disconnectFrom, publish, sendOn],
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
     */
    let cancelled = false;
    const timers: ReturnType<typeof setInterval>[] = [];
    /** Install a timer, or immediately drop it if teardown already ran. */
    const addTimer = (t: ReturnType<typeof setInterval>) => {
      if (cancelled) clearInterval(t);
      else timers.push(t);
    };

    (async () => {
      setState("connecting");
      setError(null);

      const creds = await join().catch((err) => {
        setError(readableError(err));
        return null;
      });
      if (cancelled) return;
      if (!creds) {
        setState("failed");
        setError((e) => e ?? "You can't join this room right now.");
        return;
      }
      credsRef.current = creds;
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

      // The stage: host announcements, heard by everyone. Nothing here is
      // trusted (the topic is derivable from the event id by design) — the
      // only action it triggers is an idempotent re-announce, throttled so it
      // cannot be used to generate load.
      const supabaseStage = supabase.channel(creds.stageTopic);
      supabaseStage.on("broadcast", { event: SIGNAL_EVENT }, (m) => {
        const msg = m.payload as StageMessage;
        if (msg?.t !== "host-online" || msg.hostId === creds.peerId) return;
        const now = Date.now();
        if (now - lastReannounce.current < REANNOUNCE_FLOOR_MS) return;
        lastReannounce.current = now;
        // A host came up. Re-announce so it discovers us now rather than at
        // our next heartbeat — this is what makes a room of waiting students
        // assemble the instant the host presses Start.
        void announce();
        if (isBroadcasterRef.current) {
          // Another broadcaster: connect directly. Only a host is ever given
          // a host's inbox, so only a host can do this.
          const known = creds.peers.find((p) => p.peerId === msg.hostId);
          if (known) void connectTo(known);
        }
        // `host-offline` is deliberately ignored: acting on an unauthenticated
        // "the host left" would let any student end the webinar for everyone.
      });
      channels.current.set(creds.stageTopic, supabaseStage);
      await subscribe(supabaseStage);
      if (cancelled) return;

      // The lobby: arrivals, hosts only.
      if (creds.lobbyTopic) {
        const lobby = supabase.channel(creds.lobbyTopic);
        lobby.on("broadcast", { event: SIGNAL_EVENT }, (m) => {
          const msg = m.payload as LobbyMessage;
          if (!msg) return;
          if (msg.t === "peer-online" && msg.peerId !== creds.peerId) {
            void connectTo({
              peerId: msg.peerId,
              name: msg.name,
              role: msg.role,
              inbox: msg.inbox,
            });
          } else if (msg.t === "peer-offline") {
            disconnectFrom(msg.peerId, false);
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

      // ONLY NOW announce. Every channel above is subscribed, so the offer a
      // host sends in response cannot land before we are listening. joinRoom
      // deliberately does not announce for exactly this reason — doing it
      // there raced the subscription and silently dropped the offer, leaving
      // the host at `have-local-offer` and the student with no connection.
      await announce();
      if (cancelled) return;

      for (const peer of creds.peers) void connectTo(peer);
      recomputeOverall();
      // After the loop, not before: connectTo publishes each peer
      // synchronously, so by this line `remotes` names everyone the server
      // said was here.
      setJoined(true);

      // The heartbeat is the retry path as well as the keepalive: every peer
      // the server told us about is re-attempted, and connectTo's wedged
      // check makes that a no-op for healthy connections and a rebuild for
      // stuck ones. A 1:1 has no reconcile poll, so without this a single
      // lost offer would deadlock the call forever.
      addTimer(
        setInterval(() => {
          void announce();
          const held = credsRef.current;
          if (held) for (const peer of held.peers) void connectTo(peer);
        }, HEARTBEAT_MS),
      );

      // Reconcile is the backstop for a webinar host, catching whatever a
      // dropped lobby message lost. Hosts only — it is the one call that
      // returns the audience.
      if (isBroadcasterRef.current && kind === "event") {
        addTimer(
          setInterval(() => {
            void listPeers()
              .then((peers) => peers.forEach((p) => void connectTo(p)))
              .catch(() => {});
          }, HEARTBEAT_MS * 2),
        );
      }
    })();

    return () => {
      cancelled = true;
      setJoined(false);
      for (const t of timers) clearInterval(t);
      for (const peerId of [...connections.current.keys()]) {
        disconnectFromRef.current(peerId, true);
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
      void leave().catch(() => {});
    };
    // The server-action props are stable references from the page. Including
    // them would tear down every live connection on each render, so they are
    // deliberately omitted.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, roomId, kind]);

  // Closing the tab still tells the host, so they stop showing a tile for
  // someone who has gone. `pagehide` rather than `beforeunload`: it fires on
  // mobile Safari's back-forward cache path, which `beforeunload` does not.
  useEffect(() => {
    if (!enabled) return;
    const bye = () => {
      const creds = credsRef.current;
      if (creds) {
        for (const conn of connections.current.values()) {
          void sendOn(conn.topic, { t: "bye", from: creds.peerId });
        }
      }
      void leave().catch(() => {});
    };
    window.addEventListener("pagehide", bye);
    return () => window.removeEventListener("pagehide", bye);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, sendOn]);

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
    }),
    [state, remotes, joined, audienceCount, error, refreshTracks, topics],
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
