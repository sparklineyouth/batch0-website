"use server";
import { requireActor } from "@/lib/server-guards";
import { can } from "@/lib/permissions";
import { createClient } from "@/lib/supabase/server";
import { getInvite } from "@/lib/calls";
import { canJoin, joinState, inviteEndsAt } from "@/lib/live";
import { isHostedOnBatch0, normalizeAudienceMode, type AudienceMode } from "@/lib/webinars";
import { speakerUserIds } from "@/lib/webinar-data";
import {
  inboxTopic,
  PEER_TIMEOUT_MS,
  type SignalRole,
} from "@/lib/live-signal";
import {
  credentialsFor,
  inboxKeyFor,
  liveParticipants,
  markLeft,
  notifyHosts,
  touchParticipant,
  type LiveCredentials,
  type LivePeer,
} from "@/lib/live-rooms";

/**
 * Server actions for batch0 Live — the built-in webinar and call provider.
 *
 * Every action re-runs the full gate. A server action is its own entry point,
 * callable by anyone who can guess its id, so "the page rendered" proves
 * nothing about who is calling: `joinRoom` is what hands out the keys that
 * make a room reachable, and it must be exactly as strict as the page.
 *
 * Two kinds of room, one gate each, deliberately kept apart rather than
 * generalised into a single permissions check:
 *
 *   event — a hosted webinar. Read through the caller's OWN RLS, so the
 *           `events read` policy (0005) decides who may join, and the join
 *           gate cannot drift from the visibility gate. Broadcasting is the
 *           `events.manage` permission, the same one the admin panel uses and
 *           the same one the Daily path turned into `is_owner`.
 *
 *   call  — a 1:1. Not "can you see this page" but "are you one of the two":
 *           an admin reviewing the safeguarding list can read that a call
 *           happened without being able to walk into it. Both parties
 *           broadcast, because a 1:1 has no audience to hide.
 *
 * The role returned here is derived, never accepted. Nothing a client sends
 * influences whether it gets a broadcaster's credentials.
 */

export type RoomKind = "event" | "call";

/**
 * A resolved, authorized room.
 *
 * `roomId` is namespaced (`event:<uuid>`), and that prefix is load-bearing:
 * it is HMAC input for every channel key, so a webinar and a 1:1 that somehow
 * shared an id could never share a channel.
 */
type ResolvedRoom = {
  roomId: string;
  role: SignalRole;
  /** Peers already known from the row itself, before any Realtime discovery. */
  knownPeers: LivePeer[];
  /**
   * May this broadcaster be told WHO is watching, as opposed to how many?
   *
   * Guest speakers (migration 0084) broke the assumption that every
   * broadcaster is staff. A founder invited to talk holds one send-only
   * connection per viewer — the star topology gives them no choice — so they
   * need every viewer's inbox. They do not need anyone's name, and the
   * attendance list of a room containing minors should stay with the staff who
   * are accountable for it.
   *
   * True for `events.manage` holders and for both parties to a 1:1. False for
   * a guest speaker, which is the only case it exists for.
   */
  discloseNames: boolean;
  /** Decides whether a VIEWER is handed the room channel. See credentialsFor. */
  audienceMode: AudienceMode;
};

