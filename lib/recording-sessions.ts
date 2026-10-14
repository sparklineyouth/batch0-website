import "server-only";
import { randomUUID } from "node:crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { getViewer } from "@/lib/auth";
import { requireActor } from "@/lib/server-guards";
import { can } from "@/lib/permissions";
import { logAudit } from "@/lib/audit";
import { isMissingSchemaError } from "@/lib/schema-ready";
import { getInvite } from "@/lib/calls";
import { canViewCallRecording } from "@/lib/call-lifecycle";
import { resolveEventAccess } from "@/lib/live-access";
import { notifyStage } from "@/lib/live-rooms";
import {
  CALL_STAFF_OPENS_MINUTES_BEFORE,
  inviteEndsAt,
  isOnCall,
  isStaffOnCall,
  roomWindow,
} from "@/lib/live";
import { isHostedOnBatch0 } from "@/lib/webinars";
import {
  canMintPart,
  containerFor,
  contiguousParts,
  HEAD_NAME,
  isStale,
  locateRaw,
  partName,
  RECORDING_BUCKET,
  rawLength,
  servedLength,
  STALE_AFTER_MS,
  storagePrefix,
  type Container,
} from "@/lib/recording-parts";
import {
  buildWebmHead,
  isClusterStart,
  parseWebmHead,
  usableCues,
  type Cue,
} from "@/lib/recording-webm";

/**
 * Recording takes: the server side.
 *
 * One row in `recording_sessions` per take (migration 0095). The row with
 * status 'recording' is the room's LEASE: one recorder at a time, enforced by
 * a partial unique index, kept alive by every part the recorder mints, and
 * swept to 'interrupted' once its heartbeat is STALE_AFTER_MS old. Finalizing
 * a take reads what actually reached storage, writes the stitched file's
 * manifest (part sizes, head) onto the row, and — for WebM — uploads a
 * rewritten head with a Duration and Cues (lib/recording-webm.ts).
 *
 * Every function tolerates a database without 0095: reads come back empty or
 * null, writes report "unavailable". Authorization lives in the two `…Access`
 * helpers; everything else trusts its caller to have asked them.
 */

export type RecordingKind = "webinar" | "call";

export type ActiveRecording = {
  sessionId: string;
  byUserId: string;
  byName: string;
  startedAt: string;
};

/** A playable take, as lists and the player show it. */
export type RecordingSummary = {
  id: string;
  status: "finished" | "interrupted";
  startedAt: string;
  endedAt: string | null;
  durationMs: number;
  byName: string | null;
  container: Container;
  bytes: number;
  title: string | null;
};

export type RecordingRow = {
  id: string;
  room_kind: RecordingKind;
  room_id: string;
  status: "recording" | "finished" | "interrupted" | "failed";
  started_by: string | null;
  started_at: string;
  heartbeat_at: string;
  ended_at: string | null;
  finalized_at: string | null;
  mime: string;
  part_count: number;
  part_sizes: number[];
  part_end_ms: number[];
  total_bytes: number;
  head_bytes: number | null;
  head_replaces: number | null;
  duration_ms: number;
  /** Only read where it is used (finalize): a long take's runs to 20,000 pairs. */
  cues: Cue[];
  storage_prefix: string;
  title: string | null;
  end_reason: EndReason | null;
  finalize_attempts: number;
};

/** Why a take ended (see migration 0095). */
export type EndReason = "stop" | "leave" | "unload" | "stale" | "replaced";

const COLUMNS =
  "id, room_kind, room_id, status, started_by, started_at, heartbeat_at, ended_at, " +
  "finalized_at, mime, part_count, part_sizes, part_end_ms, total_bytes, head_bytes, " +
  "head_replaces, duration_ms, storage_prefix, title, end_reason, finalize_attempts";
const COLUMNS_WITH_CUES = `${COLUMNS}, cues`;

/** Finalize runs after which the head is left as recorded (no Duration/Cues rewrite)… */
const FINALIZE_PLAIN_AFTER = 3;
/** …and after which the sweep stops retrying a take. */
export const FINALIZE_GIVE_UP_AFTER = 12;

const BY_NAME = "by:profiles!recording_sessions_started_by_fkey(full_name)";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (s: unknown): s is string => typeof s === "string" && UUID.test(s);
export const isRecordingKind = (s: unknown): s is RecordingKind => s === "webinar" || s === "call";

function one<T>(v: T | T[] | null | undefined): T | null {
  return Array.isArray(v) ? (v[0] ?? null) : (v ?? null);
}

