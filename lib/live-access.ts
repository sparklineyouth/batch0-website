import "server-only";
import { requireActor } from "@/lib/server-guards";
import { can, type Capabilities } from "@/lib/permissions";
import { capabilitiesForRole } from "@/lib/roles";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  inviteEndsAt,
  roomAccess,
  roomWindow,
  type CallInviteStatus,
  type RoomAccess,
  type RoomStatus,
} from "@/lib/live";
import { callPhase, type CallPhase } from "@/lib/call-lifecycle";
import {
  canBroadcast,
  normalizeAudienceMode,
  type AudienceMode,
} from "@/lib/webinars";
import { PEER_TIMEOUT_MS, type SignalRole } from "@/lib/live-signal";
import { markLeft, notifyHosts, presentHosts } from "@/lib/live-rooms";

/**
 * Who someone is in a live room — computed once, here, for every consumer.
 *
 * Before this file the host rule ("events.manage, or a claimed speaker row")
 * was re-implemented in five or six places — the page, resolveRoom, gateRoom,
 * gateWrite, the legacy Q&A actions — and they had already drifted: the Q&A
 * actions ignored speakers, so a guest speaker got a host panel whose every
 * button threw Forbidden. Now the page, joinRoom/announce/leave, the room
 * gates, the upload gate and the Q&A actions all call `resolveEventAccess`,
 * which calls `canBroadcast`, and server and client cannot disagree about who
 * is hosting.
 *
 * ---------------------------------------------------------------------------
 * The admin-client read, and why it is confined to this file
 * ---------------------------------------------------------------------------
 *
 * The event is read through the CALLER'S OWN RLS first, so the `events read`
 * policy decides who may see it — exactly as before. But that policy's staff
 * clause is `is_staff()`, which means `mentor.panel`, not `events.manage`. So
 * an intern (events.manage, no mentor.panel) got no row for a cohort webinar
 * they were meant to host, and a 404. Rather than a migration, a caller who
 * holds `events.manage` and got no row is re-read with the admin client.
 *
 * That bypasses RLS for that one permission and nobody else, and it must stay
 * inside this file: it is not a general "read an event" helper, and reusing it
 * for a viewer would hand them every event on the calendar. The rule an admin
 * is never downgraded to viewer depends on it — neither the mentor.panel-based
 * policy, nor the viewer join window, nor the speaker rows ever decide an
 * admin's role.
 *
 * ---------------------------------------------------------------------------
 * Denials are typed, and "error" is not "no"
 * ---------------------------------------------------------------------------
 *
 * `no-access` is the one answer for "no such event", "not yours" and "not
 * visible to you", so this cannot be used to probe which events exist.
 * `error` means a query failed. Keeping them apart is what stops a transient
 * database error from looking like a revocation and kicking a whole room out:
 * the heartbeat reports `error`, and the client ignores it.
 */

export type LiveRoomKind = "event" | "call";

/** The columns every live surface needs. Names no column a student may not see. */
const EVENT_COLUMNS =
  "id, title, description, type, starts_at, ends_at, live_mode, audience_mode, " +
  "display_viewer_count, auto_record, premiere_seconds, qa_opens_at, " +
  "live_started_at, live_ended_at, visibility, cohort_id, recording_url, " +
  "daily_room_name, daily_room_url";

export type LiveAccessEvent = {
  id: string;
  title: string;
  description: string | null;
  type: string;
  startsAt: string;
  endsAt: string | null;
  liveMode: string;
  audienceMode: AudienceMode;
  displayViewerCount: number | null;
  autoRecord: boolean;
  premiereSeconds: number | null;
  qaOpensAt: string | null;
  liveStartedAt: string | null;
  liveEndedAt: string | null;
  visibility: string;
  cohortId: string | null;
  recordingUrl: string | null;
  /** Daily-provider leftovers. Only the opt-in Daily branch of the page reads these. */
  dailyRoomName: string | null;
  dailyRoomUrl: string | null;
};