async function resolveRoom(
  kind: RoomKind,
  id: string,
): Promise<ResolvedRoom | null> {
  const actor = await requireActor();

  if (kind === "event") {
    // The caller's own RLS answers. A viewer who may not see the event gets
    // no row, and therefore no credentials — with no second rule to keep in
    // step with the `events read` policy.
    const supabase = await createClient();
    const { data } = await supabase
      .from("events")
      .select("id, starts_at, ends_at, live_mode, audience_mode")
      .eq("id", id)
      .maybeSingle();
    const ev = data as any;
    // Both batch0-hosted modes. A premiere plays a recording and then hands
    // over to this same room for the live Q&A, so it needs credentials for the
    // whole of its run — not only after the handover, because the chat and the
    // question queue are live from the first minute and that is most of what
    // makes a premiere feel live.
    if (!ev || !isHostedOnBatch0(ev.live_mode)) return null;
    if (!canJoin(joinState(ev.starts_at, ev.ends_at))) return null;

    // Two ways to broadcast, and the difference between them matters below.
    // `events.manage` is the staff grant: global, and the same one the admin
    // panel uses. A speaker row is the per-event grant that exists so a guest
    // does not have to be handed the admin panel for forty minutes of talking.
    const isStaffHost = can(actor.caps, "events.manage");
    const isSpeaker =
      !isStaffHost && (await speakerUserIds(ev.id)).includes(actor.userId);
    const role: SignalRole = isStaffHost || isSpeaker ? "host" : "viewer";
    const roomId = `event:${ev.id}`;
    const discloseNames = !isSpeaker;

    // A host gets the attendance-backed roster as a reconcile backstop; a
    // viewer gets nothing here and learns about the host from the stage
    // channel instead. This is the disclosure rule at its source — the
    // audience is not filtered out of the response, it is never fetched.
    const knownPeers =
      role === "host"
        ? await liveParticipants(ev.id, roomId, PEER_TIMEOUT_MS, discloseNames)
        : [];

    return {
      roomId,
      role,
      // Never hand a host its own row back as a peer to call.
      knownPeers: knownPeers.filter((p) => p.peerId !== actor.userId),
      discloseNames,
      audienceMode: normalizeAudienceMode(ev.audience_mode),
    };
  }

  // ---- 1:1 call ----------------------------------------------------------
  const invite = await getInvite(id);
  if (!invite) return null;
  const isHost = invite.hostId === actor.userId;
  const isInvitee = invite.inviteeId === actor.userId;
  if (!isHost && !isInvitee) return null;
  if (invite.status !== "accepted") return null;
  if (!canJoin(joinState(invite.startsAt, inviteEndsAt(invite)))) return null;

  const roomId = `call:${invite.id}`;
  // The other person, known from the row — so a 1:1 needs no discovery at
  // all and connects the moment both sides are on the page.
  const otherId = isHost ? invite.inviteeId : invite.hostId;
  const otherName = isHost ? invite.inviteeName : invite.hostName;

  return {
    roomId,
    // Both parties broadcast. A viewer role here would leave one of them
    // unable to speak in their own meeting.
    role: "host",
    // Two named people who accepted an invite to each other. There is no
    // audience here to protect, and withholding the name would leave each of
    // them looking at an unlabelled tile.
    discloseNames: true,
    // A 1:1 has no audience channel at all; `private` is what stops
    // credentialsFor handing one out.
    audienceMode: "private",
    knownPeers: [
      {
        peerId: otherId,
        name: otherName,
        role: "host",
        inbox: inboxTopic(roomId, inboxKeyFor(roomId, otherId)),
      },
    ],
  };
}

/**
 * Join a room: authorize, then mint this participant's channel keys.
 *
 * Returns null when the caller may not join — the same answer for "no such
 * room", "not yours", and "not open yet", so this can't be used to probe
 * which events exist.
 */
export async function joinRoom(
  kind: RoomKind,
  id: string,
): Promise<LiveCredentials | null> {
  const actor = await requireActor();
  const room = await resolveRoom(kind, id);
  if (!room) return null;

  const supabase = await createClient();
  const { data: profile } = await supabase
    .from("profiles")
    .select("full_name")
    .eq("id", actor.userId)
    .maybeSingle();
  const name = (profile as any)?.full_name || "Guest";

  // Deliberately does NOT announce.
  //
  // Announcing here would be a race the viewer always loses: the server would
  // publish "peer-online" to the lobby while the browser is still awaiting
  // this very call, so the host's offer would go out before the viewer had
  // subscribed to its own inbox — and a Realtime broadcast has no replay, so
  // that offer is simply gone. The symptom is brutal to read from a
  // screenshot: the host sits at `have-local-offer` forever and the student
  // holds no peer connection at all.
  //
  // So the client subscribes first and calls announcePresence() second. That
  // ordering is the contract; see useLiveSession's lifecycle effect.
  return credentialsFor({
    eventId: room.roomId,
    peerId: actor.userId,
    name,
    role: room.role,
    peers: room.knownPeers,
    audienceMode: room.audienceMode,
    discloseNames: room.discloseNames,
  });
}

