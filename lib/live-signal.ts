/**
 * The batch0 Live wire protocol — channel names and message shapes.
 *
 * Pure module, no imports, no `server-only`, no browser globals: the server
 * mints the channel names and the browser subscribes to them, so both sides
 * have to agree on every string in here. Keeping it import-free also means it
 * carries a test that runs under `npm test` with no transpile step, the same
 * way lib/live.ts and lib/webinar-schedule.ts do.
 *
 * ---------------------------------------------------------------------------
 * The topology, and why the audience really is hidden
 * ---------------------------------------------------------------------------
 *
 * A webinar is one host broadcasting to N viewers. That is a STAR, not a mesh:
 * the host holds one send-only peer connection per viewer, each viewer holds
 * one receive-only connection back to the host, and no viewer is ever
 * connected to another viewer. Media is browser-to-browser and never touches
 * our servers; all we run is signalling.
 *
 * Audience privacy falls out of the topology rather than being bolted on:
 *
 *  1. Every participant has ONE inbox channel, and its name is
 *     `HMAC(server secret, eventId + peerId)`. A viewer cannot derive anyone
 *     else's inbox, because they do not have the secret — so there is no
 *     channel they could subscribe to on which another viewer would appear.
 *
 *  2. A viewer is told only about hosts (lib/live-rooms.ts decides what to
 *     disclose, by role). It is never sent another viewer's id, name, or
 *     inbox — so there is nothing to leak even in devtools.
 *
 *  3. Viewers announce themselves to hosts through a server action, never by
 *     broadcasting. The lobby channel that carries those announcements is
 *     itself keyed by an HMAC only hosts are given.
 *
 * Contrast with the Daily setup this replaces, which hid viewers with
 * `hasPresence: false`: that hid them from the HOST too, so nobody could tell
 * whether anyone was watching. Here the host sees the audience and the
 * audience cannot see itself, which is the split that was actually wanted.
 */

/** What a person may do in a room. Mirrors LiveRole in lib/live.ts. */
export type SignalRole = "host" | "viewer";

// ---------------------------------------------------------------------------
// Channel names
// ---------------------------------------------------------------------------

/**
 * Prefix for every batch0 Live channel.
 *
 * Realtime topics share one namespace across the whole Supabase project, and
 * `notification-bell.tsx` is already in there. The prefix keeps a room from
 * ever colliding with something else the app subscribes to.
 */
const NS = "b0live";

/**
 * The stage: host announcements, heard by everybody in the room.
 *
 * Deliberately NOT secret — every participant subscribes, and its name is
 * derivable from the event id alone. That is safe because only hosts ever
 * publish here and the only thing they publish is "I am live now" / "I have
 * stopped". Nothing about the audience crosses this channel, so a viewer
 * listening in learns exactly what they already knew: whether the webinar has
 * started.
 *
 * It exists to solve one ordering problem. Students arrive before the host
 * does. Without a stage ping, a host starting up would have to wait for the
 * next viewer heartbeat to discover a room full of people already waiting.
 * Instead the host says "I'm live", every viewer re-announces at once, and
 * the room assembles in about a round trip.
 *
 * Because it is public, a stage message is only believed when it carries the
 * `proof` a host is issued (see StageMessage) — otherwise a student in
 * devtools could publish `host-offline` and blank everyone's screen.
 */
export function stageTopic(eventId: string): string {
  return `${NS}:${eventId}:stage`;
}

/**
 * The lobby: where viewer arrivals are delivered to hosts.
 *
 * `lobbyKey` is an HMAC handed only to hosts, so only a host can subscribe.
 * Viewers never publish here — they call a server action, and the server
 * broadcasts on their behalf with the service role. That indirection is the
 * point: if viewers published here directly they would need the key, and a
 * viewer with the key could watch every other arrival.
 */
export function lobbyTopic(eventId: string, lobbyKey: string): string {
  return `${NS}:${eventId}:lobby:${lobbyKey}`;
}

/**
 * One participant's inbox — the channel their peer connections are negotiated
 * on. `inboxKey` is `HMAC(secret, eventId + peerId)`, so it is unguessable
 * without the server secret and is disclosed only to its owner and to hosts.
 *
 * Keying the inbox on the *receiver* alone (rather than on a host/viewer
 * pair) is what lets a viewer subscribe before any host exists: there is one
 * line per person, and whichever host shows up publishes to it. Messages
 * carry `from`, so a viewer that somehow hears from two hosts keeps one peer
 * connection per host instead of confusing them for each other.
 */
