import "server-only";
import { requireActor } from "@/lib/server-guards";
import { can, type Capabilities } from "@/lib/permissions";
import { capabilitiesForRole } from "@/lib/roles";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isMissingSchemaError } from "@/lib/schema-ready";
import { activeRecordingFor } from "@/lib/recording-sessions";
import {
  callRoomAccess,
  inviteEndsAt,
  isOnCall,
  isStaffOnCall,
  mayEndCall,
  mayEndWebinar,
  roomAccess,
  roomWindow,
  shouldClaimPrimary,
  shouldStampLiveStart,
  type CallCohost,
  type CallInviteStatus,
  type CallRoomAccess,
  type LiveRoomState,
  type RoomAccess,
  type RoomStatus,
} from "@/lib/live";
import {
  canBroadcast,
  normalizeAudienceMode,
  type AudienceMode,
} from "@/lib/webinars";
import { PEER_TIMEOUT_MS, type SignalRole } from "@/lib/live-signal";
import {
  markLeft,
  notifyHosts,
  notifyStage,
  presentHosts,
} from "@/lib/live-rooms";
import {
  COHOSTS_EMBED,
  cohostsFromRow,
  isCohostSchemaMissing,
  noteCohostsUnavailable,
} from "@/lib/calls";

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
  "auto_record, premiere_seconds, qa_opens_at, " +
  "live_started_at, live_ended_at, visibility, cohort_id, recording_url";

/**
 * Migration 0096's primary-host column, read alongside EVENT_COLUMNS.
 *
 * Production gets this code before the migration runs, so a read that names
 * it fails with 42703 / PGRST204 there; the read is retried without it and the
 * room runs with no primary (`primaryHostId` null). Remembered for a minute so
 * a missing column costs one extra query a minute per instance, not per read.
 */
const PRIMARY_COLUMN = "live_primary_host_id";
let primaryColumnMissingUntil = 0;
const PRIMARY_RECHECK_MS = 60_000;

export function primaryColumnMissing(): boolean {
  return Date.now() < primaryColumnMissingUntil;
}

export function notePrimaryColumnMissing(): void {
  primaryColumnMissingUntil = Date.now() + PRIMARY_RECHECK_MS;
}

