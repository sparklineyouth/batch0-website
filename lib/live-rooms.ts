import "server-only";
import { env } from "@/lib/env";
import { deriveKey, pairKeyParts } from "@/lib/live-keys";
import { isMissingSchemaError } from "@/lib/schema-ready";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  inboxTopic,
  lobbyTopic,
  moderationTopic,
  pairTopic,
  roomTopic,
  stageTopic,
  turnServerFrom,
  SIGNAL_EVENT,
  type LobbyMessage,
  type RoomMessage,
  type SignalRole,
  type StageMessage,
} from "@/lib/live-signal";

/**
 * batch0 Live, server side: who may join a room, and what they are told.
 *
 * This is the whole access-control surface of the built-in provider, and it
 * is deliberately the only place that holds the room secret. The browser
 * never receives a key it could use to reach anyone it isn't entitled to
 * reach — it receives HMACs, each scoped to one channel, minted here after
 * the same permission and RLS checks that guard the rest of the site.
 *
 * `server-only` is not decoration. A leak of
 * `env.liveRoomSecret` into a client bundle would let any student derive
 * every inbox and lobby key on the site — which is to say, watch the private
 * signalling of every webinar and 1:1 call the program ever runs. The import
 * makes that a build error instead of something to catch in review.
 *
 * ---------------------------------------------------------------------------
 * What gets disclosed, to whom
 * ---------------------------------------------------------------------------
 *
 *   webinar host    -> own inbox key, the lobby, room and moderation keys,
 *                      a stage proof, and every peer (so it can call them)
 *   webinar viewer  -> own inbox key, the room key only where the audience
 *                      may see itself, and the hosts' names
 *   1:1 party       -> one private line per other person on the call (a pair
 *                      key both ends of that pair, and nobody else, are
 *                      given), and those people's names. No inbox anyone can
 *                      offer on, and no lobby, room or moderation key: a lobby
 *                      key let a student forge arrivals, and an open inbox let
 *                      them forge a co-host (see pairTopic).
 *
 * A viewer is never handed another viewer's id, name, or inbox key. That is
 * the audience-privacy guarantee, and it lives here rather than in the UI:
 * `canSeeRoster()` in lib/live.ts decides what to draw, this decides what the
 * client is ever given to draw with. Hiding a list the browser already holds
 * is a CSS-deep guarantee; not sending it is a real one.
 */

// ---------------------------------------------------------------------------
// Key derivation
// ---------------------------------------------------------------------------

/** Derive a channel key or a proof. See deriveKey (lib/live-keys.ts). */
function derive(purpose: string, ...parts: string[]): string {
  const secret = env.liveRoomSecret;
  if (!secret) {
    // Only reachable with neither LIVE_ROOM_SECRET nor a service-role key,
    // which means Supabase itself is unconfigured. Named anyway, so it never
    // degrades into a silent empty key that every room would share.
    throw new Error(
      "batch0 Live isn't configured — LIVE_ROOM_SECRET (or SUPABASE_SERVICE_ROLE_KEY) is missing.",
    );
  }
  return deriveKey(secret, purpose, ...parts);
}

/** One participant's inbox key. Disclosed to its owner, and to hosts. */
export function inboxKeyFor(eventId: string, peerId: string): string {
  return derive("inbox", eventId, peerId);
}

/**
 * The line between two people on a 1:1 — the topic both of them negotiate
 * their connection on, and the only one. Disclosed to those two people and
 * nobody else; the same string whichever of them asks.
 */
export function callLineFor(roomId: string, selfId: string, peerId: string): string {
  return pairTopic(roomId, derive("pair", ...pairKeyParts(roomId, selfId, peerId)));
}

/** The lobby key for a room. Disclosed to hosts only. */
function lobbyKeyFor(eventId: string): string {
  return derive("lobby", eventId);
}