/**
 * Re-announce: the heartbeat, and the self-healing mechanism.
 *
 * Called on join and then every HEARTBEAT_MS. It is what makes a host who
 * reloads mid-webinar pick the whole room back up without anyone clicking
 * anything, and what repairs a lobby message Realtime happened to drop.
 *
 * Re-gated in full every time — a heartbeat is not a lighter-weight call just
 * because it repeats. Someone unenrolled mid-session stops being announced to
 * the host, and their next heartbeat returns false.
 */
export async function announcePresence(
  kind: RoomKind,
  id: string,
): Promise<boolean> {
  const actor = await requireActor();
  const room = await resolveRoom(kind, id);
  if (!room) return false;

  const supabase = await createClient();
  const { data: profile } = await supabase
    .from("profiles")
    .select("full_name")
    .eq("id", actor.userId)
    .maybeSingle();

  await announceInternal(
    kind,
    id,
    room,
    actor.userId,
    (profile as any)?.full_name || "Guest",
  );
  return true;
}

async function announceInternal(
  kind: RoomKind,
  id: string,
  room: ResolvedRoom,
  userId: string,
  name: string,
): Promise<void> {
  // Tell the hosts. The viewer never holds the lobby key — the server
  // publishes on its behalf, which is what keeps one viewer from watching
  // every other arrival in the room.
  //
  // A 1:1 has no lobby: both sides already know each other from the invite
  // row, so there is nobody to announce to.
  if (kind === "event") {
    await notifyHosts(room.roomId, {
      t: "peer-online",
      peerId: userId,
      // A VIEWER'S NAME NEVER CROSSES THE LOBBY.
      //
      // The lobby key goes to every broadcaster, and since migration 0084 a
      // broadcaster may be a guest speaker rather than staff. Anything put on
      // this channel is therefore readable by an outsider with devtools open,
      // and "who is watching" is precisely what an outsider should not have.
      //
      // Nothing is lost by withholding it: the engine only ever renders peers
      // whose role is `host` (see publish() in use-live-session.ts), so a
      // viewer's name on this message was never drawn anywhere. Staff who
      // genuinely need the roster — for the attendance panel — get it from
      // listAudience(), which is a server action that can check the permission
      // this broadcast cannot.
      //
      // A host's name still travels, because a co-host IS rendered, and their
      // name is already public to the whole room the moment they appear on
      // camera.
      name: room.role === "host" ? name : "",
      role: room.role,
      inbox: inboxTopic(room.roomId, inboxKeyFor(room.roomId, userId)),
    });

    // Attendance. Best-effort and deliberately last: discovery has already
    // happened above, so a missing `live_participants` table (0076 not yet
    // run) costs the attendance record and nothing else.
    await touchParticipant({
      eventId: id,
      userId,
      role: room.role,
      displayName: name,
    });
  }
}

/**
 * Leave cleanly.
 *
 * The heartbeat timeout would notice eventually, but "eventually" is up to
 * PEER_TIMEOUT_MS of a host staring at a tile for someone who has gone. This
 * makes it immediate. Best-effort on purpose — it is fired from `pagehide`,
 * where the browser may cut the request off mid-flight, and the timeout
 * remains the backstop.
 */
export async function leaveRoom(kind: RoomKind, id: string): Promise<void> {
  const actor = await requireActor();
  const room = await resolveRoom(kind, id);
  if (!room) return;
  if (kind === "event") {
    await notifyHosts(room.roomId, { t: "peer-offline", peerId: actor.userId });
    await markLeft(id, actor.userId);
  }
}

/**
 * The host's reconcile query: who is alive right now.
 *
 * HOSTS ONLY — a viewer asking gets an empty list rather than an error,
 * because this is polled on a timer and a thrown error would surface as a
 * broken room rather than as the non-answer it is.
 *
 * Returns nothing when `live_participants` is missing, in which case the host
 * relies on heartbeats alone: a few seconds slower to notice an arrival, and
 * otherwise identical. The webinar works either way.
 */
export async function listAudience(
  kind: RoomKind,
  id: string,
): Promise<LivePeer[]> {
  const actor = await requireActor();
  const room = await resolveRoom(kind, id);
  if (!room || room.role !== "host" || kind !== "event") return [];
  const peers = await liveParticipants(
    id,
    room.roomId,
    PEER_TIMEOUT_MS,
    room.discloseNames,
  );
  return peers.filter((p) => p.peerId !== actor.userId);
}