function toRow(data: any): RecordingRow {
  return {
    ...data,
    part_sizes: Array.isArray(data.part_sizes) ? data.part_sizes.map(Number) : [],
    part_end_ms: Array.isArray(data.part_end_ms) ? data.part_end_ms.map(Number) : [],
    cues: Array.isArray(data.cues) ? data.cues : [],
    total_bytes: Number(data.total_bytes ?? 0),
    duration_ms: Number(data.duration_ms ?? 0),
    end_reason: data.end_reason ?? null,
    finalize_attempts: Number(data.finalize_attempts ?? 0),
  };
}

function logError(where: string, error: { message?: string } | null | undefined) {
  if (error && !isMissingSchemaError(error)) {
    console.error(`[recordings] ${where}`, error.message);
  }
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * Who is recording this room right now, or null — also null when the table
 * is missing (0095 not applied) or the recorder's lease has gone stale.
 */
export async function activeRecordingFor(
  kind: "webinar" | "call",
  roomId: string,
): Promise<{ sessionId: string; byUserId: string; byName: string; startedAt: string } | null> {
  if (!isUuid(roomId)) return null;
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("recording_sessions")
    .select(`id, started_by, started_at, heartbeat_at, ${BY_NAME}`)
    .eq("room_kind", kind)
    .eq("room_id", roomId)
    .eq("status", "recording")
    .maybeSingle();
  if (error || !data) {
    logError("active read failed", error);
    return null;
  }
  const row = data as any;
  if (isStale(row.heartbeat_at)) return null;
  return {
    sessionId: row.id,
    byUserId: row.started_by ?? "",
    byName: one<any>(row.by)?.full_name || "A host",
    startedAt: row.started_at,
  };
}

/**
 * A room's playable takes, oldest first. One read; only when it shows a lease
 * gone stale or a closed take not yet finalized is the room swept first, so a
 * take whose recorder vanished shows up (as interrupted) without waiting for
 * the cron.
 */
export async function listRecordings(
  kind: "webinar" | "call",
  roomId: string,
): Promise<RecordingSummary[]> {
  if (!isUuid(roomId)) return [];
  const admin = createAdminClient();
  const read = () =>
    admin
      .from("recording_sessions")
      .select(
        `id, status, started_at, ended_at, heartbeat_at, duration_ms, mime, total_bytes, title, part_count, finalized_at, finalize_attempts, ${BY_NAME}`,
      )
      .eq("room_kind", kind)
      .eq("room_id", roomId)
      .order("started_at", { ascending: true })
      .limit(100);
  let { data, error } = await read();
  if (!error && ((data ?? []) as any[]).some(needsSweep)) {
    await sweepStaleRecordings({ kind, roomId });
    ({ data, error } = await read());
  }
  if (error) {
    logError("list failed", error);
    return [];
  }
  return ((data ?? []) as any[])
    .filter(
      (r) => (r.status === "finished" || r.status === "interrupted") && r.finalized_at && r.part_count > 0,
    )
    .map((r) => ({
      id: r.id,
      status: r.status,
      startedAt: r.started_at,
      endedAt: r.ended_at,
      durationMs: Number(r.duration_ms ?? 0),
      byName: one<any>(r.by)?.full_name ?? null,
      container: containerFor(r.mime) ?? "webm",
      bytes: Number(r.total_bytes ?? 0),
      title: r.title,
    }));
}

/** A lease gone stale, or a closed take still to finalize (that the sweep hasn't given up on). */
function needsSweep(r: {
  status: string;
  heartbeat_at: string;
  finalized_at: string | null;
  finalize_attempts?: number | null;
}): boolean {
  if (r.status === "recording") return isStale(r.heartbeat_at);
  return (
    (r.status === "finished" || r.status === "interrupted") &&
    !r.finalized_at &&
    Number(r.finalize_attempts ?? 0) < FINALIZE_GIVE_UP_AFTER
  );
}

/** Does this room have takes still recording, or a playable one? For the follow-up cron. */
export async function recordingStateFor(
  kind: RecordingKind,
  roomId: string,
): Promise<{ recording: boolean; playable: boolean } | null> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("recording_sessions")
    .select("status, part_count, finalized_at, finalize_attempts")
    .eq("room_kind", kind)
    .eq("room_id", roomId);
  if (error) {
    logError("state read failed", error);
    return null;
  }
  const rows = (data ?? []) as any[];
  return {
    // Still being saved: recording, or closed and not finalized yet (unless
    // finalizing has been given up on — nothing more is coming).
    recording: rows.some(
      (r) =>
        r.status === "recording" ||
        (r.status !== "failed" && !r.finalized_at && Number(r.finalize_attempts ?? 0) < FINALIZE_GIVE_UP_AFTER),
    ),
    playable: rows.some(
      (r) => (r.status === "finished" || r.status === "interrupted") && r.finalized_at && r.part_count > 0,
    ),
  };
}

