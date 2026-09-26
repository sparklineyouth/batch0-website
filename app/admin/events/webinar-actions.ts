"use server";
import { revalidatePath } from "next/cache";
import { randomBytes } from "node:crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import { assertPermission, requireActor } from "@/lib/server-guards";
import { can } from "@/lib/permissions";
import { logAudit } from "@/lib/audit";
import { env } from "@/lib/env";
import { sendEmail } from "@/lib/email/send";
import { Templates } from "@/lib/email/templates";
import { resolveEventAccess } from "@/lib/live-access";
import {
  isDeckFile,
  MAX_UPLOAD_BYTES,
  RECORDER_LEASE_MS,
  recordingFiledAt,
  recordingRival,
  recordingSegmentSlot,
  recordingSegmentStart,
  type AssetKind,
  type EventAsset,
  type EventSpeaker,
} from "@/lib/webinars";
import { PEER_TIMEOUT_MS } from "@/lib/live-signal";
import { listAssets, listSpeakers } from "@/lib/webinar-data";

/**
 * Server actions for a webinar's files and its guest speakers.
 *
 * Two jobs that look unrelated and share one gate, which is why they live
 * together: both are "things an admin attaches to a webinar", both are written
 * from the same form, and both are also written from INSIDE the live room — a
 * recording segment uploads itself every two minutes while the webinar runs,
 * and a guest speaker claims their slot on the way in.
 *
 * ---------------------------------------------------------------------------
 * Why this file exists at all, rather than reusing getUploadToken
 * ---------------------------------------------------------------------------
 *
 * app/admin/course/upload-actions.ts already mints signed upload URLs, and the
 * obvious move was to add `webinar-media` to its STAFF_BUCKETS set. That would
 * have been wrong in a way that is easy to miss: `getUploadToken` gates EVERY
 * staff bucket on `assertPermission("course.manage")`. Adding a bucket there
 * grants webinar uploads to whoever manages the course and denies them to
 * whoever manages events — precisely backwards — and it has no way at all to
 * express the third case this feature needs, which is a guest speaker who
 * holds no global permission and may upload exactly one deck to exactly one
 * event.
 *
 * ---------------------------------------------------------------------------
 * The upload path, and why the bytes never touch a Vercel function
 * ---------------------------------------------------------------------------
 *
 * Next's server-action body limit is 1 MB by default and this repo does not
 * raise it, so a recording segment cannot be POSTed to an action — the same
 * reasoning app/challenges/[slug]/actions.ts already writes down. So the
 * established three-step dance: this mints a signed upload URL, the browser
 * PUTs straight to Supabase Storage, and a second action records the path.
 *
 * `registerWebinarAsset` VERIFIES the object is really there before inserting
 * the row. Without that check a tampered client could register a path it never
 * uploaded — and for this feature that is not merely a broken download link, it
 * is a row the follow-up email will cheerfully send to the whole cohort.
 */

const BUCKET = "webinar-media";