/**
 * The room key — chat, questions, polls and reactions.
 *
 * Disclosed to every host, and to a viewer ONLY when the event's audience mode
 * lets the audience see itself. In `private` mode a viewer is never given this
 * string, so there is no channel on which they could observe another viewer at
 * all — the 0076 guarantee is untouched rather than relaxed, and chat is a
 * second room that a private webinar simply never opens.
 */
function roomKeyFor(eventId: string): string {
  return derive("room", eventId);
}

/**
 * The moderation key — pending messages and the live question queue.
 *
 * Hosts only, in the same shape as the lobby key and for the same reason: in
 * `moderated` mode the entire point is that an unapproved message does not
 * reach the audience, and a single channel with a "pending" flag would put it
 * on the wire to every viewer and rely on the client not to draw it.
 */
function moderationKeyFor(eventId: string): string {
  return derive("moderation", eventId);
}


/**
 * The `proof` a host attaches to its `host-online` stage message.
 *
 * Handed to webinar hosts only; a webinar engine announces on the stage only
 * when it holds one, which keeps a viewer's own code path from publishing
 * `host-online`. (Every party to a 1:1 broadcasts and announces without one.)
 * It is NOT verified by anyone who receives the message: the stage is public,
 * so every stage message is an unauthenticated hint that only ever makes a
 * client re-ask the server (see StageMessage in lib/live-signal.ts).
 */
function stageProofFor(eventId: string, hostId: string): string {
  return derive("stage", eventId, hostId);
}

// ---------------------------------------------------------------------------
// ICE
// ---------------------------------------------------------------------------

export type IceServer = {
  urls: string | string[];
  username?: string;
  credential?: string;
};

/**
 * The ICE servers a browser should use.
 *
 * STUN is public and free, and several are listed because they are
 * interchangeable. TURN (LIVE_TURN_URLS / _USERNAME / _CREDENTIAL) is the
 * optional relay for networks that refuse a direct connection. It is
 * validated here (turnServerFrom): a malformed entry would make
 * `new RTCPeerConnection` throw in every browser, so it is dropped and logged
 * instead. Returned per join, so credentials can rotate without a redeploy.
 */
export function iceServers(): IceServer[] {
  const servers: IceServer[] = [
    {
      urls: [
        "stun:stun.l.google.com:19302",
        "stun:stun1.l.google.com:19302",
        "stun:stun.cloudflare.com:3478",
      ],
    },
  ];
  const turn = turnServerFrom({
    urls: env.liveTurnUrls,
    username: env.liveTurnUsername,
    credential: env.liveTurnCredential,
  });
  if (turn.problem && !turnProblemLogged) {
    turnProblemLogged = true;
    console.error(`[live] ignoring TURN config: ${turn.problem}`);
  }
  if (turn.server) servers.push(turn.server);
  return servers;
}
let turnProblemLogged = false;

// ---------------------------------------------------------------------------
// The join payload
// ---------------------------------------------------------------------------

export type LivePeer = {
  peerId: string;
  name: string;
  role: SignalRole;
  /**
   * Where to reach them, and — when they are a viewer — where they answer
   * from too. Hosts are given this for everyone; a viewer is never given
   * anyone's but its own. In a 1:1 it is the private line between the two of
   * you (callLineFor). See connectionTopic() in lib/live-signal.ts.
   */
  inbox: string;
};

export type LiveCredentials = {
  peerId: string;
  name: string;
  role: SignalRole;
  /**
   * Topic this participant subscribes to for offers/answers/ICE. Null for a
   * 1:1, which has no open inbox: each peer's `inbox` is a line pinned to them.
   */
  inboxTopic: string | null;
  /** Topic every participant subscribes to for host announcements. */
  stageTopic: string;
  /** Webinar hosts only: topic arrivals are delivered on. */
  lobbyTopic: string | null;
  /**
   * Webinar hosts only: attached to `host-online` stage messages. Never
   * verified by receivers — see stageProofFor.
   */
  stageProof: string | null;
  /**
   * Chat, questions, polls and reactions.
   *
   * Null for a viewer in a `private` room, and that null is the feature: it is
   * not a disabled button, it is the absence of any channel on which one
   * student could learn that another is here.
   */
  roomTopic: string | null;
  /** Webinar hosts only: the moderation queue. */
  moderationTopic: string | null;
  iceServers: IceServer[];
  /**
   * Who this participant may talk to, already filtered by role. For a viewer
   * this is the hosts and nobody else — the audience is not merely hidden in
   * the UI, it is absent from the payload.
   */
  peers: LivePeer[];
};