/** One take's row. Its cue list only when asked for (finalizing). */
export async function getRecording(
  id: string,
  opts: { cues?: boolean } = {},
): Promise<RecordingRow | null> {
  if (!isUuid(id)) return null;
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("recording_sessions")
    .select(opts.cues ? COLUMNS_WITH_CUES : COLUMNS)
    .eq("id", id)
    .maybeSingle();
  if (error || !data) {
    logError("read failed", error);
    return null;
  }
  return toRow(data);
}

/** The stitched file's layout, from a finalized row. */
export function layoutOf(row: RecordingRow) {
  return {
    headBytes: row.head_bytes,
    headReplaces: row.head_replaces ?? 0,
    partSizes: row.part_sizes,
  };
}

// ---------------------------------------------------------------------------
// Who may do what
// ---------------------------------------------------------------------------

export type ViewAccess = {
  viewerId: string;
  canView: boolean;
  canDelete: boolean;
  /** On the call (or a staff host of the webinar): views are not audited. */
  party: boolean;
  /** A call's scheduled start (null for a webinar). */
  startsAt: string | null;
};

/**
 * May the signed-in person watch this room's recordings? Checked on every
 * request that serves recording bytes or names.
 *
 *   webinar  staff (events.manage) always; anyone else who can see the event
 *            once the follow-up has shared it (assets_shared_at).
 *   call     the people on it, and admins (canViewCallRecording).
 *
 * Deletion: events.manage for webinars, admins for calls. Null: signed out,
 * or no such room.
 */
export async function viewAccess(kind: RecordingKind, roomId: string): Promise<ViewAccess | null> {
  if (!isUuid(roomId)) return null;
  const viewer = await getViewer();
  if (!viewer) return null;
  const viewerId = viewer.profile.id;
  if (kind === "webinar") {
    if (can(viewer.caps, "events.manage")) {
      return { viewerId, canView: true, canDelete: true, party: true, startsAt: null };
    }
    // The caller's own RLS decides whether the event is theirs to see.
    const supabase = await createClient();
    const { data } = await supabase
      .from("events")
      .select("id, assets_shared_at")
      .eq("id", roomId)
      .maybeSingle();
    if (!data) return null;
    return {
      viewerId,
      canView: !!(data as any).assets_shared_at,
      canDelete: false,
      party: false,
      startsAt: null,
    };
  }
  const invite = await getInvite(roomId);
  if (!invite) return null;
  return {
    viewerId,
    canView: canViewCallRecording({
      viewerId,
      hostId: invite.hostId,
      inviteeId: invite.inviteeId,
      cohostIds: invite.cohosts.map((c) => c.id),
      superAdmin: viewer.caps.superAdmin,
    }),
    canDelete: viewer.caps.superAdmin,
    party: isOnCall(invite, viewerId),
    startsAt: invite.startsAt,
  };
}

/**
 * May the signed-in person START recording this room now? Webinar: a host
 * (staff or claimed speaker) of a batch0-hosted event that has not been
 * ended, before its hard close. Call: its staff side (never the student), on
 * a call still on, from the host window to the hard close. Throws when signed
 * out.
 */
export async function recordAccess(
  kind: RecordingKind,
  roomId: string,
  now: Date = new Date(),
): Promise<
  | { ok: true; userId: string; title: string; startsAt: string }
  | { ok: false; status: number; message: string }