/** Filesystem-safe path segment (mirrors the team-drive upload helper). */
function safeSegment(s: string) {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

/**
 * Authorize a write against one webinar.
 *
 * `events.manage` is the staff grant. A speaker row is the per-event grant, and
 * it deliberately does NOT extend to every kind of write: a guest may upload a
 * recording of the room they are in — any host's browser may be the one the
 * room elects to record (see "One recorder per webinar" in lib/webinars.ts) —
 * and may not edit the speaker list or delete somebody else's file. That split
 * is the whole point of having a per-event grant rather than handing a guest
 * `events.manage`.
 *
 * Both halves come from `resolveEventAccess` (lib/live-access.ts), the one
 * place the host rule is computed, so "may upload a segment of this room" and
 * "is a host in this room" are the same answer. It also means the event must
 * exist and be visible to the caller (staff always see it), where this used to
 * accept any event id at all from a staff caller.
 */
async function gateWrite(
  eventId: string,
  need: "staff" | "moderator",
): Promise<{ userId: string; isStaff: boolean }> {
  const access = await resolveEventAccess(eventId);
  if (!access.ok) {
    throw new Error(
      access.reason === "error" ? "Couldn't reach the server — try again." : "Forbidden",
    );
  }
  if (access.isStaff) return { userId: access.userId, isStaff: true };
  if (need === "staff" || !access.isSpeaker) throw new Error("Forbidden");
  return { userId: access.userId, isStaff: false };
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

/**
 * A signed URL the browser can PUT one file to.
 *
 * The path is built HERE, from the event id and the kind, and never taken from
 * the client. A client-chosen path is a client-chosen bucket prefix, and the
 * only thing standing between that and one webinar's deck overwriting
 * another's is a string comparison somebody has to remember to write.
 */
export async function getWebinarUploadToken(
  eventId: string,
  kind: AssetKind,
  filename: string,
): Promise<{ path: string; token: string; signedUrl: string }> {
  // A recording is uploaded from inside the room, by whoever is hosting it —
  // which may be a guest speaker. Everything else is an admin attaching a file
  // to an event, which is staff work.
  await gateWrite(eventId, kind === "recording" ? "moderator" : "staff");
  return mintUploadToken(eventId, kind, filename);
}

/** Build the path for one upload and sign it. Callers gate first. */
async function mintUploadToken(
  eventId: string,
  kind: AssetKind,
  filename: string,
): Promise<{ path: string; token: string; signedUrl: string }> {
  const dot = filename.lastIndexOf(".");
  const base = dot > 0 ? filename.slice(0, dot) : filename;
  const ext = dot > 0 ? filename.slice(dot + 1) : "";
  // Date.now() rather than a uuid, matching getUploadToken — it collides only
  // for two uploads of the same name in the same millisecond, and it sorts.
  const stamp = Date.now();
  const finalName = `${safeSegment(base) || "file"}-${stamp}${
    ext ? "." + safeSegment(ext) : ""
  }`;
  const path = `${eventId}/${kind}/${finalName}`;

  const admin = createAdminClient();
  const { data, error } = await admin.storage
    .from(BUCKET)
    .createSignedUploadUrl(path);
  if (error) throw new Error(error.message);
  return { path: data.path, token: data.token, signedUrl: data.signedUrl };
}

export type RegisterAssetInput = {
  kind: AssetKind;
  storagePath: string;
  filename: string;
  mimeType: string | null;
  sizeBytes: number | null;
  durationSeconds: number | null;
  /** Segment index for a recording. Ignored for everything else. */
  sortOrder?: number;
};

/**
 * Record an uploaded file against the event.
 *
 * Three checks before the insert (`verifyUpload`), each of which has a
 * specific thing it stops:
 *
 *  1. The path must live under this event's prefix. Otherwise a moderator of
 *     webinar A could attach webinar B's private recording to their own event
 *     and have the follow-up job email it out.
 *  2. The object must actually exist in the bucket. Otherwise a tampered client
 *     registers a path it never uploaded — a row that 404s on download and, for
 *     `auto_share`, an email promising a recording that was never made.
 *  3. The size must be inside the cap. The bucket enforces this too and that is
 *     the copy that binds; this one is what turns a refusal into a sentence.
 *
 * The live room files its recording segments through
 * `registerWebinarRecordingSegment` below, which answers a refusal with a
 * value the recorder can act on. A recording registered HERE gets the same
 * one-recorder check and throws on refusal, because this is still an entry
 * point anyone holding the action id can call.
 */
export async function registerWebinarAsset(
  eventId: string,
  input: RegisterAssetInput,
): Promise<EventAsset> {
  const { userId } = await gateWrite(
    eventId,
    input.kind === "recording" ? "moderator" : "staff",
  );
  const admin = createAdminClient();
  await verifyUpload(admin, eventId, input);

  const row = assetRow(eventId, input, userId);

  let data: any;
  if (input.kind === "recording") {
    // No segment start: this entry point is not the live room's, and has no
    // segment to date — any registration inside the lease counts.
    const filed = await fileRecordingSegment(admin, eventId, userId, row);
    if (!filed.ok) {
      throw new Error("Another host's browser is recording this webinar.");
    }
    data = filed.data;
  } else {
    const res = await admin
      .from("event_assets")
      .insert(row)
      .select(ASSET_COLUMNS)
      .single();
    if (res.error) throw new Error(res.error.message);
    data = res.data;
  }

  // A premiere's length is what positions every viewer's player, so it is
  // mirrored onto the event row where the join page can read it without a
  // second query. Only for a premiere — a deck has no duration and a recording
  // segment's is one segment's worth, not the webinar's.
  if (input.kind === "premiere" && input.durationSeconds) {
    await admin
      .from("events")
      .update({ premiere_seconds: Math.round(input.durationSeconds) })
      .eq("id", eventId);
  }

  // Deliberately NOT audited per recording segment: an hour-long webinar writes
  // thirty of them, and thirty near-identical audit rows per event would bury
  // the entries a human actually reads. The admin-facing uploads are audited.
  //
  // Nor REVALIDATED per segment, and that one is not about noise. Next re-renders
  // the CURRENT route whenever an action revalidates anything at all (the path
  // argument is not checked — "TODO: only revalidate if the path matches" in
  // Next's revalidate.ts), and a recording segment is registered from inside
  // the live room. Every segment therefore re-ran /dashboard/events/<id>/live,
  // and once a webinar has overrun its join window that page renders "This
  // event has ended" — so the next segment swapped the host's live room for
  // that shell mid-sentence, tearing down every viewer's connection. Nothing
  // on /admin/events needs to know about a segment the moment it lands.
  if (input.kind !== "recording") {
    await logAudit({
      action: "event.asset_added",
      targetType: "event",
      targetId: eventId,
      payload: { kind: input.kind, filename: row.filename },
    });
    revalidatePath("/admin/events");
  }

  return toAsset(data);
}

/**
 * A signed URL for one recording segment — or a refusal, because another
 * host's browser is this webinar's recorder.
 *
 * The live room asks before it uploads rather than finding out afterwards:
 * a refused segment should cost nothing, not twenty megabytes of the host's
 * upstream in the middle of their talk. The refusal is a VALUE, not a throw,
 * because production strips an action's error message and the recorder has to
 * tell "someone else is recording" (stand down, quietly) from "the upload
 * failed" (count it, say so).
 *
 * `durationSeconds` is how long the segment ran. The segment has already been
 * cut when this is asked, so it is known, and it is what lets the check
 * ignore a rival registration from BEFORE this segment began
 * (`recordingRival`): a returning recorder's old lease must not refuse the
 * handover flush of the host who covered for them.
 */
export async function getWebinarRecordingUploadToken(
  eventId: string,
  filename: string,
  durationSeconds?: number | null,
): Promise<
  { ok: true; path: string; token: string } | { ok: false; reason: "other_recorder" }
> {
  const { userId } = await gateWrite(eventId, "moderator");
  const admin = createAdminClient();
  if (await recordingRivalFor(admin, eventId, userId, durationSeconds)) {
    return { ok: false, reason: "other_recorder" };
  }
  const { path, token } = await mintUploadToken(eventId, "recording", filename);
  return { ok: true, path, token };
}

/**
 * File one uploaded recording segment — or refuse it, as above.
 *
 * Checked again here, not only when the upload was signed: two hosts can both
 * be signed in the same instant, and a whole upload sits between the two
 * checks — during which the other host's segment may have landed. No audit
 * and no revalidate, for the reasons in `registerWebinarAsset`.
 *
 * A refused segment's bytes are deleted, since nothing will ever point at
 * them — but ONLY once the database confirms nothing already does. The path
 * comes from the browser, and `verifyUpload` proves only that it is under this
 * event's recording prefix and exists; it does not prove this caller uploaded
 * it. Deleting unconditionally let any host (a guest speaker included) name a
 * co-host's already-registered segment, be refused, and have the server
 * delete that stretch of the replay for them. A legitimately refused segment
 * is always a freshly minted path nothing has claimed, so this changes nothing
 * for it; and when the check cannot be read, the bytes are left alone — an
 * orphaned file costs storage, a deleted registered one costs the recording.
 */
export async function registerWebinarRecordingSegment(
  eventId: string,
  input: Omit<RegisterAssetInput, "kind">,
): Promise<{ ok: true } | { ok: false; reason: "other_recorder" }> {
  const { userId } = await gateWrite(eventId, "moderator");
  const admin = createAdminClient();
  const full: RegisterAssetInput = { ...input, kind: "recording" };
  await verifyUpload(admin, eventId, full);
  const filed = await fileRecordingSegment(
    admin,
    eventId,
    userId,
    assetRow(eventId, full, userId),
    input.durationSeconds,
  );
  if (!filed.ok) {
    const { data: claimed, error: claimErr } = await admin
      .from("event_assets")
      .select("id")
      .eq("storage_path", full.storagePath)
      .limit(1);
    if (!claimErr && (claimed ?? []).length === 0) {
      try {
        await admin.storage.from(BUCKET).remove([full.storagePath]);
      } catch (err) {
        console.error("[webinars] refused segment cleanup failed", err);
      }
    }
    return { ok: false, reason: "other_recorder" };
  }
  return { ok: true };
}

/** The three checks `registerWebinarAsset` documents. Throws a sentence. */
async function verifyUpload(
  admin: ReturnType<typeof createAdminClient>,
  eventId: string,
  input: RegisterAssetInput,
): Promise<void> {
  const prefix = `${eventId}/${input.kind}/`;
  if (!input.storagePath.startsWith(prefix)) {
    throw new Error("That file doesn't belong to this event.");
  }
  if (input.sizeBytes != null && input.sizeBytes > MAX_UPLOAD_BYTES) {
    throw new Error("Files are capped at 2 GB.");
  }
  if (input.kind === "deck" && !isDeckFile(input.filename, input.mimeType)) {
    throw new Error("A deck has to be a PDF or a PowerPoint file.");
  }

  const segments = input.storagePath.split("/");
  const name = segments.pop() ?? "";
  const folder = segments.join("/");
  const { data: listed } = await admin.storage
    .from(BUCKET)
    .list(folder, { limit: 1, search: name });
  if (!listed?.some((o: any) => o.name === name)) {
    throw new Error("Upload didn't complete — try again.");
  }
}

function assetRow(eventId: string, input: RegisterAssetInput, userId: string) {
  return {
    event_id: eventId,
    kind: input.kind,
    storage_path: input.storagePath,
    filename: input.filename.slice(0, 200),
    mime_type: input.mimeType,
    size_bytes: input.sizeBytes,
    duration_seconds: input.durationSeconds,
    sort_order: input.sortOrder ?? 0,
    uploaded_by: userId,
  };
}

function toAsset(r: any): EventAsset {
  return {
    id: r.id,
    eventId: r.event_id,
    kind: r.kind,
    storagePath: r.storage_path,
    filename: r.filename,
    mimeType: r.mime_type ?? null,
    sizeBytes: r.size_bytes ?? null,
    durationSeconds: r.duration_seconds ?? null,
    sortOrder: r.sort_order ?? 0,
    createdAt: r.created_at,
  };
}

/**
 * Is somebody else this event's recorder, such that `userId`'s segment must be
 * refused? Their user id if so.
 *
 * The server half of "one recorder per webinar" (lib/webinars.ts): the live
 * room elects one host's browser, and this refuses segments from anyone the
 * election ranks below a host who registered a segment within the lease (and
 * since this segment began, when its length is known) and is still in the
 * room. Built from rows that already exist — the event's recent recording
 * rows and live attendance — so there is no lease column to migrate and
 * nothing to clean up after a crash.
 *
 * Attendance is best-effort, like everywhere else it is read: a database
 * without `live_participants` counts every recent recorder as present, and
 * the lease alone decides.
 */
async function recordingRivalFor(
  admin: ReturnType<typeof createAdminClient>,
  eventId: string,
  userId: string,
  segmentSeconds?: number | null,
): Promise<string | null> {
  const now = new Date();
  const since = new Date(now.getTime() - RECORDER_LEASE_MS).toISOString();
  const { data: recent, error } = await admin
    .from("event_assets")
    .select("uploaded_by, created_at")
    .eq("event_id", eventId)
    .eq("kind", "recording")
    .neq("uploaded_by", userId)
    .gte("created_at", since)
    .limit(50);
  // A failed read must not stop a webinar being recorded; the client-side
  // election is still in force, and this is its backstop, not its gate.
  if (error || !recent || recent.length === 0) return null;

  const rivals = [
    ...new Set(recent.map((r: any) => r.uploaded_by as string).filter(Boolean)),
  ];
  let present: Set<string> | null = null;
  const { data: here, error: hereErr } = await admin
    .from("live_participants")
    .select("user_id")
    .eq("event_id", eventId)
    .in("user_id", rivals)
    .is("left_at", null)
    .gte("last_seen_at", new Date(now.getTime() - PEER_TIMEOUT_MS).toISOString());
  if (!hereErr) present = new Set((here ?? []).map((r: any) => r.user_id as string));

  return recordingRival({
    callerId: userId,
    recent: recent.map((r: any) => ({
      userId: r.uploaded_by ?? null,
      at: r.created_at,
    })),
    present,
    now,
    segmentStartMs: recordingSegmentStart(now, segmentSeconds),
  });
}

const ASSET_COLUMNS =
  "id, event_id, kind, storage_path, filename, mime_type, size_bytes, duration_seconds, sort_order, created_at";

/**
 * File one recording segment: refuse it if another host is the recorder,
 * otherwise register it at its slot. The one-recorder check and the insert
 * run back to back, so the window in which two hosts can both pass is the
 * length of one round trip rather than one segment.
 *
 * The row is dated by `recordingFiledAt`: now, unless the uploader has already
 * left the room — a departing recorder's final segment, which uploads behind
 * the "You've left" screen while a co-host has taken over — in which case it
 * is dated to their last heartbeat, so it can never pass for a registration
 * made during the successor's segment (and refuse that segment when they come
 * back). `created_at` carries it because `recordingRivalFor` already reads
 * it; nothing else orders recordings by it (sort_order is the order).
 */
async function fileRecordingSegment(
  admin: ReturnType<typeof createAdminClient>,
  eventId: string,
  userId: string,
  row: ReturnType<typeof assetRow>,
  segmentSeconds?: number | null,
): Promise<{ ok: true; data: any } | { ok: false }> {
  if (await recordingRivalFor(admin, eventId, userId, segmentSeconds)) {
    return { ok: false };
  }
  const filedAt = await departedFiledAt(admin, eventId, userId);
  const { data, error } = await registerRecordingSegment(
    admin,
    filedAt ? { ...row, created_at: filedAt } : row,
  );
  if (error) throw new Error(error.message);
  return { ok: true, data };
}

/**
 * The date to file `userId`'s segment under when they are no longer in the
 * room (see `recordingFiledAt`), or null to file it now — also the answer
 * when attendance can't be read, which is how every segment was dated before.
 */
async function departedFiledAt(
  admin: ReturnType<typeof createAdminClient>,
  eventId: string,
  userId: string,
): Promise<string | null> {
  const { data, error } = await admin
    .from("live_participants")
    .select("left_at, last_seen_at")
    .eq("event_id", eventId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error || !data) return null;
  const now = new Date();
  const at = recordingFiledAt(
    now,
    {
      leftAt: (data as any).left_at ?? null,
      lastSeenAt: (data as any).last_seen_at ?? null,
    },
    PEER_TIMEOUT_MS,
  );
  return at.getTime() < now.getTime() ? at.toISOString() : null;
}

/**
 * Register one recording segment without ever writing over another.
 *
 * This used to be an upsert with `onConflict: "event_id,sort_order"`, and it
 * could not work: the unique index it names is PARTIAL (`where kind =
 * 'recording'`, migration 0084), Postgres only accepts a partial index as an
 * ON CONFLICT target when the statement repeats the predicate, and PostgREST
 * has no way to say it. Every segment was refused with 42P10 — pinned in
 * lib/webinars-migration-db.test.ts.
 *
 * So: read the segments the event already has, let `recordingSegmentSlot`
 * decide (the same file again keeps its row; a segment from a run the event
 * has seen goes at that run's base plus its index; a new run — a reload, or a
 * second host taking over — starts a new block after the last), and insert.
 * The partial unique index still guards the insert; a 23505 means another
 * segment took the slot between the read and the write, so read again and ask
 * again. Three rounds is far more than two-minute segments can race for.
 */
async function registerRecordingSegment(
  admin: ReturnType<typeof createAdminClient>,
  row: {
    event_id: string;
    storage_path: string;
    sort_order: number;
    [k: string]: unknown;
  },
): Promise<{ data: any; error: { message: string } | null }> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const { data: taken, error: readErr } = await admin
      .from("event_assets")
      .select("sort_order, storage_path")
      .eq("event_id", row.event_id)
      .eq("kind", "recording");
    if (readErr) return { data: null, error: readErr };

    const slot = recordingSegmentSlot(
      row.sort_order,
      row.storage_path,
      (taken ?? []).map((t: any) => ({
        sortOrder: t.sort_order,
        storagePath: t.storage_path,
      })),
    );

    if (slot.kind === "existing") {
      return admin
        .from("event_assets")
        .select(ASSET_COLUMNS)
        .eq("event_id", row.event_id)
        .eq("kind", "recording")
        .eq("sort_order", slot.sortOrder)
        .single();
    }

    const res = await admin
      .from("event_assets")
      .insert({ ...row, sort_order: slot.sortOrder })
      .select(ASSET_COLUMNS)
      .single();
    if (!res.error || (res.error as any).code !== "23505") return res;
  }
  return {
    data: null,
    error: { message: "Couldn't file that recording segment — try again." },
  };
}