export type EventAccess = {
  ok: true;
  event: LiveAccessEvent;
  userId: string;
  caps: Capabilities;
  /**
   * Staff host: holds `events.manage` (admins through `*`, and any custom role
   * it is ticked on). Broadcasts, moderates, sees audience names and the real
   * headcount, and owns End for everyone (always, from the start) and Reopen.
   * Recording is not staff's alone: the room elects one recorder among every
   * host present, guest speakers included (electRecorder in lib/webinars.ts).
   */
  isStaff: boolean;
  /**
   * Guest speaker: a claimed speaker row on THIS event and not staff.
   * Broadcasts and moderates; never told who is watching; ends for everyone
   * only when no staff host is present (see canEndForEveryone).
   */
  isSpeaker: boolean;
  /** `canBroadcast` — staff or speaker. */
  isHost: boolean;
  /** The signal role credentials are minted with. */
  role: SignalRole;
  /**
   * May this broadcaster be told WHO is watching? False for a guest speaker,
   * which is the only case it exists for; audience privacy rests on it.
   */
  discloseNames: boolean;
};

export type AccessDenied = { ok: false; reason: "no-access" | "error" };

/**
 * Resolve the caller's standing in one event's room.
 *
 * Throws only when signed out (via requireActor), exactly like every other
 * guard. Deliberately does NOT check `live_mode` or any window: the page needs
 * the row to render "this isn't hosted on batch0" or "this opens at…", and the
 * gates apply `isHostedOnBatch0` and `roomAccessFor` themselves.
 */
export async function resolveEventAccess(
  eventId: string,
): Promise<EventAccess | AccessDenied> {
  const actor = await requireActor();
  const isStaff = can(actor.caps, "events.manage");

  const supabase = await createClient();
  const first = await supabase
    .from("events")
    .select(EVENT_COLUMNS)
    .eq("id", eventId)
    .maybeSingle();
  if (first.error && !isBadId(first.error)) {
    console.error("[live-access] event read failed", first.error.message);
    return { ok: false, reason: "error" };
  }
  let row: any = first.data;

  // The events.manage re-read. See the header for why this exists and why it
  // lives nowhere else.
  if (!row && isStaff && !first.error) {
    const admin = createAdminClient();
    const second = await admin
      .from("events")
      .select(EVENT_COLUMNS)
      .eq("id", eventId)
      .maybeSingle();
    if (second.error && !isBadId(second.error)) {
      console.error("[live-access] staff event read failed", second.error.message);
      return { ok: false, reason: "error" };
    }
    row = second.data;
  }
  if (!row) return { ok: false, reason: "no-access" };

  // Staff never need the speaker list to know their role — and must never
  // have it decide their role. Everyone else does.
  let speakerIds: string[] = [];
  if (!isStaff) {
    const read = await readSpeakerIds(row.id);
    if (read === null) return { ok: false, reason: "error" };
    speakerIds = read;
  }

  const isHost = canBroadcast({
    hasEventsManage: isStaff,
    userId: actor.userId,
    speakers: speakerIds.map((userId) => ({ userId })),
  });
  const isSpeaker = !isStaff && isHost;

  return {
    ok: true,
    event: toAccessEvent(row),
    userId: actor.userId,
    caps: actor.caps,
    isStaff,
    isSpeaker,
    isHost,
    role: isHost ? "host" : "viewer",
    discloseNames: !isSpeaker,
  };
}

/**
 * The caller's `roomAccess`, looking host presence up only when it matters.
 *
 * Presence only changes the answer for a viewer past end+30m in a room nobody
 * has ended (see roomAccess in lib/live.ts), so every other call costs no
 * query at all. An unreadable attendance table counts as nobody present: the
 * extension is a courtesy for overrunning talks, and failing it closed ends at
 * the time the audience was promised anyway.
 */