> {
  const t = now.getTime();
  if (kind === "webinar") {
    const access = await resolveEventAccess(roomId);
    if (!access.ok) {
      return access.reason === "error"
        ? { ok: false, status: 503, message: "Couldn't check this room. Try again." }
        : { ok: false, status: 404, message: "Not found" };
    }
    const ev = access.event;
    if (!access.isHost) return { ok: false, status: 403, message: "Only hosts can record." };
    if (!isHostedOnBatch0(ev.liveMode)) return { ok: false, status: 409, message: "This event isn't hosted on batch0." };
    if (ev.liveEndedAt) return { ok: false, status: 409, message: "This webinar has ended." };
    if (t > roomWindow(ev.startsAt, ev.endsAt).hardCloseAt) {
      return { ok: false, status: 409, message: "This webinar is over." };
    }
    return { ok: true, userId: access.userId, title: ev.title, startsAt: ev.startsAt };
  }
  const { userId } = await requireActor();
  const invite = await getInvite(roomId);
  if (!invite || !isOnCall(invite, userId)) return { ok: false, status: 404, message: "Not found" };
  if (!isStaffOnCall(invite, userId)) {
    return { ok: false, status: 403, message: "Only the team on the call can record." };
  }
  if (invite.status !== "invited" && invite.status !== "accepted") {
    return { ok: false, status: 409, message: "This call is over." };
  }
  const w = roomWindow(invite.startsAt, inviteEndsAt(invite));
  if (t < w.start - CALL_STAFF_OPENS_MINUTES_BEFORE * 60_000 || t > w.hardCloseAt) {
    return { ok: false, status: 409, message: "This call isn't open." };
  }
  return {
    ok: true,
    userId,
    title: invite.topic || `1:1 with ${invite.inviteeName}`,
    startsAt: invite.startsAt,
  };
}

// ---------------------------------------------------------------------------
// The lease
// ---------------------------------------------------------------------------

export type StartResult =
  | { ok: true; sessionId: string }
  | { ok: false; reason: "busy"; by: ActiveRecording }
  /** An automatic start, refused: the room's last take was stopped on purpose. */
  | { ok: false; reason: "stopped" }
  | { ok: false; reason: "unavailable" | "error" };

/**
 * Take the room's lease and open a take. Busy when someone holds it — the
 * same person included (another tab or device of theirs is recording), unless
 * `replaces` names that very take: the same tab reloaded, and is not coming
 * back to it, so it is closed as interrupted and replaced.
 *
 * `auto` (a room starting its own recording, not someone pressing Record) is
 * refused when the room's latest take ended because someone pressed Stop:
 * auto-recording resumes after a recorder leaves, not after a decision. A
 * Stop before the scheduled start (`startsAt`: a host trying Record out while
 * setting up) holds only until the start.
 */