/**
 * Everything one participant needs to join one room.
 *
 * CALLERS MUST AUTHORIZE FIRST. This mints credentials and performs no
 * permission checks of its own. The server action that calls it is
 * responsible for having read the room through the caller's own access rules
 * and for passing a `role` it derived, never one the client sent.
 */
export function credentialsFor({
  kind,
  eventId,
  peerId,
  name,
  role,
  peers,
  audienceMode = "private",
  discloseNames = true,
}: {
  /**
   * A 1:1 gets the stage and its peers' lines, nothing else: no open inbox
   * (pairTopic says why), and the lobby, room and moderation channels carry
   * nothing for a call — handing a student the lobby key let them forge a
   * `peer-online` and be dialled as a co-host.
   */
  kind: "event" | "call";
  /** The namespaced room id (`event:<uuid>` / `call:<uuid>`). */
  eventId: string;
  peerId: string;
  name: string;
  role: SignalRole;
  peers: LivePeer[];
  /**
   * The event's `audience_mode`. Decides one thing only: whether a VIEWER is
   * given the room topic.
   *
   * Defaults to `private` so a caller that forgets to pass it discloses less
   * rather than more — the same fail-closed shape as `normalizeAudienceMode`
   * in lib/webinars.ts.
   */
  audienceMode?: "private" | "moderated" | "open";
  /**
   * May this participant be told WHO the audience is, as opposed to merely
   * how many?
   *
   * This exists because guest speakers broke an assumption that held for as
   * long as every broadcaster was staff: that "can broadcast" and "may see the
   * roster" are the same grant. They are not. A founder invited to talk for
   * forty minutes has to reach every viewer — a star topology gives them no
   * choice, they hold one send-only connection per person — but reaching
   * someone needs their inbox, not their name.
   *
   * So a speaker is given `peerId` and `inbox` for everyone (without which
   * they cannot send media at all) and a blank `name` for every viewer. They
   * see a headcount and a set of opaque ids; the attendance list of a room
   * full of minors stays with the staff who are accountable for it.
   *
   * Defaults to true, which is correct for the two callers that predate
   * speakers: a 1:1, where the peer list is the other person, and a staff host,
   * who is the party this data is for.
   */
  discloseNames?: boolean;
}): LiveCredentials {
  const isHost = role === "host";
  const webinar = kind === "event";
  const webinarHost = webinar && isHost;
  // A webinar host always has the room channel — they are the moderation
  // queue's only subscriber. A viewer gets it only where the audience is
  // allowed to see itself at all.
  const roomVisible = webinar && (isHost || audienceMode !== "private");
  return {
    peerId,
    name,
    role,
    inboxTopic: webinar ? inboxTopic(eventId, inboxKeyFor(eventId, peerId)) : null,
    stageTopic: stageTopic(eventId),
    lobbyTopic: webinarHost ? lobbyTopic(eventId, lobbyKeyFor(eventId)) : null,
    stageProof: webinarHost ? stageProofFor(eventId, peerId) : null,
    roomTopic: roomVisible ? roomTopic(eventId, roomKeyFor(eventId)) : null,
    moderationTopic: webinarHost
      ? moderationTopic(eventId, moderationKeyFor(eventId))
      : null,
    iceServers: iceServers(),
    // The disclosure rule, in one line: a host may call anyone, a viewer may
    // only be called by a host. Filtering here (rather than in the component)
    // is what makes "students can't see each other" true of the network
    // payload and not just of the rendering.
    //
    // The second line is for guest speakers: they need every viewer's inbox to
    // send media at all, and none of their names to do it. A blank name is not
    // a UI choice that a devtools console could undo — the string is simply not
    // in the response.
    peers: isHost
      ? peers.map((p) =>
          discloseNames || p.role === "host" ? p : { ...p, name: "" },
        )
      : peers.filter((p) => p.role === "host"),
  };
}