/** Detach a file and delete the bytes. Staff only. */
export async function removeWebinarAsset(
  eventId: string,
  assetId: string,
): Promise<void> {
  await gateWrite(eventId, "staff");
  const admin = createAdminClient();
  const { data: existing } = await admin
    .from("event_assets")
    .select("storage_path, kind, filename")
    .eq("id", assetId)
    .eq("event_id", eventId)
    .maybeSingle();
  if (!existing) return;

  // Bytes first, row second. The row is the only record of the path, so the
  // other order leaks an orphaned object nothing will ever point at again.
  // Best-effort on the storage side: a file we fail to delete costs storage,
  // whereas a row that refuses to delete is a stuck admin.
  try {
    await admin.storage.from(BUCKET).remove([(existing as any).storage_path]);
  } catch (err) {
    console.error("[webinars] asset delete failed", err);
  }
  const { error } = await admin
    .from("event_assets")
    .delete()
    .eq("id", assetId)
    .eq("event_id", eventId);
  if (error) throw new Error(error.message);

  if ((existing as any).kind === "premiere") {
    await admin
      .from("events")
      .update({ premiere_seconds: null })
      .eq("id", eventId);
  }

  await logAudit({
    action: "event.asset_removed",
    targetType: "event",
    targetId: eventId,
    payload: { filename: (existing as any).filename },
  });
  revalidatePath("/admin/events");
}