export async function startRecording(args: {
  kind: RecordingKind;
  roomId: string;
  userId: string;
  mime: string;
  title: string;
  auto?: boolean;
  replaces?: string | null;
  startsAt?: string;
}): Promise<StartResult> {
  await sweepStaleRecordings({ kind: args.kind, roomId: args.roomId });
  const admin = createAdminClient();
  if (args.auto) {
    const { data, error } = await admin
      .from("recording_sessions")
      .select("end_reason, ended_at")
      .eq("room_kind", args.kind)
      .eq("room_id", args.roomId)
      .neq("status", "recording")
      .order("started_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    // An error here (no table yet) is the insert's to report.
    const last = error ? null : (data as { end_reason: string | null; ended_at: string | null } | null);
    if (last?.end_reason === "stop") {
      const start = args.startsAt ? Date.parse(args.startsAt) : NaN;
      const stoppedAt = last.ended_at ? Date.parse(last.ended_at) : NaN;
      const rehearsal = Number.isFinite(start) && Date.now() >= start && stoppedAt < start;
      if (!rehearsal) return { ok: false, reason: "stopped" };
    }
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    const id = randomUUID();
    const { error } = await admin.from("recording_sessions").insert({
      id,
      room_kind: args.kind,
      room_id: args.roomId,
      status: "recording",
      started_by: args.userId,
      mime: args.mime,
      storage_prefix: storagePrefix(args.kind, args.roomId, id),
      title: args.title.slice(0, 200),
    });
    if (!error) {
      await announceRecordingChange(args.kind, args.roomId);
      return { ok: true, sessionId: id };
    }
    if (isMissingSchemaError(error)) return { ok: false, reason: "unavailable" };
    if ((error as { code?: string }).code !== "23505") {
      logError("start failed", error);
      return { ok: false, reason: "error" };
    }
    const { data } = await admin
      .from("recording_sessions")
      .select(`id, started_by, started_at, ${BY_NAME}`)
      .eq("room_kind", args.kind)
      .eq("room_id", args.roomId)
      .eq("status", "recording")
      .maybeSingle();
    const held = data as any;
    if (!held) continue; // released meanwhile
    const reload = held.started_by === args.userId && !!args.replaces && held.id === args.replaces;
    if (!reload || attempt > 0) {
      return {
        ok: false,
        reason: "busy",
        by: {
          sessionId: held.id,
          byUserId: held.started_by ?? "",
          byName: one<any>(held.by)?.full_name || "A host",
          startedAt: held.started_at,
        },
      };
    }
    await admin
      .from("recording_sessions")
      .update({ status: "interrupted", ended_at: new Date().toISOString(), end_reason: "replaced" })
      .eq("id", held.id)
      .eq("status", "recording");
  }
  return { ok: false, reason: "error" };
}

export type PartReport = { index: number; size: number; endMs: number; cues: Cue[] };

/**
 * Mint the signed upload URL for part `index` of the caller's own take, and
 * renew the lease (migration 0095's recording_mint_part, which also appends
 * the part's cues in place). Refused once the take is no longer recording or
 * not theirs — the recorder stops.
 */
export async function mintPart(
  row: RecordingRow,
  userId: string,
  part: PartReport,
): Promise<{ ok: true; path: string; token: string } | { ok: false; status: number; message: string }> {
  if (row.status !== "recording" || row.started_by !== userId) {
    return { ok: false, status: 409, message: "This recording has stopped." };
  }
  if (!canMintPart(part.index, row.part_count)) {
    return { ok: false, status: 400, message: "Parts must be uploaded in order." };
  }
  const container = containerFor(row.mime);
  if (!container) return { ok: false, status: 400, message: "Unsupported recording type." };

  const admin = createAdminClient();
  const { data, error } = await admin.rpc("recording_mint_part", {
    p_id: row.id,
    p_user: userId,
    p_index: part.index,
    p_size: part.size,
    p_end_ms: Math.round(part.endMs),
    p_cues: cleanCues(part.cues),
  });
  if (error) {
    logError("part update failed", error);
    return { ok: false, status: 503, message: "Couldn't save progress. Retrying." };
  }
  if (data === "order") return { ok: false, status: 400, message: "Parts must be uploaded in order." };
  if (data !== "ok") return { ok: false, status: 409, message: "This recording has stopped." };

  const path = `${row.storage_prefix}/${partName(part.index, container)}`;
  // Without upsert: once a part is stored, nothing can replace it — not a
  // second upload during the take, and not this token after the take is
  // finalized (it lives two hours). A same-part retry whose first upload did
  // land is told "Duplicate", which the recorder counts as done.
  const signed = await admin.storage.from(RECORDING_BUCKET).createSignedUploadUrl(path);
  if (signed.error || !signed.data) {
    console.error("[recordings] sign upload failed", signed.error?.message);
    return { ok: false, status: 503, message: "Couldn't prepare the upload. Retrying." };
  }
  return { ok: true, path, token: signed.data.token };
}

/**
 * Tell everyone in the room that its recording changed — a take started, or
 * its lease closed or went stale — so each client re-asks the server at once
 * (`room-changed`) and the REC badge follows within a second, not on the next
 * 12 s heartbeat. Content-free; never throws (broadcast logs its own failure).
 */
async function announceRecordingChange(kind: RecordingKind, roomId: string): Promise<void> {
  await notifyStage(`${kind === "webinar" ? "event" : "call"}:${roomId}`, { t: "room-changed" });
}

/** Renew the lease without a part — the uploader is behind, not gone. */
export async function heartbeat(row: RecordingRow, userId: string): Promise<boolean> {
  if (row.status !== "recording" || row.started_by !== userId) return false;
  const admin = createAdminClient();
  const { data } = await admin
    .from("recording_sessions")
    .update({ heartbeat_at: new Date().toISOString() })
    .eq("id", row.id)
    .eq("status", "recording")
    .eq("started_by", userId)
    .select("id")
    .maybeSingle();
  return !!data;
}

/** A part's reported cues, as stored: well-formed [offset, ms] pairs only, at most 100. */
function cleanCues(added: unknown): Cue[] {
  if (!Array.isArray(added)) return [];
  const out: Cue[] = [];
  for (const c of added.slice(0, 100)) {
    if (!Array.isArray(c) || c.length !== 2) continue;
    const [o, t] = c;
    if (Number.isSafeInteger(o) && o >= 0 && Number.isFinite(t) && t >= 0) out.push([o, Math.round(t)]);
  }
  return out;
}

/**
 * The recorder is done with its take — `reason` says why: 'stop' (Stop was
 * pressed), 'leave' (it left the room, or the room ended) or 'unload' (its tab
 * closed). Close the take, releasing the lease, and finalize it.
 */
export async function finishRecording(
  row: RecordingRow,
  userId: string,
  reason: "stop" | "leave" | "unload",
): Promise<RecordingRow | null> {
  if (row.started_by !== userId) return null;
  if (row.status === "recording") {
    const admin = createAdminClient();
    const { data: closed } = await admin
      .from("recording_sessions")
      .update({
        status: reason === "unload" ? "interrupted" : "finished",
        ended_at: new Date().toISOString(),
        end_reason: reason,
      })
      .eq("id", row.id)
      .eq("status", "recording")
      .select("id");
    // Before the finalize below (seconds): the badge goes when the take does.
    if (closed?.length) await announceRecordingChange(row.room_kind, row.room_id);
  }
  const fresh = await getRecording(row.id, { cues: true });
  if (!fresh) return null;
  return fresh.finalized_at ? fresh : await finalizeRecording(fresh);
}

/**
 * Close leases whose recorder has gone quiet (as interrupted), and finalize
 * every closed take that has not been — the least recently tried first, so a
 * take that keeps failing never holds up the others, and not past
 * FINALIZE_GIVE_UP_AFTER tries. Scoped to one room, or global (the cron).
 * Cheap when there is nothing to do: one update, one select.
 */
export async function sweepStaleRecordings(scope?: {
  kind: RecordingKind;
  roomId: string;
}): Promise<{ interrupted: number; finalized: number }> {
  const admin = createAdminClient();
  const cutoff = new Date(Date.now() - STALE_AFTER_MS).toISOString();
  let stale = admin
    .from("recording_sessions")
    .update({ status: "interrupted", ended_at: new Date().toISOString(), end_reason: "stale" })
    .eq("status", "recording")
    .lt("heartbeat_at", cutoff);
  if (scope) stale = stale.eq("room_kind", scope.kind).eq("room_id", scope.roomId);
  const swept = await stale.select("id, room_kind, room_id");
  if (swept.error) {
    logError("sweep failed", swept.error);
    return { interrupted: 0, finalized: 0 };
  }
  const sweptRooms = new Map<string, { kind: RecordingKind; roomId: string }>();
  for (const r of (swept.data ?? []) as { room_kind: RecordingKind; room_id: string }[]) {
    sweptRooms.set(`${r.room_kind}:${r.room_id}`, { kind: r.room_kind, roomId: r.room_id });
  }
  await Promise.all([...sweptRooms.values()].map((r) => announceRecordingChange(r.kind, r.roomId)));
  let pending = admin
    .from("recording_sessions")
    .select(COLUMNS_WITH_CUES)
    .in("status", ["finished", "interrupted"])
    .is("finalized_at", null)
    .lt("finalize_attempts", FINALIZE_GIVE_UP_AFTER)
    .order("updated_at", { ascending: true })
    .limit(scope ? 5 : 20);
  if (scope) pending = pending.eq("room_kind", scope.kind).eq("room_id", scope.roomId);
  const { data, error } = await pending;
  if (error) {
    logError("pending read failed", error);
    return { interrupted: swept.data?.length ?? 0, finalized: 0 };
  }
  let finalized = 0;
  for (const r of (data ?? []) as any[]) {
    if (await finalizeRecording(toRow(r))) finalized += 1;
  }
  return { interrupted: swept.data?.length ?? 0, finalized };
}

// ---------------------------------------------------------------------------
// Finalize
// ---------------------------------------------------------------------------

/** Every object under a take's prefix (Storage lists at most 1000 per page). */
async function listObjects(prefix: string): Promise<{ name: string; size: number | null }[]> {
  const admin = createAdminClient();
  const out: { name: string; size: number | null }[] = [];
  for (let offset = 0; offset < 20_000; offset += 1000) {
    const { data, error } = await admin.storage
      .from(RECORDING_BUCKET)
      .list(prefix, { limit: 1000, offset, sortBy: { column: "name", order: "asc" } });
    if (error) throw new Error(`list ${prefix}: ${error.message}`);
    for (const o of data ?? []) {
      out.push({ name: o.name, size: typeof o.metadata?.size === "number" ? o.metadata.size : null });
    }
    if ((data ?? []).length < 1000) break;
  }
  return out;
}

/** Bytes [from, to] of one stored object (service role, Range request). */
export async function fetchObjectRange(path: string, from: number, to: number): Promise<Response> {
  const url = `${process.env.NEXT_PUBLIC_SUPABASE_URL}/storage/v1/object/authenticated/${RECORDING_BUCKET}/${path
    .split("/")
    .map(encodeURIComponent)
    .join("/")}`;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  return fetch(url, {
    headers: { Authorization: `Bearer ${key}`, apikey: key, Range: `bytes=${from}-${to}` },
    cache: "no-store",
  });
}

async function readRange(path: string, from: number, to: number): Promise<Uint8Array> {
  const res = await fetchObjectRange(path, from, to);
  if (!res.ok) throw new Error(`read ${path}: ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  // A server that ignored Range sent the whole object.
  return res.status === 206 ? bytes : bytes.subarray(from, to + 1);
}

/**
 * Settle a closed take against storage: the gap-free parts from 0 are the
 * recording; their sizes, the served length and (WebM) a rewritten head with
 * Duration and spot-checked Cues go onto the row. A take with no parts is
 * marked failed. Idempotent; returns the updated row, or null on failure —
 * counted, so the sweep retries the others first, serves the parts as
 * recorded (no head rewrite) after FINALIZE_PLAIN_AFTER failures, and stops
 * after FINALIZE_GIVE_UP_AFTER.
 *
 * `row` must carry its cues (getRecording(id, { cues: true })).
 */
export async function finalizeRecording(row: RecordingRow): Promise<RecordingRow | null> {
  if (row.status === "recording") return null;
  const container = containerFor(row.mime);
  const admin = createAdminClient();
  try {
    const objects = container ? await listObjects(row.storage_prefix) : [];
    const sizes = container ? contiguousParts(objects, container) : [];
    const now = new Date().toISOString();
    if (sizes.length === 0) {
      const { error } = await admin
        .from("recording_sessions")
        .update({ status: "failed", part_count: 0, part_sizes: [], total_bytes: 0, finalized_at: now })
        .eq("id", row.id);
      if (error) throw new Error(error.message);
      return { ...row, status: "failed", part_count: 0, part_sizes: [], total_bytes: 0, finalized_at: now };
    }
    const raw = rawLength(sizes);
    // The end of the last part that landed, as the recorder reported it.
    const durationMs = Math.round(row.part_end_ms[sizes.length - 1] || row.duration_ms);
    let headBytes: number | null = null;
    let headReplaces: number | null = null;
    if (container === "webm" && row.finalize_attempts < FINALIZE_PLAIN_AFTER) {
      const head = await buildHead(row, sizes, raw, durationMs);
      if (head) {
        const up = await admin.storage
          .from(RECORDING_BUCKET)
          .upload(`${row.storage_prefix}/${HEAD_NAME}`, head.bytes, {
            contentType: "video/webm",
            upsert: true,
          });
        if (up.error) throw new Error(`head upload: ${up.error.message}`);
        headBytes = head.bytes.length;
        headReplaces = head.replaces;
      }
    }
    const patch = {
      part_count: sizes.length,
      part_sizes: sizes,
      head_bytes: headBytes,
      head_replaces: headReplaces,
      duration_ms: durationMs,
      total_bytes: servedLength({ headBytes, headReplaces: headReplaces ?? 0, partSizes: sizes }),
      finalized_at: now,
    };
    const { error } = await admin.from("recording_sessions").update(patch).eq("id", row.id);
    if (error) throw new Error(error.message);
    return { ...row, ...patch };
  } catch (err) {
    const attempts = row.finalize_attempts + 1;
    console.error("[recordings] finalize failed", row.id, `attempt ${attempts}`, err);
    // Also moves updated_at, which puts this take at the back of the sweep's queue.
    await admin
      .from("recording_sessions")
      .update({ finalize_attempts: attempts })
      .eq("id", row.id)
      .is("finalized_at", null);
    return null;
  }
}

/**
 * The rewritten WebM head, or null to serve the parts as recorded (a head
 * that doesn't parse). Cues are kept only if a sample of them really lands on
 * Cluster starts in storage — a recorder's report is a hint, not a fact.
 */
async function buildHead(
  row: RecordingRow,
  sizes: number[],
  raw: number,
  durationMs: number,
): Promise<{ bytes: Uint8Array; replaces: number } | null> {
  const firstPart = `${row.storage_prefix}/${partName(0, "webm")}`;
  const prefix = await readRange(firstPart, 0, Math.min(sizes[0], 65_536) - 1);
  const head = parseWebmHead(prefix);
  if (!head) return null;
  let cues = usableCues(row.cues, head.firstCluster, raw);
  if (cues.length > 0) {
    const picks = new Set<number>([0, cues.length - 1]);
    for (let i = 1; i <= 4; i++) picks.add(Math.floor((cues.length * i) / 5));
    for (const i of picks) {
      const at = locateRaw(sizes, cues[i][0]);
      const ok =
        !!at &&
        at.offset + 4 <= sizes[at.index] &&
        isClusterStart(
          await readRange(`${row.storage_prefix}/${partName(at.index, "webm")}`, at.offset, at.offset + 3),
        );
      if (!ok) {
        console.warn("[recordings] cues don't match storage; Duration only", row.id);
        cues = [];
        break;
      }
    }
  }
  try {
    const built = buildWebmHead({ head, durationMs, cues, rawLength: raw });
    return { bytes: built.bytes, replaces: built.replaces };
  } catch (err) {
    if (cues.length === 0) throw err;
    // Whatever the Cues tripped on, a Duration still makes the file sensible.
    console.warn("[recordings] cues didn't build; Duration only", row.id, err);
    const built = buildWebmHead({ head, durationMs, cues: [], rawLength: raw });
    return { bytes: built.bytes, replaces: built.replaces };
  }
}

/** Remove a take: its bytes, then its row. */
export async function deleteRecording(row: RecordingRow): Promise<boolean> {
  const admin = createAdminClient();
  try {
    const names = (await listObjects(row.storage_prefix)).map((o) => `${row.storage_prefix}/${o.name}`);
    for (let i = 0; i < names.length; i += 500) {
      const { error } = await admin.storage.from(RECORDING_BUCKET).remove(names.slice(i, i + 500));
      if (error) throw new Error(error.message);
    }
    const { error } = await admin.from("recording_sessions").delete().eq("id", row.id);
    if (error) throw new Error(error.message);
    return true;
  } catch (err) {
    console.error("[recordings] delete failed", row.id, err);
    return false;
  }
}

/**
 * Remove every take of a room, for when the room itself is deleted (an event):
 * nothing could reach them afterwards — the lists live on the room's pages,
 * and a take's id is the only other handle. Takes still recording go too (the
 * recorder's next part is refused). Audited per take, like a Delete; the
 * caller has checked who may. Best-effort: returns how many went and how many
 * could not, and never throws.
 */
export async function deleteRoomRecordings(
  kind: RecordingKind,
  roomId: string,
): Promise<{ deleted: number; failed: number }> {
  if (!isUuid(roomId)) return { deleted: 0, failed: 0 };
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("recording_sessions")
    .select(COLUMNS)
    .eq("room_kind", kind)
    .eq("room_id", roomId);
  if (error) {
    logError("room delete read failed", error);
    return { deleted: 0, failed: 0 };
  }
  let deleted = 0;
  let failed = 0;
  for (const r of (data ?? []) as any[]) {
    const row = toRow(r);
    if (await deleteRecording(row)) {
      deleted += 1;
      await logAudit({
        action: "recording.deleted",
        targetType: "recording_session",
        targetId: row.id,
        payload: { kind, roomId, startedAt: row.started_at, durationMs: row.duration_ms, by: row.started_by, withRoom: true },
      });
    } else {
      failed += 1;
    }
  }
  return { deleted, failed };
}

/** Short-lived signed URLs for a client-side download. */
export async function signedDownloadParts(
  row: RecordingRow,
  ttlSeconds = 15 * 60,
): Promise<{ head: string | null; parts: string[] } | null> {
  const container = containerFor(row.mime);
  if (!container) return null;
  const paths = row.part_sizes.map((_, i) => `${row.storage_prefix}/${partName(i, container)}`);
  if (row.head_bytes !== null) paths.unshift(`${row.storage_prefix}/${HEAD_NAME}`);
  const admin = createAdminClient();
  const { data, error } = await admin.storage.from(RECORDING_BUCKET).createSignedUrls(paths, ttlSeconds);
  if (error || !data || data.some((d) => !d.signedUrl)) {
    console.error("[recordings] sign download failed", error?.message);
    return null;
  }
  const urls = data.map((d) => d.signedUrl as string);
  return row.head_bytes !== null ? { head: urls[0], parts: urls.slice(1) } : { head: null, parts: urls };
}

/**
 * Audit a view of a call recording by someone who was not on the call — the
 * safeguarding access worth a trace. Once per viewer per take per half hour,
 * however many range requests the player makes.
 */
export async function auditRecordingView(row: RecordingRow, access: ViewAccess): Promise<void> {
  if (row.room_kind !== "call" || access.party) return;
  const admin = createAdminClient();
  const { data } = await admin
    .from("audit_log")
    .select("id")
    .eq("action", "recording.viewed")
    .eq("target_type", "recording_session")
    .eq("target_id", row.id)
    .eq("actor_id", access.viewerId)
    .gte("created_at", new Date(Date.now() - 30 * 60_000).toISOString())
    .limit(1);
  if (data && data.length > 0) return;
  await logAudit({
    action: "recording.viewed",
    targetType: "recording_session",
    targetId: row.id,
    payload: { kind: row.room_kind, roomId: row.room_id },
  });
}