export async function roomAccessFor(
  access: EventAccess,
  now: Date = new Date(),
): Promise<RoomAccess> {
  const input = {
    startsAt: access.event.startsAt,
    endsAt: access.event.endsAt,
    liveEndedAt: access.event.liveEndedAt,
    isHost: access.isHost,
    now,
  };
  const first = roomAccess({ ...input, hostPresent: false });
  if (first !== "closed" || access.isHost || access.event.liveEndedAt) {
    return first;
  }
  const w = roomWindow(access.event.startsAt, access.event.endsAt);
  if (now.getTime() > w.hardCloseAt) return first;
  const hosts = await presentHosts(access.event.id, PEER_TIMEOUT_MS);
  return roomAccess({ ...input, hostPresent: !!hosts && hosts.length > 0 });
}

/**
 * The hosts present in an event's room right now, each marked staff or not
 * by THEIR OWN role — never by whether they are on the speaker list.
 *
 * Where the speaker End rule ("is a staff host here?") learns who is who. It
 * used to call a present host staff only if they were NOT on the speaker
 * list, which went wrong for anyone who is both: a staff member who opened a
 * guest's claim link to test it (claiming is now refused for staff, but rows
 * from before that stay), or a guest later promoted to a role with
 * `events.manage`. Their presence did not stop a guest speaker from ending
 * the room under them. Now staff means `events.manage` on the person's role,
 * the same test resolveEventAccess applies to the caller.
 *
 * Null when presence cannot be read at all (see presentHosts: callers decide
 * what "could not tell" means for them). If only the roles cannot be read, it
 * falls back to the speaker list — the old rule, right for everyone who is
 * not both — rather than guessing.
 */
export async function presentHostRoles(
  eventId: string,
): Promise<{ userId: string; joinedAt: string; isStaff: boolean }[] | null> {
  const hosts = await presentHosts(eventId, PEER_TIMEOUT_MS);
  if (hosts === null) return null;
  if (hosts.length === 0) return [];
  const staff = await staffAmong(hosts.map((h) => h.userId));
  if (staff) return hosts.map((h) => ({ ...h, isStaff: staff.has(h.userId) }));
  const speakers = new Set((await readSpeakerIds(eventId)) ?? []);
  return hosts.map((h) => ({ ...h, isStaff: !speakers.has(h.userId) }));
}

/**
 * Which of these users hold `events.manage`, from each one's profile role.
 * Null when the profiles could not be read.
 */
async function staffAmong(userIds: readonly string[]): Promise<Set<string> | null> {
  const ids = [...new Set(userIds)].filter(Boolean);
  if (ids.length === 0) return new Set();
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("profiles")
    .select("id, role")
    .in("id", ids);
  if (error) {
    console.error("[live-access] host role read failed", error.message);
    return null;
  }
  const staff = new Set<string>();
  // capabilitiesForRole reads the (request-cached) role table once, so this
  // is one query however many hosts there are.
  await Promise.all(
    ((data ?? []) as { id: string; role: string | null }[]).map(async (r) => {
      if (can(await capabilitiesForRole(r.role), "events.manage")) {
        staff.add(r.id);
      }
    }),
  );
  return staff;
}

/**
 * Is `now` still inside this event's hard stop (end + 3h)?
 *
 * The one bound on End and Reopen, which are otherwise never window-gated: an
 * overrunning webinar must always be endable, and a stale stamp must always be
 * clearable by staff, but a webinar from last month is not a room anyone
 * should be flipping on and off.
 */
export function withinHardClose(
  event: Pick<LiveAccessEvent, "startsAt" | "endsAt">,
  now: Date = new Date(),
): boolean {
  return now.getTime() <= roomWindow(event.startsAt, event.endsAt).hardCloseAt;
}

// ---------------------------------------------------------------------------
// 1:1 calls
// ---------------------------------------------------------------------------

export type CallAccess = {
  ok: true;
  userId: string;
  caps: Capabilities;
  inviteId: string;
  /** Namespaced (`call:<uuid>`) — the HMAC input for every channel key. */
  roomId: string;
  hostId: string;
  inviteeId: string;
  /**
   * The inviter — the call's owner/host, and the side that records. Invitees
   * are always students, so an admin in a call is always its owner. (Either
   * person may End call — see endCall in app/calls/actions.ts.)
   */
  isOwner: boolean;
  otherId: string;
  otherName: string;
  hostName: string;
  hostRole: string;
  inviteeName: string;
  status: CallInviteStatus;
  startsAt: string;
  durationMinutes: number;
  endsAt: string;
  topic: string | null;
  /**
   * callPhase (lib/call-lifecycle.ts) at resolve time — the same answer the
   * lists, the page and the lifecycle sweep use. See callRefusal for what
   * each means for a join.
   */
  phase: CallPhase;
};

