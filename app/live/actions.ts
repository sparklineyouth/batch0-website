"use server";
import { requireActor } from "@/lib/server-guards";
import { createClient } from "@/lib/supabase/server";
import { type RoomStatus } from "@/lib/live";
import { isHostedOnBatch0, type AudienceMode } from "@/lib/webinars";
import {
  inboxTopic,
  PEER_TIMEOUT_MS,
  type SignalRole,
} from "@/lib/live-signal";
import {
  credentialsFor,
  inboxKeyFor,
  liveParticipants,
  notifyHosts,
  touchParticipant,
  type LiveCredentials,
  type LivePeer,
} from "@/lib/live-rooms";
import {
  callRefusal,
  callRoomStatus,
  leaveInternal,
  resolveCallAccess,
  resolveEventAccess,
  roomAccessFor,
  type CallAccess,
  type EventAccess,
  type LiveRoomKind,
} from "@/lib/live-access";

/**
 * Server actions for batch0 Live — the built-in webinar and call provider.
 *
 * Every action re-runs the full gate. A server action is its own entry point,
 * callable by anyone who can guess its id, so "the page rendered" proves
 * nothing about who is calling: `joinRoom` is what hands out the keys that
 * make a room reachable, and it must be exactly as strict as the page.
 *
 * Two kinds of room, one gate each, deliberately kept apart rather than
 * generalised into a single permissions check. Both gates live in
 * lib/live-access.ts, which the page and every other live action share:
 *
 *   event — a hosted webinar. Read through the caller's OWN RLS (plus the
 *           events.manage re-read described there), so the `events read`
 *           policy decides who may join. Broadcasting is `events.manage` or a
 *           claimed speaker row, via `canBroadcast` — the same answer the page
 *           renders from, so the role on the screen and the role in the
 *           credentials cannot disagree.
 *
 *   call  — a 1:1. Not "can you see this page" but "are you one of the two":
 *           an admin reviewing the safeguarding list can read that a call
 *           happened without being able to walk into it. Both parties
 *           broadcast, because a 1:1 has no audience to hide; the inviter is
 *           the call's owner (and the side that records).
 *
 * The role returned here is derived, never accepted. Nothing a client sends
 * influences whether it gets a broadcaster's credentials.
 *
 * ---------------------------------------------------------------------------
 * Leave vs End, on the server
 * ---------------------------------------------------------------------------
 *
 *   leaveRoom  "I go; the room keeps running." Identity only — never gated on
 *              the window, a status, or visibility — so it works after End,
 *              after a cancel, past the window, and from `pagehide` (where the
 *              /api/live/leave beacon route runs the same leaveInternal).
 *   End        A webinar's End is `endLive` in the room actions: it stamps
 *              `live_ended_at` and sends a content-free `room-changed` on the
 *              room's public stage topic, and from then on joinRoom and
 *              announcePresence refuse the room with status 'ended' — for
 *              everyone, hosts included, until staff Reopen it. A 1:1's is
 *              `endCall` in app/calls/actions.ts, which marks the invite
 *              completed; each side's room notices on its status poll, and
 *              this heartbeat answers 'ended' too. A completed call never
 *              reopens.
 */

export type RoomKind = LiveRoomKind;

/**
 * Why a join was refused. Only ever more specific than `no-access` AFTER the
 * access check has passed, so none of these reveal that an event or call you
 * cannot see exists.
 *
 *   no-access   no such room, not yours, or not visible to you
 *   error       a query failed — retry; never a revocation
 *   not-hosted  the event exists and you may see it, but it is not a batch0
 *               room (an external Zoom link)
 *   early       your window has not opened (hosts: start-60m; viewers:
 *               start-15m; calls: start-15m)
 *   ended       a webinar was ended for everyone (hosts too — Reopen first)
 *   closed      your window has passed, or a call was never accepted
 *   completed   the 1:1 was ended, or its window closed
 *   cancelled / declined   the 1:1's status
 */
export type JoinRefusal =
  | "no-access"
  | "error"
  | "not-hosted"
  | "early"
  | "ended"
  | "closed"
  | "completed"
  | "cancelled"
  | "declined";

export type JoinResult =
  | {
      ok: true;
      creds: LiveCredentials;
      /**
       * The role the server minted — the only one to trust. If it differs from
       * the role the page rendered with, the client should remount with this
       * one rather than run a host engine on viewer credentials.
       */
      role: SignalRole;
    }
  | { ok: false; reason: JoinRefusal };

export type PresenceResult = {
  /** See RoomStatus in lib/live.ts; act on it with nextStatusAction. */
  status: RoomStatus;
};

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
  event: EventAccess | null;
  call: CallAccess | null;
};