/** Everything attached to an event. Staff read — includes unshared files. */
export async function fetchWebinarAssets(
  eventId: string,
): Promise<EventAsset[]> {
  await assertPermission("events.manage");
  return listAssets(eventId);
}

/**
 * The speakers and files an existing event already has, for the edit form.
 *
 * Read on demand rather than carried by the admin list query, which would
 * otherwise haul every speaker biography and every file row for every event on
 * the calendar in order to populate one form.
 *
 * It matters more than a normal seed, because `saveSpeakers` replaces the whole
 * list: a form that opened with an empty speaker array and was then saved would
 * DELETE the speakers the event already had. The caller must not enable saving
 * until this has landed.
 */
export async function fetchWebinarExtras(eventId: string): Promise<{
  speakers: EventSpeaker[];
  assets: EventAsset[];
}> {
  await assertPermission("events.manage");
  const [speakers, assets] = await Promise.all([
    listSpeakers(eventId, true),
    listAssets(eventId),
  ]);
  return { speakers, assets };
}

// ---------------------------------------------------------------------------
// Speakers
// ---------------------------------------------------------------------------

export type SpeakerInput = {
  id?: string;
  name: string;
  title: string | null;
  bio: string | null;
  email: string | null;
  photoUrl: string | null;
  linkUrl: string | null;
  sortOrder: number;
};