export type LiveAccessEvent = {
  id: string;
  title: string;
  description: string | null;
  type: string;
  startsAt: string;
  endsAt: string | null;
  liveMode: string;
  audienceMode: AudienceMode;
  autoRecord: boolean;
  premiereSeconds: number | null;
  qaOpensAt: string | null;
  liveStartedAt: string | null;
  liveEndedAt: string | null;
  visibility: string;
  cohortId: string | null;
  recordingUrl: string | null;
  /**
   * The primary host — the stage everyone sees when nobody is presenting
   * (migration 0096). Null when unset or before the migration has run.
   */
  primaryHostId: string | null;
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
  const first = await readEvent(supabase, eventId);
  if (first.error && !isBadId(first.error)) {
    console.error("[live-access] event read failed", first.error.message);
    return { ok: false, reason: "error" };
  }
  let row: any = first.data;

  // The events.manage re-read. See the header for why this exists and why it
  // lives nowhere else.
  if (!row && isStaff && !first.error) {
    const admin = createAdminClient();
    const second = await readEvent(admin, eventId);
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
    liveStartedAt: access.event.liveStartedAt,
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
): Promise<
  { userId: string; joinedAt: string; name: string; isStaff: boolean }[] | null
> {
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
// The webinar stage: going live, the primary host, and the room's state
// ---------------------------------------------------------------------------

/**
 * A host is in the room (joining, or heartbeating): make the room reflect it.
 *
 *   - `live_started_at` is stamped if unset and the go-live window has opened
 *     (shouldStampLiveStart: from start − 60 min) — a host in the room then IS
 *     the start, which lets the audience in early and makes End available.
 *     Earlier than that a host is rehearsing: nothing is stamped, and their
 *     first heartbeat inside the window stamps it. Never for a premiere, whose
 *     stamp hands the recording over to the live Q&A. Never after End.
 *   - the primary seat is claimed when nobody holds it or its holder is no
 *     longer present (shouldClaimPrimary). Presence here ignores `left_at` and
 *     reads only the heartbeat, so a primary who reloads keeps the seat
 *     instead of handing it to whichever co-host heartbeats first.
 *
 * Both writes are compare-and-set on the value just read, so two hosts
 * arriving together converge on one answer. A change is announced with a
 * content-free `room-changed` on the stage, and every client re-reads it.
 * Updates `access.event` in place with what is now stored. Best-effort: a
 * failure leaves the room exactly as it was.
 */
export async function claimStage(access: EventAccess): Promise<void> {
  if (!access.isHost || access.event.liveEndedAt) return;
  const ev = access.event;
  const admin = createAdminClient();
  let changed = false;

  if (
    shouldStampLiveStart({
      startsAt: ev.startsAt,
      endsAt: ev.endsAt,
      liveStartedAt: ev.liveStartedAt,
      liveEndedAt: ev.liveEndedAt,
      liveMode: ev.liveMode,
    })
  ) {
    const now = new Date().toISOString();
    const { data, error } = await admin
      .from("events")
      .update({ live_started_at: now })
      .eq("id", ev.id)
      .is("live_started_at", null)
      .is("live_ended_at", null)
      .select("live_started_at")
      .maybeSingle();
    if (error) {
      console.error("[live-access] live start stamp failed", error.message);
    } else if (data) {
      ev.liveStartedAt = (data as any).live_started_at ?? now;
      changed = true;
    }
  }

  if (!primaryColumnMissing() && ev.primaryHostId !== access.userId) {
    const present = ev.primaryHostId
      ? await recentHostIds(ev.id, PEER_TIMEOUT_MS)
      : [];
    if (
      shouldClaimPrimary({
        current: ev.primaryHostId,
        selfId: access.userId,
        present,
      })
    ) {
      const q = admin
        .from("events")
        .update({ [PRIMARY_COLUMN]: access.userId })
        .eq("id", ev.id);
      const { data, error } = await (ev.primaryHostId
        ? q.eq(PRIMARY_COLUMN, ev.primaryHostId)
        : q.is(PRIMARY_COLUMN, null)
      )
        .select(PRIMARY_COLUMN)
        .maybeSingle();
      if (error) {
        if (isMissingSchemaError(error)) notePrimaryColumnMissing();
        else console.error("[live-access] primary claim failed", error.message);
      } else if (data) {
        ev.primaryHostId = access.userId;
        changed = true;
      } else {
        // Someone else's claim landed first: report theirs.
        ev.primaryHostId = await readPrimary(ev.id);
      }
    }
  }

  if (changed) await notifyStage(`event:${ev.id}`, { t: "room-changed" });
}

/** The server truth a webinar's join and heartbeat answers carry. */
export async function webinarRoomState(
  access: EventAccess,
  now: Date = new Date(),
): Promise<LiveRoomState> {
  const ev = access.event;
  const [staffPresent, recording] = await Promise.all([
    // Only a guest speaker's End depends on who else is here.
    access.isSpeaker ? staffHostPresent(ev.id, access.userId) : false,
    activeRecordingFor("webinar", ev.id).catch(() => null),
  ]);
  return {
    primaryId: ev.primaryHostId,
    liveStartedAt: ev.liveStartedAt,
    liveEndedAt: ev.liveEndedAt,
    canEnd: mayEndWebinar({
      isStaff: access.isStaff,
      isSpeaker: access.isSpeaker,
      staffPresent,
      startsAt: ev.startsAt,
      endsAt: ev.endsAt,
      liveStartedAt: ev.liveStartedAt,
      liveEndedAt: ev.liveEndedAt,
      now,
    }),
    recording,
  };
}

/**
 * Is a staff host other than `exceptId` in the room? An unreadable table
 * counts as no: a guest-only webinar must stay endable (staff can Reopen).
 */
async function staffHostPresent(eventId: string, exceptId: string): Promise<boolean> {
  const hosts = await presentHostRoles(eventId);
  return !!hosts && hosts.some((h) => h.isStaff && h.userId !== exceptId);
}

/**
 * Host ids with a heartbeat inside `sinceMs`, whether or not they have since
 * said Leave — the primary seat's notion of "still here". Null when the
 * attendance table cannot be read.
 */
async function recentHostIds(eventId: string, sinceMs: number): Promise<string[] | null> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("live_participants")
    .select("user_id")
    .eq("event_id", eventId)
    .eq("role", "host")
    .gte("last_seen_at", new Date(Date.now() - sinceMs).toISOString())
    .limit(50);
  if (error) {
    if (!isMissingSchemaError(error)) {
      console.error("[live-access] host heartbeat read failed", error.message);
    }
    return null;
  }
  return (data ?? []).map((r: any) => r.user_id as string);
}

async function readPrimary(eventId: string): Promise<string | null> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("events")
    .select(PRIMARY_COLUMN)
    .eq("id", eventId)
    .maybeSingle();
  if (error) {
    if (isMissingSchemaError(error)) notePrimaryColumnMissing();
    return null;
  }
  return ((data as any)?.[PRIMARY_COLUMN] as string | null) ?? null;
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
  /** Everyone else on the staff side (migration 0092), in the order added. */
  cohosts: CallCohost[];
  /**
   * The inviter — the call's owner. Invitees are always students, so an
   * admin who sent the invite is always its owner. (Anyone on the call may
   * End call — see endCall in app/calls/actions.ts — and any of the staff
   * side may record; the owner is no longer special to either.)
   */
  isOwner: boolean;
  /** On the staff side: the owner or a co-host. Never the student. */
  isStaff: boolean;
  /**
   * Everyone on the call but the caller — the student and the whole staff
   * side. What joinRoom hands the engine as known peers, so a call with
   * co-hosts is a small mesh that connects the moment people arrive.
   */
  others: { id: string; name: string }[];
  hostName: string;
  hostRole: string;
  inviteeName: string;
  status: CallInviteStatus;
  startsAt: string;
  durationMinutes: number;
  endsAt: string;
  topic: string | null;
  /** callRoomAccess (lib/live.ts) for the caller at resolve time. */
  roomAccess: CallRoomAccess;
};