type Resolution =
  | { ok: true; room: ResolvedRoom }
  | { ok: false; reason: JoinRefusal; status: RoomStatus };

/**
 * Authorize the caller for a room, without fetching any roster.
 *
 * Authorization and roster loading used to be one function, so every host
 * heartbeat and every leave read up to 200 attendance rows and threw them
 * away. The roster is now fetched only where it is used: joinRoom and
 * listAudience.
 */
async function resolveRoom(kind: RoomKind, id: string): Promise<Resolution> {
  if (kind === "event") {
    const access = await resolveEventAccess(id);
    if (!access.ok) {
      return access.reason === "error"
        ? { ok: false, reason: "error", status: "error" }
        : { ok: false, reason: "no-access", status: "revoked" };
    }
    // Both batch0-hosted modes. A premiere plays a recording and then hands
    // over to this same room for the live Q&A, so it needs credentials for the
    // whole of its run — not only after the handover, because the chat and the
    // question queue are live from the first minute and that is most of what
    // makes a premiere feel live.
    if (!isHostedOnBatch0(access.event.liveMode)) {
      return { ok: false, reason: "not-hosted", status: "revoked" };
    }
    // Ended is terminal for EVERYONE here, hosts included: an ended webinar
    // hands out no credentials and records no attendance. Staff reach the
    // ended screen through the page (their window still covers it) and come
    // back in only through an explicit Reopen — pressing Start never reopens.
    if (access.event.liveEndedAt) {
      return { ok: false, reason: "ended", status: "ended" };
    }
    const where = await roomAccessFor(access);
    if (where === "early") return { ok: false, reason: "early", status: "closed" };
    if (where === "closed") return { ok: false, reason: "closed", status: "closed" };
    if (where === "ended") return { ok: false, reason: "ended", status: "ended" };

    return {
      ok: true,
      room: {
        roomId: `event:${access.event.id}`,
        role: access.role,
        discloseNames: access.discloseNames,
        audienceMode: access.event.audienceMode,
        event: access,
        call: null,
      },
    };
  }

  // ---- 1:1 call ----------------------------------------------------------
  const access = await resolveCallAccess(id);
  if (!access.ok) {
    return access.reason === "error"
      ? { ok: false, reason: "error", status: "error" }
      : { ok: false, reason: "no-access", status: "revoked" };
  }
  const refusal = callRefusal(access.phase);
  if (refusal) {
    return { ok: false, reason: refusal, status: callRoomStatus(access.phase) };
  }
  return {
    ok: true,
    room: {
      roomId: access.roomId,
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
      event: null,
      call: access,
    },
  };
}

async function displayName(userId: string): Promise<string> {
  const supabase = await createClient();
  const { data: profile } = await supabase
    .from("profiles")
    .select("full_name")
    .eq("id", userId)
    .maybeSingle();
  return (profile as any)?.full_name || "Guest";
}

/**
 * Join a room: authorize, then mint this participant's channel keys.
 *
 * Refuses with a reason (see JoinRefusal) rather than a bare null, so the
 * client can say "This webinar has ended" or "The call has ended" instead of
 * a generic failure — and so an ended room can never be re-entered by
 * pressing Start.
 */
export async function joinRoom(kind: RoomKind, id: string): Promise<JoinResult> {
  const actor = await requireActor();
  const resolved = await resolveRoom(kind, id);
  if (!resolved.ok) return { ok: false, reason: resolved.reason };
  const room = resolved.room;

  // Peers known before any Realtime discovery.
  //
  //   event host   the attendance-backed roster, as a reconcile backstop —
  //                names withheld for a guest speaker (discloseNames).
  //   event viewer nothing. They learn about the host from the stage channel.
  //                This is the disclosure rule at its source: the audience is
  //                not filtered out of the response, it is never fetched.
  //   call         the other person, from the invite row — so a 1:1 needs no
  //                discovery at all and connects the moment both sides are on
  //                the page.
  let knownPeers: LivePeer[] = [];
  if (room.event && room.role === "host") {
    knownPeers = (
      await liveParticipants(
        room.event.event.id,
        room.roomId,
        PEER_TIMEOUT_MS,
        room.discloseNames,
      )
    ).filter((p) => p.peerId !== actor.userId);
  } else if (room.call) {
    knownPeers = [
      {
        peerId: room.call.otherId,
        name: room.call.otherName,
        role: "host",
        inbox: inboxTopic(room.roomId, inboxKeyFor(room.roomId, room.call.otherId)),
      },
    ];
  }

  const name = await displayName(actor.userId);

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
  const creds = credentialsFor({
    eventId: room.roomId,
    peerId: actor.userId,
    name,
    role: room.role,
    peers: knownPeers,
    audienceMode: room.audienceMode,
    discloseNames: room.discloseNames,
  });
  return { ok: true, creds, role: room.role };
}