export function inboxTopic(eventId: string, inboxKey: string): string {
  return `${NS}:${eventId}:in:${inboxKey}`;
}

/**
 * Which channel a connection is negotiated on — and the reason a viewer is
 * never told the host's inbox.
 *
 * The obvious design leaks the audience. If a viewer answered on the HOST's
 * inbox, it would have to know that topic — and so would every other viewer,
 * any of whom could then subscribe and watch each answer arrive carrying a
 * `from` id and a display name. The room would be hiding the audience in the
 * UI while broadcasting it on the wire.
 *
 * So a host↔viewer connection is negotiated entirely on the VIEWER's inbox,
 * in both directions: the host publishes there and also subscribes there, and
 * the viewer publishes on the one channel it already owns. A viewer therefore
 * never learns any topic but its own, and there is no channel in the system
 * on which one viewer could observe another.
 *
 * Host↔host (a 1:1, or two staff in a webinar) is the ordinary case: each
 * publishes to the other's inbox and listens on its own. There is no audience
 * to protect between two broadcasters.
 */
export function connectionTopic({
  selfRole,
  selfInbox,
  peerRole,
  peerInbox,
}: {
  selfRole: SignalRole;
  selfInbox: string;
  peerRole: SignalRole;
  peerInbox: string;
}): string {
  // Exactly one side is a viewer -> that viewer's inbox carries both
  // directions. Otherwise, address the recipient directly.
  if (selfRole === "viewer") return selfInbox;
  if (peerRole === "viewer") return peerInbox;
  return peerInbox;
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

/** Broadcast `event` name used for every batch0 Live message. */
export const SIGNAL_EVENT = "b0live";

/**
 * Negotiation traffic, sent to a peer's inbox.
 *
 * ICE candidates arrive in batches rather than one message each. A peer
 * connection trickles five to fifteen candidates in a burst, and one Realtime
 * message per candidate turns a two-second handshake into a flood; the engine
 * buffers them for a beat and sends the batch.
 */
export type SignalMessage =
  | { t: "offer"; from: string; name: string; sdp: string }
  | { t: "answer"; from: string; name: string; sdp: string }
  | { t: "ice"; from: string; candidates: unknown[] }
  /** Sender is going away — tear the connection down now, don't wait for ICE
   *  to notice. Makes "the host left" instant instead of ~10 seconds frozen. */
  | { t: "bye"; from: string }
  /**
   * Which of the sender's slots are actually carrying media right now.
   *
   * Sent by a broadcaster when a connection comes up and on every change
   * afterwards, because the receiving end cannot work this out for itself.
   * The obvious source — `receiver.track.muted` — does not answer it:
   *
   *  - Detaching a sender (`replaceTrack(null)`) stops the RTP but does not
   *    reliably mute the remote track, so a host turning their camera off
   *    left the viewer watching a frozen last frame with nothing to explain
   *    it.
   *  - The screen transceiver exists from the first offer, before anyone has
   *    ever presented, and a receiver track that has simply never carried
   *    packets is not distinguishable from one whose sender went quiet. Read
   *    optimistically that put every viewer into the presenting layout,
   *    staring at a black rectangle instead of the host's face.
   *
   * Both of those are invisible to a decoded-frames check and obvious to an
   * audience, which is the worst combination. So the sender — the only party
   * that actually knows — says so. `slotIsActive` is where the two sources
   * are reconciled.
   */
  | { t: "media"; from: string; slots: Record<MediaSlot, boolean> };

/**
 * Host announcements on the stage channel.
 *
 * `proof` is an HMAC the server issues only to hosts. The stage channel is
 * public by design, so every receiver checks the proof before acting: without
 * it, any student could publish `host-offline` and end the webinar for the
 * whole room. Viewers cannot forge it and cannot mint one, because deriving
 * it needs the server secret.
 */
export type StageMessage =
  | { t: "host-online"; hostId: string; name: string; proof: string }
  | { t: "host-offline"; hostId: string; proof: string };

/**
 * Arrivals and departures, delivered to hosts on the lobby channel.
 *
 * Only ever published by the server (service role) — which is why a viewer's
 * `inbox` can safely ride along: the only subscribers are hosts, who are
 * allowed to reach every participant.
 */
export type LobbyMessage =
  | {
      t: "peer-online";
      peerId: string;
      name: string;
      role: SignalRole;
      /**
       * This peer's inbox. For a viewer it is the whole conversation — the
       * host publishes its offer and ICE there AND subscribes to it for the
       * answer, so the viewer never needs a second topic (see
       * connectionTopic).
       */
      inbox: string;
    }
  | { t: "peer-offline"; peerId: string };

// ---------------------------------------------------------------------------
// Media layout
// ---------------------------------------------------------------------------

/**
 * Which transceiver carries what.
 *
 * The broadcaster creates exactly these three, in exactly this order, when it
 * builds a peer connection — and never adds, removes, or reorders them. That
 * fixes each track's `mid` to its index, so the receiver can tell camera from
 * screen share by `mid` alone without any out-of-band message.
 *
 * The real payoff is that the connection is negotiated ONCE. Turning the
 * camera off, switching to slides, and switching back are all
 * `sender.replaceTrack()` or `track.enabled = false`, none of which
 * renegotiate. No renegotiation means no offer/answer glare, no mid-webinar
 * SDP exchange with twelve viewers at once, and no class of bug where the
 * fifth student to join gets a different stream layout than the first.
 */
export const MEDIA_SLOTS = ["camera", "screen", "audio"] as const;
export type MediaSlot = (typeof MEDIA_SLOTS)[number];

/**
 * The `mid` a slot's transceiver gets, given the fixed creation order.
 *
 * Matched as digits rather than coerced with `Number`, because `Number("")`
 * and `Number(" ")` are both `0` — which would quietly map an empty or
 * whitespace `mid` onto the camera slot and render a track in the wrong
 * place. An unrecognised mid returns null and the track is ignored, which is
 * the right failure: a missing tile is obvious, a screen share appearing in
 * the camera slot is baffling.
 */
export function slotForMid(mid: string | null | undefined): MediaSlot | null {
  if (typeof mid !== "string" || !/^\d+$/.test(mid)) return null;
  const i = Number(mid);
  return i < MEDIA_SLOTS.length ? MEDIA_SLOTS[i] : null;
}

/**
 * Should a received slot be rendered — reconciling what the sender announced
 * with what the transport can see.
 *
 * `announced` is the sender's own `media` message, and it wins whenever we
 * have one: it is the only account of intent, and it is the half that knows
 * a detached sender from a quiet one.
 *
 * Before the first `media` message arrives the two remaining cases differ,
 * and deliberately so:
 *
 *  - camera and audio fall back to the track. A dropped message must not
 *    cost the audience the webinar, and a live unmuted track is good enough
 *    evidence that media is flowing.
 *  - screen does NOT. Nobody is presenting until a host says they are, so an
 *    unknown screen slot is off. Guessing the other way is the bug that put
 *    viewers in the presenting layout in front of a black rectangle, and
 *    "the slide is a second late" is a far cheaper mistake than "the webinar
 *    appears to be a black screen".
 */
export function slotIsActive({
  slot,
  announced,
  trackLive,
}: {
  slot: MediaSlot;
  announced: boolean | undefined;
  trackLive: boolean;
}): boolean {
  if (announced !== undefined) return announced;
  return slot === "screen" ? false : trackLive;
}

// ---------------------------------------------------------------------------
// Timings
// ---------------------------------------------------------------------------

/**
 * How often a participant re-announces itself to the hosts.
 *
 * This is the self-healing interval, not a keepalive: it is what makes a host
 * who reloads mid-webinar, or whose lobby message was dropped, recover
 * without anyone clicking anything. Short enough that a stumble is over
 * before a student would think to refresh; long enough that twelve viewers
 * cost about one server action per second between them.
 */
export const HEARTBEAT_MS = 12_000;

/** A participant unheard-from for this long is treated as gone. */
export const PEER_TIMEOUT_MS = 40_000;

/** How long ICE candidates are buffered before going out as one message. */
export const ICE_BATCH_MS = 120;

// ---------------------------------------------------------------------------
// The room channel — chat, questions, polls, reactions, and the premiere
// handover
// ---------------------------------------------------------------------------

/**
 * Where everything that is not media happens.
 *
 * Unlike `stageTopic`, this one is KEYED. The stage is derivable from the event
 * id on purpose, because the only thing it carries is "a host is live", which
 * a viewer already knows by looking. This channel carries the room's activity,
 * and an enrolled-only webinar's activity must not be observable by a signed-in
 * student who happened to learn the event id. So `roomKey` is an HMAC, minted
 * in lib/live-rooms.ts and handed out only to participants who passed the join
 * gate — and, for a viewer, only when the event's `audience_mode` lets the
 * audience see itself at all.
 *
 * That last clause is the one that keeps migration 0076's guarantee intact. In
 * `private` mode a viewer is never given this topic, so there is no channel on
 * which they could observe another viewer typing, reacting, or arriving. The
 * privacy is structural exactly as it was before this channel existed; chat is
 * not a hole punched in it, it is a second room that private webinars never
 * open.
 */
export function roomTopic(eventId: string, roomKey: string): string {
  return `${NS}:${eventId}:room:${roomKey}`;
}

/**
 * The hosts' back channel: pending messages, new questions, raised hands.
 *
 * Separate from the room channel rather than a flag on it, because in
 * `moderated` mode the whole point is that the audience does not see a message
 * until a host releases it. One channel with a "pending" flag would put every
 * unapproved message on the wire to every viewer and rely on the client not to
 * render it — which is the "hiding a list the browser already holds" mistake
 * the rest of this subsystem is built to avoid.
 */
export function moderationTopic(eventId: string, modKey: string): string {
  return `${NS}:${eventId}:mod:${modKey}`;
}

/**
 * What crosses the room channel.
 *
 * Read the `bump` case carefully, because it is the whole security model here.
 *
 * Everything substantive — a chat message, a question, a poll, an approval — is
 * announced as a CONTENT-FREE PING, and the client answers it by re-fetching
 * through a server action that reads under the caller's own RLS. The channel
 * never carries the message body, the author, or anything else worth forging.
 *
 * The alternative was to publish the message itself and have clients verify a
 * signature. That does not work here: every participant holds `roomKey`, so
 * anything one participant can verify, another can mint. A proof only helps on
 * a channel where the publisher holds a secret the subscribers do not — which
 * is true of the stage (hosts publish, everyone listens) and false of a chat
 * room by definition.
 *
 * So the worst a student in devtools can do on this channel is make the room
 * re-fetch. That costs one small query per client, it is debounced, and it
 * returns exactly what the caller was already entitled to see. Compared against
 * the 5-second poll this replaces, a forged bump is indistinguishable from an
 * ordinary tick.
 *
 * `react` is the one exception, and it is deliberately the one thing that is
 * never stored: a reaction is an emoji that floats up the video and is gone.
 * Forging one puts a clap on some screens for two seconds. Anything richer
 * would need the moderation apparatus chat has, for a feature whose entire
 * value is that it costs no round trip.
 */
export type RoomMessage =
  /**
   * "Something in `what` changed — re-read it."
   *
   * `cursor` is the newest `created_at` the publisher knows about, so a client
   * can fetch only what is new instead of the whole feed. Advisory: a client
   * that has fallen behind ignores it and asks from its own cursor.
   */
  | { t: "bump"; what: "chat" | "qa" | "poll"; cursor?: string }
  /** Ephemeral, never stored, published by viewers directly. */
  | { t: "react"; emoji: string }
  /**
   * A premiere is handing over to the live room, now — because the recording
   * finished or because a host pressed "go live" early.
   *
   * Carries no proof and is therefore only ever a HINT: the client re-reads
   * `live_started_at` from the server before it switches, so a forged message
   * costs one query and changes nothing. The page also computes the handover
   * from the clock on its own, which is what makes the switch happen at all
   * for anyone whose channel dropped the message.
   */
  | { t: "stage-change" };

/**
 * How long a client waits after a bump before re-fetching.
 *
 * A burst of five messages in a busy room arrives as five bumps within a
 * second; without a debounce that is five queries per client per second, which
 * is the pile-up the old 5-second poll was carefully designed to avoid and
 * would be a poor way to reintroduce it. 250ms collapses a burst into one
 * fetch and is still four times faster than a human notices.
 */
export const ROOM_BUMP_DEBOUNCE_MS = 250;

/**
 * The backstop poll for the room channel.
 *
 * Realtime broadcasts are not replayed: a message published while a client was
 * between subscriptions is simply gone. For media that is repaired by the
 * heartbeat; for chat it would be a message that never appears for one person
 * and appears for everyone else, which is the kind of bug nobody can reproduce.
 * So the feed is also re-read on this interval regardless of bumps — rarely
 * enough to cost almost nothing at fifty viewers, often enough that a dropped
 * message is a blip rather than a hole.
 */
export const ROOM_RESYNC_MS = 20_000;