// ---------------------------------------------------------------------------
// Server-side broadcast
// ---------------------------------------------------------------------------

/**
 * Publish to a Realtime channel with the service role.
 *
 * This is how a viewer reaches the hosts without ever holding the lobby key.
 * The viewer calls a server action, the server publishes here, and the hosts
 * — the only subscribers — pick it up in about 90ms. If viewers published to
 * the lobby directly they would need its key, and a viewer holding that key
 * could watch every other arrival in the room.
 *
 * Best-effort by design. A dropped announcement is repaired by the next
 * heartbeat (HEARTBEAT_MS), so a Realtime hiccup costs a few seconds of
 * "connecting", never the session.
 */
export async function broadcast(
  topic: string,
  payload: LobbyMessage | RoomMessage | StageMessage,
): Promise<void> {
  const key = env.supabaseServiceRoleKey;
  if (!key || !env.supabaseUrl) return;
  try {
    await fetch(`${env.supabaseUrl}/realtime/v1/api/broadcast`, {
      method: "POST",
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messages: [{ topic, event: SIGNAL_EVENT, payload }],
      }),
      cache: "no-store",
    });
  } catch (err) {
    console.error("[live] realtime broadcast failed", err);
  }
}

/** Tell the hosts of a room that someone arrived (or left). */
export async function notifyHosts(
  eventId: string,
  message: LobbyMessage,
): Promise<void> {
  await broadcast(lobbyTopic(eventId, lobbyKeyFor(eventId)), message);
}

/**
 * Tell the room that something changed.
 *
 * This is the whole reason the Q&A panel no longer polls every five seconds.
 * A message lands, the server publishes a content-free `bump`, and every
 * client re-reads through its own RLS about 250ms later. Fifty viewers used to
 * cost 200 requests a minute doing nothing; now they cost one request each
 * when something actually happens.
 *
 * Content-free is load-bearing, not an optimisation — see the note on
 * `RoomMessage` in lib/live-signal.ts. Every participant holds the room key,
 * so anything one of them could verify, another could mint; publishing the
 * message body would be publishing something forgeable. A bump is not worth
 * forging, because answering it returns only what the caller could already
 * read.
 *
 * Best-effort like every broadcast here. A dropped bump is repaired by
 * ROOM_RESYNC_MS, so the cost is a few seconds of staleness for one person,
 * never a message that is lost.
 */
export async function notifyRoom(
  eventId: string,
  message: RoomMessage,
): Promise<void> {
  await broadcast(roomTopic(eventId, roomKeyFor(eventId)), message);
}

/**
 * Tell EVERYONE in a room — hosts, speakers, and viewers in every audience
 * mode — that its state changed, on the public stage topic.
 *
 * `roomId` is the namespaced id (`event:<uuid>` or `call:<uuid>`), the same
 * string the stage topic in every participant's credentials was minted from.
 * This is the only channel a viewer in a `private` webinar and both parties to
 * a 1:1 are all subscribed to, which is why End, Reopen, Cancel and End call
 * are announced here rather than on the room topic. The only message the
 * server sends is the content-free `room-changed`; a client answers it by
 * re-asking the server, so a forged copy (the topic is public) costs a
 * throttled re-check and nothing else.
 */
export async function notifyStage(
  roomId: string,
  message: StageMessage,
): Promise<void> {
  await broadcast(stageTopic(roomId), message);
}