/**
 * Replace an event's speaker list.
 *
 * Whole-list rather than per-row, because the form edits it as a list — rows
 * are added, removed and reordered together, and three round trips to express
 * one save is how a list ends up half-applied when the third one fails.
 *
 * Rows that survive are matched by id and UPDATED, not deleted and re-inserted.
 * That matters: the id is what a claimed speaker's `user_id` hangs off, and
 * re-creating the row would silently revoke a guest's access mid-webinar
 * because an admin fixed a typo in their job title.
 */
export async function saveSpeakers(
  eventId: string,
  speakers: SpeakerInput[],
): Promise<EventSpeaker[]> {
  await gateWrite(eventId, "staff");
  const admin = createAdminClient();

  const clean = speakers
    .map((s, i) => ({ ...s, sortOrder: i }))
    .filter((s) => s.name.trim().length > 0)
    .slice(0, 20);

  const keep = clean.map((s) => s.id).filter(Boolean) as string[];
  let del = admin.from("event_speakers").delete().eq("event_id", eventId);
  if (keep.length > 0) del = del.not("id", "in", `(${keep.join(",")})`);
  const { error: delError } = await del;
  if (delError) throw new Error(delError.message);

  for (const s of clean) {
    const payload = {
      event_id: eventId,
      name: s.name.trim().slice(0, 120),
      title: s.title?.trim().slice(0, 160) || null,
      bio: s.bio?.trim().slice(0, 1000) || null,
      email: s.email?.trim().toLowerCase() || null,
      photo_url: s.photoUrl?.trim() || null,
      link_url: s.linkUrl?.trim() || null,
      sort_order: s.sortOrder,
    };
    if (s.id) {
      const { error } = await admin
        .from("event_speakers")
        .update(payload)
        .eq("id", s.id)
        .eq("event_id", eventId);
      if (error) throw new Error(error.message);
    } else {
      const { error } = await admin.from("event_speakers").insert({
        ...payload,
        // Minted on creation so the invite link exists the moment the row does.
        // 32 bytes of base64url — this is the only credential in the feature
        // that is guessable in principle, so it is sized to make that
        // impossible in practice rather than merely unlikely.
        claim_token: randomBytes(32).toString("base64url"),
      });
      if (error) throw new Error(error.message);
    }
  }

  await logAudit({
    action: "event.speakers_updated",
    targetType: "event",
    targetId: eventId,
    payload: { count: clean.length },
  });
  revalidatePath("/admin/events");
  return listSpeakers(eventId, true);
}