/**
 * Resolve the caller's standing in one 1:1.
 *
 * "Are you one of the two?" and nothing else — the safeguarding rule. An admin
 * who is not a party gets `no-access` (the same answer as "no such call"), and
 * the read-only observer card on /admin/calls is the whole of their view: they
 * can see that a call happened, and a superAdmin can Cancel it, but nobody can
 * walk into two people's call.
 *
 * Returns the phase instead of refusing on it, because the answers after the
 * party check differ by caller: leaving needs only identity, and the join and
 * the heartbeat need `callRefusal(phase)` / `callRoomStatus(phase)`. Nothing
 * about a call's status is revealed to a non-party.
 */
export async function resolveCallAccess(
  inviteId: string,
  now: Date = new Date(),
): Promise<CallAccess | AccessDenied> {
  const actor = await requireActor();
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("call_invites")
    .select(
      "id, host_id, invitee_id, starts_at, duration_minutes, topic, status, " +
        "host:profiles!call_invites_host_id_fkey(full_name, role), " +
        "invitee:profiles!call_invites_invitee_id_fkey(full_name)",
    )
    .eq("id", inviteId)
    .maybeSingle();
  if (error && !isBadId(error)) {
    console.error("[live-access] invite read failed", error.message);
    return { ok: false, reason: "error" };
  }
  const row = data as any;
  if (!row) return { ok: false, reason: "no-access" };

  const isOwner = row.host_id === actor.userId;
  const isInvitee = row.invitee_id === actor.userId;
  if (!isOwner && !isInvitee) return { ok: false, reason: "no-access" };

  const host = one<any>(row.host);
  const invitee = one<any>(row.invitee);
  const hostName = host?.full_name || "A member of the team";
  const inviteeName = invitee?.full_name || "Student";
  const invite = {
    status: row.status as CallInviteStatus,
    startsAt: row.starts_at as string,
    durationMinutes: row.duration_minutes as number,
  };

  return {
    ok: true,
    userId: actor.userId,
    caps: actor.caps,
    inviteId: row.id,
    roomId: `call:${row.id}`,
    hostId: row.host_id,
    inviteeId: row.invitee_id,
    isOwner,
    otherId: isOwner ? row.invitee_id : row.host_id,
    otherName: isOwner ? inviteeName : hostName,
    hostName,
    hostRole: host?.role || "mentor",
    inviteeName,
    status: invite.status,
    startsAt: invite.startsAt,
    durationMinutes: invite.durationMinutes,
    endsAt: inviteEndsAt(invite),
    topic: row.topic ?? null,
    phase: callPhase(invite, now),
  };
}

/**
 * Why a party may not be in their call right now, or null when they may.
 *
 *   joinable / live       null — come in.
 *   upcoming              'early'
 *   needs_answer/expired  'closed' (never accepted; there is no call yet)
 *   completed / ended     'completed' (End call pressed, or the window closed
 *                         — the same call to a person; see callPhase)
 *   cancelled / declined  as named
 */
export type CallRefusal =
  | "early"
  | "closed"
  | "completed"
  | "cancelled"
  | "declined";

export function callRefusal(phase: CallPhase): CallRefusal | null {
  if (phase === "joinable" || phase === "live") return null;
  if (phase === "upcoming") return "early";
  if (phase === "completed" || phase === "ended") return "completed";
  if (phase === "cancelled" || phase === "declined") return phase;
  return "closed";
}

/** The heartbeat's answer for a call in this phase. */
export function callRoomStatus(phase: CallPhase): RoomStatus {
  if (phase === "joinable" || phase === "live") return "ok";
  if (phase === "completed" || phase === "ended") return "ended";
  if (phase === "cancelled") return "cancelled";
  if (phase === "declined") return "revoked";
  return "closed";
}