/**
 * Tell everyone in a 1:1's room that the call changed — End call, a cancel —
 * so each engine re-asks the server at once instead of on its next heartbeat.
 * Call after the write has landed.
 */
export async function notifyCallChanged(inviteId: string): Promise<void> {
  await notifyStage(`call:${inviteId}`, { t: "room-changed" });
}

/**
 * Tell the hosts — and only the hosts — that something needs them.
 *
 * In `moderated` mode this is how a pending message reaches the queue without
 * ever crossing the audience's channel.
 */
export async function notifyModerators(
  eventId: string,
  message: RoomMessage,
): Promise<void> {
  await broadcast(
    moderationTopic(eventId, moderationKeyFor(eventId)),
    message,
  );
}

// ---------------------------------------------------------------------------
// Attendance
// ---------------------------------------------------------------------------

/**
 * Record that someone is in the room, and refresh their liveness.
 *
 * Deliberately best-effort and never on the critical path: discovery runs
 * entirely over Realtime, so a webinar assembles whether or not this write
 * lands. That matters for one concrete reason — `live_participants` arrives
 * with migration 0076, and a deploy that reaches production before the SQL is
 * run must degrade to "attendance isn't being recorded", not to "nobody can
 * join the webinar". A missing table is logged once per call and ignored.
 *
 * What it buys when it is there: a record of who attended and for how long,
 * owned by us rather than by a video vendor — which for a program with minors
 * is the side we want it on — and the host's audience roster surviving a
 * reload.
 */
export async function touchParticipant({
  eventId,
  userId,
  role,
  displayName,
}: {
  eventId: string;
  userId: string;
  role: SignalRole;
  displayName: string;
}): Promise<void> {
  try {
    const admin = createAdminClient();
    const { error } = await admin.from("live_participants").upsert(
      {
        event_id: eventId,
        user_id: userId,
        role,
        display_name: displayName,
        last_seen_at: new Date().toISOString(),
        left_at: null,
      },
      { onConflict: "event_id,user_id" },
    );
    if (error && !isMissingSchemaError(error)) {
      console.error("[live] attendance upsert failed", error.message);
    }
  } catch (err) {
    console.error("[live] attendance upsert threw", err);
  }
}

/** Mark someone as gone. Best-effort, exactly like touchParticipant. */
export async function markLeft(
  eventId: string,
  userId: string,
): Promise<void> {
  try {
    const admin = createAdminClient();
    const { error } = await admin
      .from("live_participants")
      .update({ left_at: new Date().toISOString() })
      .eq("event_id", eventId)
      .eq("user_id", userId);
    if (error && !isMissingSchemaError(error)) {
      console.error("[live] attendance leave failed", error.message);
    }
  } catch (err) {
    console.error("[live] attendance leave threw", err);
  }
}

/**
 * Close every open attendance row in a room at `at` — what End for everyone
 * does to the record.
 *
 * Without it, a viewer who left the tab open on "This webinar has ended" kept
 * a row with `left_at` null, and the attendance minutes (joined → last seen)
 * kept counting until the tab closed. The engine now also stops heartbeating
 * on end and announcePresence stops touching attendance for an ended event;
 * this makes the record right even for a client that never hears about it.
 *
 * Best-effort, like every write in this section.
 */
export async function closeOpenAttendance(
  eventId: string,
  at: string,
): Promise<void> {
  try {
    const admin = createAdminClient();
    const { error } = await admin
      .from("live_participants")
      .update({ left_at: at })
      .eq("event_id", eventId)
      .is("left_at", null);
    if (error && !isMissingSchemaError(error)) {
      console.error("[live] attendance close failed", error.message);
    }
  } catch (err) {
    console.error("[live] attendance close threw", err);
  }
}