/**
 * The link a guest opens to become a speaker.
 *
 * Minted on demand rather than returned with the speaker list, so a live token
 * exists only in the moment an admin is copying it. `listSpeakers` never
 * selects the column at all, and migration 0084 revokes it from `authenticated`
 * outright — a student who could read a token could claim the slot and, through
 * `credentialsFor`, walk out with the room's audience list.
 */
export async function speakerInviteLink(
  eventId: string,
  speakerId: string,
): Promise<string> {
  await gateWrite(eventId, "staff");
  const admin = createAdminClient();
  const { data } = await admin
    .from("event_speakers")
    .select("claim_token")
    .eq("id", speakerId)
    .eq("event_id", eventId)
    .maybeSingle();
  const token = (data as any)?.claim_token;
  if (!token) throw new Error("That speaker has already claimed their slot.");
  return inviteUrlFor(eventId, token);
}
function inviteUrlFor(eventId: string, token: string): string {
  return `${env.siteUrl}/dashboard/events/${eventId}/live?speaker=${token}`;
}

/**
 * Email a guest their claim link. Staff only.
 *
 * The form has always said the speaker's email is "where the invite goes", and
 * the template has always existed — but nothing sent it, so a guest could only
 * ever get in if an admin copied the link out by hand (and there was no button
 * for that either). Sent to the address on the speaker row, never to one the
 * client supplies, and refused once the slot is claimed: a spent token cannot
 * be re-sent, and a claimed guest needs no link.
 */