/**
 * Re-announce: the heartbeat, and the self-healing mechanism.
 *
 * Called on join and then every HEARTBEAT_MS, and immediately whenever a
 * `room-changed` hint arrives on the stage. It is what makes a host who
 * reloads mid-webinar pick the whole room back up without anyone clicking
 * anything, what repairs a lobby message Realtime happened to drop — and,
 * since it returns a status rather than a boolean nobody read, what tells a
 * client its room was ended, cancelled, closed or taken away from it.
 *
 * Re-gated in full every time — a heartbeat is not a lighter-weight call just
 * because it repeats. When the answer is anything but 'ok' nothing is
 * announced and no attendance is touched: an ended webinar stops accruing
 * minutes for tabs left open on it.
 *
 * `joinedAs` is the role the caller's credentials were minted with. A host
 * whose grant was removed mid-session (a speaker row deleted) gets 'revoked'
 * rather than being silently re-announced as a viewer while still holding
 * host keys. A viewer who has since become a host is left alone — they pick
 * up the new role on their next join.
 */
export async function announcePresence(
  kind: RoomKind,
  id: string,
  joinedAs?: SignalRole,
): Promise<PresenceResult> {
  const actor = await requireActor();
  const resolved = await resolveRoom(kind, id);
  if (!resolved.ok) return { status: resolved.status };
  const room = resolved.room;
  if (joinedAs === "host" && room.role !== "host") {
    return { status: "revoked" };
  }

  // A 1:1 has no lobby and no attendance record: both sides already know each
  // other from the invite row, so there is nobody to announce to. The status
  // is the whole answer.
  if (!room.event) return { status: "ok" };

  const name = await displayName(actor.userId);

  // Tell the hosts. The viewer never holds the lobby key — the server
  // publishes on its behalf, which is what keeps one viewer from watching
  // every other arrival in the room.
  await notifyHosts(room.roomId, {
    t: "peer-online",
    peerId: actor.userId,
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
    inbox: inboxTopic(room.roomId, inboxKeyFor(room.roomId, actor.userId)),
  });

  // Attendance. Best-effort and deliberately after discovery, so a missing
  // `live_participants` table (0076 not yet run) costs the attendance record
  // and nothing else.
  await touchParticipant({
    eventId: room.event.event.id,
    userId: actor.userId,
    role: room.role,
    displayName: name,
  });

  return { status: "ok" };
}

/**
 * Leave cleanly: "I go; the room keeps running."
 *
 * The heartbeat timeout would notice eventually, but "eventually" is up to
 * PEER_TIMEOUT_MS of a host staring at a tile for someone who has gone. This
 * makes it immediate.
 *
 * IDENTITY ONLY (see leaveInternal in lib/live-access.ts). It used to run the
 * full join gate first, which meant leaving silently did nothing once the
 * window had closed or the room had ended — exactly when people leave. The
 * tab-close path does not use this action at all: a server action fired from
 * `pagehide` is usually aborted by the browser, so the client beacons
 * /api/live/leave, which runs the same code.
 */
export async function leaveRoom(kind: RoomKind, id: string): Promise<void> {
  const actor = await requireActor();
  await leaveInternal(kind, id, actor.userId);
}

/**
 * The host's reconcile query: who is alive right now.
 *
 * HOSTS ONLY — a viewer asking gets an empty list rather than an error,
 * because this is polled on a timer and a thrown error would surface as a
 * broken room rather than as the non-answer it is. A guest speaker gets the
 * rows with viewers' names withheld, exactly as in their join payload.
 *
 * Returns nothing when `live_participants` is missing, in which case the host
 * relies on heartbeats alone: a few seconds slower to notice an arrival, and
 * otherwise identical. The webinar works either way.
 */
export async function listAudience(
  kind: RoomKind,
  id: string,
): Promise<LivePeer[]> {
  if (kind !== "event") return [];
  const actor = await requireActor();
  const resolved = await resolveRoom(kind, id);
  if (!resolved.ok || resolved.room.role !== "host" || !resolved.room.event) {
    return [];
  }
  const peers = await liveParticipants(
    resolved.room.event.event.id,
    resolved.room.roomId,
    PEER_TIMEOUT_MS,
    resolved.room.discloseNames,
  );
  return peers.filter((p) => p.peerId !== actor.userId);
}