/**
 * The hosts genuinely present in a room: host rows with a heartbeat inside
 * `sinceMs` that have not left. Staff and guest speakers alike — the caller
 * tells them apart with the speaker list.
 *
 * Three consumers, each answering a different question from the same rows:
 *   - the viewer window's extension past end+30m ("is the talk still on?");
 *   - the speaker End rule ("is a staff host here?");
 *   - the recorder pick ("which staff host records?").
 *
 * Returns NULL, not an empty list, when the table cannot be read (missing, or
 * a query error), because "nobody is here" and "we could not tell" lead to
 * different decisions: the speaker End rule fails open on null, while the
 * viewer extension treats it as nobody present.
 *
 * Server-only data about hosts, never a viewer roster: no viewer row is read.
 */
export async function presentHosts(
  eventId: string,
  sinceMs: number,
): Promise<{ userId: string; joinedAt: string; name: string }[] | null> {
  try {
    const admin = createAdminClient();
    const since = new Date(Date.now() - sinceMs).toISOString();
    const { data, error } = await admin
      .from("live_participants")
      .select("user_id, joined_at, display_name")
      .eq("event_id", eventId)
      .eq("role", "host")
      .is("left_at", null)
      .gte("last_seen_at", since)
      .limit(50);
    if (error) {
      if (!isMissingSchemaError(error)) {
        console.error("[live] host presence read failed", error.message);
      }
      return null;
    }
    return (data ?? []).map((r: any) => ({
      userId: r.user_id as string,
      joinedAt: r.joined_at as string,
      name: (r.display_name as string | null) || "Host",
    }));
  } catch (err) {
    console.error("[live] host presence read threw", err);
    return null;
  }
}

/**
 * Everyone currently alive in a room, from the attendance table.
 *
 * The reconcile backstop for a host: Realtime handles the normal case, and
 * this catches whatever a dropped message or a reload lost. Returns nothing
 * when the table is missing, which simply means the host relies on heartbeats
 * alone — a few seconds slower to notice an arrival, and otherwise identical.
 *
 * HOSTS ONLY. The caller must have resolved the caller as a host through
 * `resolveEventAccess` (lib/live-access.ts) and pass its `discloseNames`; this
 * returns the whole audience and there is deliberately no viewer-shaped
 * variant.
 */
export async function liveParticipants(
  /** The `events` row id — what the table is keyed on. */
  eventId: string,
  /**
   * The namespaced room id (`event:<uuid>`) — what channel keys are derived
   * from. Deliberately a separate parameter from `eventId` rather than
   * reconstructed here: these two strings are not interchangeable, and
   * deriving an inbox key from the wrong one yields a topic nobody is
   * listening on, which presents as "the host can see you but you never get
   * an offer" — a silent, one-sided failure.
   */
  roomId: string,
  withinMs: number,
  /**
   * Include each viewer's display name?
   *
   * False for a guest speaker. They get the same rows — they need every inbox
   * to broadcast — with the names withheld, so the reconcile backstop discloses
   * exactly as much as the join payload and no more. Passing this rather than
   * filtering at the call site keeps the two paths from drifting: a name that
   * is withheld on join and returned by the next reconcile poll is a leak with
   * a twelve-second fuse.
   */
  discloseNames = true,
): Promise<LivePeer[]> {
  try {
    const admin = createAdminClient();
    const since = new Date(Date.now() - withinMs).toISOString();
    const { data, error } = await admin
      .from("live_participants")
      .select("user_id, role, display_name")
      .eq("event_id", eventId)
      .is("left_at", null)
      .gte("last_seen_at", since)
      .limit(200);
    if (error) {
      if (!isMissingSchemaError(error)) {
        console.error("[live] roster read failed", error.message);
      }
      return [];
    }
    return (data ?? []).map((r: any) => {
      const role = (r.role === "host" ? "host" : "viewer") as SignalRole;
      return {
        peerId: r.user_id,
        name:
          discloseNames || role === "host" ? r.display_name || "Student" : "",
        role,
        inbox: inboxTopic(roomId, inboxKeyFor(roomId, r.user_id)),
      };
    });
  } catch (err) {
    console.error("[live] roster read threw", err);
    return [];
  }
}