export async function sendSpeakerInvite(
  eventId: string,
  speakerId: string,
): Promise<void> {
  const { userId } = await gateWrite(eventId, "staff");
  const admin = createAdminClient();
  const [{ data: speaker }, { data: event }, { data: me }] = await Promise.all([
    admin
      .from("event_speakers")
      .select("id, name, email, claim_token, user_id")
      .eq("id", speakerId)
      .eq("event_id", eventId)
      .maybeSingle(),
    admin
      .from("events")
      .select("title, starts_at")
      .eq("id", eventId)
      .maybeSingle(),
    admin.from("profiles").select("full_name").eq("id", userId).maybeSingle(),
  ]);
  const sp = speaker as any;
  if (!sp) throw new Error("That speaker isn't on this event.");
  if (sp.user_id || !sp.claim_token) {
    throw new Error("That speaker has already claimed their slot.");
  }
  if (!sp.email) throw new Error("Add an email for this speaker first.");
  if (!event) throw new Error("That event no longer exists.");

  const t = Templates.speakerInvite({
    eventTitle: (event as any).title,
    startsAt: (event as any).starts_at,
    inviteUrl: inviteUrlFor(eventId, sp.claim_token),
    hostName: (me as any)?.full_name || "The batch0 team",
  });
  await sendEmail({ to: sp.email, subject: t.subject, html: t.html });

  await logAudit({
    action: "event.speaker_invited",
    targetType: "event",
    targetId: eventId,
    payload: { speakerId },
  });
}