// ---------------------------------------------------------------------------
// Leaving
// ---------------------------------------------------------------------------

/**
 * Leave a room: the shared body of the `leaveRoom` server action and the
 * `/api/live/leave` beacon route.
 *
 * IDENTITY ONLY — no visibility re-read, no window, no role. That is the
 * point: leaving has to work after the window closed, after an End, after a
 * cancel, and from a `pagehide` handler where there is no time for a gate. It
 * is safe because the only writes are about the caller themself, keyed on the
 * id the auth server vouched for:
 *
 *   event  `left_at` on the caller's OWN attendance row (a no-op if they never
 *          had one), and a `peer-offline` for the caller's own id on that
 *          room's lobby, so hosts drop their tile at once instead of after
 *          PEER_TIMEOUT_MS. The lobby is host-only, and a viewer's departure
 *          carries no name — nothing about the audience is disclosed.
 *   call   nothing server-side. A 1:1 keeps no presence record (there is no
 *          call attendance table; see P56 in the live design notes), and the
 *          departing party's `bye` is what tells the other side. The call is
 *          NOT completed by leaving — End call does that, or the lifecycle
 *          sweep once the window has closed (lib/call-lifecycle.ts).
 */
export async function leaveInternal(
  kind: LiveRoomKind,
  id: string,
  userId: string,
): Promise<void> {
  if (!UUID.test(id) || !userId) return;
  if (kind !== "event") return;
  await Promise.all([
    notifyHosts(`event:${id}`, { t: "peer-offline", peerId: userId }),
    markLeft(id, userId),
  ]);
}

// ---------------------------------------------------------------------------
// internals
// ---------------------------------------------------------------------------

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Claimed speakers' user ids, or null when the read failed.
 *
 * Null rather than [] on an error, because here "the query failed" would
 * otherwise silently demote a guest speaker to a viewer mid-webinar. A missing
 * table (0084 not applied) is still "no speakers", which is the truth. Also
 * presentHostRoles' fallback when roles cannot be read. (This replaced the
 * `speakerUserIds` helper that the gates used to share, which swallowed
 * errors into an empty list.)
 */
async function readSpeakerIds(eventId: string): Promise<string[] | null> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("event_speakers")
    .select("user_id")
    .eq("event_id", eventId)
    .not("user_id", "is", null)
    .limit(20);
  if (error) {
    if (isMissingTable(error)) return [];
    console.error("[live-access] speaker read failed", error.message);
    return null;
  }
  return (data ?? []).map((r: any) => r.user_id).filter(Boolean);
}

function toAccessEvent(row: any): LiveAccessEvent {
  return {
    id: row.id,
    title: row.title,
    description: row.description ?? null,
    type: row.type,
    startsAt: row.starts_at,
    endsAt: row.ends_at ?? null,
    liveMode: row.live_mode,
    audienceMode: normalizeAudienceMode(row.audience_mode),
    displayViewerCount: row.display_viewer_count ?? null,
    autoRecord: !!row.auto_record,
    premiereSeconds: row.premiere_seconds ?? null,
    qaOpensAt: row.qa_opens_at ?? null,
    liveStartedAt: row.live_started_at ?? null,
    liveEndedAt: row.live_ended_at ?? null,
    visibility: row.visibility,
    cohortId: row.cohort_id ?? null,
    recordingUrl: row.recording_url ?? null,
    dailyRoomName: row.daily_room_name ?? null,
    dailyRoomUrl: row.daily_room_url ?? null,
  };
}

function one<T>(v: T | T[] | null | undefined): T | null {
  return Array.isArray(v) ? (v[0] ?? null) : (v ?? null);
}

/** A malformed id (22P02) is "no such row", not a database failure. */
function isBadId(error: { code?: string }): boolean {
  return error.code === "22P02";
}

function isMissingTable(error: { code?: string; message?: string }): boolean {
  return (
    error.code === "PGRST205" ||
    error.code === "42P01" ||
    /does not exist|schema cache/i.test(error.message ?? "")
  );
}