const CALL_COLUMNS =
  "id, host_id, invitee_id, starts_at, duration_minutes, topic, status, " +
  "host:profiles!call_invites_host_id_fkey(full_name, role), " +
  "invitee:profiles!call_invites_invitee_id_fkey(full_name)";

/**
 * Resolve the caller's standing in one 1:1.
 *
 * "Are you on this call?" and nothing else — the safeguarding rule. On it
 * means the student, the host, or a co-host (migration 0092). An admin who is
 * not on it gets `no-access` (the same answer as "no such call"), and the
 * read-only observer card on /admin/calls is the whole of their view: they
 * can see that a call happened, and a superAdmin can Cancel it, but nobody can
 * walk into a call they were not put on. Admins "always host" webinars; a
 * private call is not a webinar.
 *
 * Returns the caller's room access instead of refusing on it, because the
 * answers after the party check differ by caller: leaving needs only
 * identity, and the join and the heartbeat need `callRefusal` /
 * `callRoomStatus`. Nothing about a call's status is revealed to a non-party.
 *
 * Reads the co-hosts in the same query, falling back to a read without them
 * on a database where 0092 hasn't run (see lib/calls.ts) — so a deploy that
 * lands before the migration leaves every existing call joinable.
 */
export async function resolveCallAccess(
  inviteId: string,
  now: Date = new Date(),
): Promise<CallAccess | AccessDenied> {
  const actor = await requireActor();
  const admin = createAdminClient();
  const read = (columns: string) =>
    admin.from("call_invites").select(columns).eq("id", inviteId).maybeSingle();
  let { data, error } = await read(`${CALL_COLUMNS}, ${COHOSTS_EMBED}`);
  if (error && isCohostSchemaMissing(error)) {
    noteCohostsUnavailable(error);
    ({ data, error } = await read(CALL_COLUMNS));
  }
  if (error && !isBadId(error)) {
    console.error("[live-access] invite read failed", error.message);
    return { ok: false, reason: "error" };
  }
  const row = data as any;
  if (!row) return { ok: false, reason: "no-access" };

  const host = one<any>(row.host);
  const invitee = one<any>(row.invitee);
  const hostName = host?.full_name || "A member of the team";
  const inviteeName = invitee?.full_name || "Student";
  // The same reading the calls lists give it (lib/calls.ts).
  const cohosts = cohostsFromRow(row);

  const parties = { hostId: row.host_id, inviteeId: row.invitee_id, cohosts };
  if (!isOnCall(parties, actor.userId)) return { ok: false, reason: "no-access" };

  const everyone = [
    { id: row.invitee_id as string, name: inviteeName },
    { id: row.host_id as string, name: hostName },
    ...cohosts.map((c) => ({ id: c.id, name: c.name })),
  ];
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
    cohosts,
    isOwner: row.host_id === actor.userId,
    isStaff: isStaffOnCall(parties, actor.userId),
    others: everyone.filter((p) => p.id !== actor.userId),
    hostName,
    hostRole: host?.role || "mentor",
    inviteeName,
    status: invite.status,
    startsAt: invite.startsAt,
    durationMinutes: invite.durationMinutes,
    endsAt: inviteEndsAt(invite),
    topic: row.topic ?? null,
    roomAccess: callRoomAccess({
      ...invite,
      isStaff: isStaffOnCall(parties, actor.userId),
      now,
    }),
  };
}