/**
 * Claim a speaker slot.
 *
 * Deliberately a CLAIM and not an authentication. The caller must already be a
 * signed-in batch0 user — this is not a way around the auth wall — and all the
 * token does is attach that existing account to a row an admin already created.
 * It is spent on first use, so a forwarded link fails closed rather than
 * handing a second person a camera.
 *
 * Returns quietly rather than throwing on a bad token. This runs on the way
 * into the live page for anyone arriving with a `?speaker=` parameter, and a
 * stale link — the common case, since the token is cleared on claim and the
 * guest will reload that URL — must not turn the webinar into an error page.
 *
 * Staff never claim. They host every webinar through `events.manage` and need
 * no speaker row — and the obvious way to check a "Copy invite link" is to
 * open it in your own signed-in browser. That used to bind the guest's slot
 * to the admin and spend the token: the real guest's link was dead (and
 * neither Copy nor Send will mint one for a claimed row), and the admin,
 * now on the speaker list, was treated as a guest by everything that told
 * staff from speakers that way. So a staff caller is a no-op here and the
 * link survives for the guest it was made for.
 */
export async function claimSpeakerSlot(
  eventId: string,
  token: string,
): Promise<boolean> {
  const actor = await requireActor();
  if (!token || token.length < 16) return false;
  if (can(actor.caps, "events.manage")) return false;
  const admin = createAdminClient();

  // Conditional on the token still being present, so two people racing the
  // same link converge on one winner: the second update matches no row.
  const { data, error } = await admin
    .from("event_speakers")
    .update({ user_id: actor.userId, claim_token: null })
    .eq("event_id", eventId)
    .eq("claim_token", token)
    .is("user_id", null)
    .select("id")
    .maybeSingle();
  if (error || !data) return false;

  await logAudit({
    action: "event.speaker_claimed",
    targetType: "event",
    targetId: eventId,
    payload: { speakerId: (data as any).id },
  });
  return true;
}