/**
 * Why a party may not be in their call right now, or null when they may.
 *
 *   open / live           null — come in.
 *   early                 'early'
 *   closed                'closed' (past the hard stop)
 *   completed             'completed' (End call was pressed)
 *   cancelled / declined  as named
 */
export type CallRefusal =
  | "early"
  | "closed"
  | "completed"
  | "cancelled"
  | "declined";

export function callRefusal(access: CallRoomAccess): CallRefusal | null {
  if (access === "open" || access === "live") return null;
  return access;
}

/** The heartbeat's answer for a call the caller stands here with. */
export function callRoomStatus(access: CallRoomAccess): RoomStatus {
  if (access === "open" || access === "live") return "ok";
  if (access === "completed") return "ended";
  if (access === "cancelled") return "cancelled";
  if (access === "declined") return "revoked";
  return "closed";
}

/** The server truth a call's join and heartbeat answers carry. */
export async function callRoomState(
  access: CallAccess,
  now: Date = new Date(),
): Promise<LiveRoomState> {
  return {
    primaryId: null,
    liveStartedAt: null,
    liveEndedAt: null,
    canEnd: mayEndCall({ status: access.status, startsAt: access.startsAt, now }),
    recording: await activeRecordingFor("call", access.inviteId).catch(() => null),
  };
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
 *          departing person's `bye` is what tells everyone else on it. The
 *          call is NOT completed by leaving — End call does that, or the
 *          lifecycle sweep once the window has closed (lib/call-lifecycle.ts).
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
 * The event row, with the primary-host column when the database has it. See
 * PRIMARY_COLUMN for the fallback.
 */
async function readEvent(
  client: { from: ReturnType<typeof createAdminClient>["from"] },
  eventId: string,
): Promise<{ data: any; error: { code?: string; message: string } | null }> {
  const read = (columns: string) =>
    client.from("events").select(columns).eq("id", eventId).maybeSingle();
  if (!primaryColumnMissing()) {
    const withPrimary = await read(`${EVENT_COLUMNS}, ${PRIMARY_COLUMN}`);
    if (!withPrimary.error || !isMissingSchemaError(withPrimary.error)) {
      return withPrimary;
    }
    notePrimaryColumnMissing();
  }
  return read(EVENT_COLUMNS);
}

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
    if (isMissingSchemaError(error)) return [];
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
    autoRecord: !!row.auto_record,
    premiereSeconds: row.premiere_seconds ?? null,
    qaOpensAt: row.qa_opens_at ?? null,
    liveStartedAt: row.live_started_at ?? null,
    liveEndedAt: row.live_ended_at ?? null,
    visibility: row.visibility,
    cohortId: row.cohort_id ?? null,
    recordingUrl: row.recording_url ?? null,
    primaryHostId: row.live_primary_host_id ?? null,
  };
}

function one<T>(v: T | T[] | null | undefined): T | null {
  return Array.isArray(v) ? (v[0] ?? null) : (v ?? null);
}

/** A malformed id (22P02) is "no such row", not a database failure. */
function isBadId(error: { code?: string }): boolean {
  return error.code === "22P02";
}
