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
  type AssetKind,
  type EventAsset,
  type EventSpeaker,
} from "@/lib/webinars";
import { listAssets, listSpeakers } from "@/lib/webinar-data";

/**
 * Server actions for a webinar's files and its guest speakers.
 *
 * Two jobs that look unrelated and share one gate, which is why they live
 * together: both are "things an admin attaches to a webinar", both are written
 * from the same form, and both are also written from INSIDE the live room — a
 * recording segment uploads itself every five minutes while the webinar runs,
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
 * it deliberately does NOT extend to every kind of write: a guest may not edit
 * the speaker list, delete somebody else's file — or record. Every write in
 * this file currently takes the "staff" gate; "moderator" (staff or this
 * event's speakers) is kept for a guest-deck path that does not exist yet.
 *
 * Recordings in particular are staff-only. They used to take the moderator
 * gate, so any guest speaker could mint an upload URL and register a
 * "segment" — and once registration replaced rows, that meant overwriting the
 * staff recorder's segments with whatever file they liked and deleting the
 * originals from storage, one index at a time, with the follow-up email then
 * sending the result to the cohort. Speakers never record (pickRecorder; the
 * room only starts a recorder for a staff host the server picked), so they
 * lose nothing.
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
  // Staff work, every kind. A recording is uploaded from inside the room, but
  // only ever by the room's one recorder, which is always a staff host — never
  // a guest speaker (see gateWrite). Everything else is an admin attaching a
  // file to an event.
  await gateWrite(eventId, "staff");

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
 * Three checks before the insert, each of which has a specific thing it stops:
 *
 *  1. The path must live under this event's prefix. Otherwise a host of
 *     webinar A could attach webinar B's private recording to their own event
 *     and have the follow-up job email it out.
 *  2. The object must actually exist in the bucket. Otherwise a tampered client
 *     registers a path it never uploaded — a row that 404s on download and, for
 *     `auto_share`, an email promising a recording that was never made.
 *  3. The size must be inside the cap. The bucket enforces this too and that is
 *     the copy that binds; this one is what turns a refusal into a sentence.
 */
export async function registerWebinarAsset(
  eventId: string,
  input: RegisterAssetInput,
): Promise<EventAsset> {
  // Staff, recordings included — see gateWrite for why a guest speaker may
  // not register a segment.
  const { userId } = await gateWrite(eventId, "staff");

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

  const admin = createAdminClient();

  const segments = input.storagePath.split("/");
  const name = segments.pop() ?? "";
  const folder = segments.join("/");
  const { data: listed } = await admin.storage
    .from(BUCKET)
    .list(folder, { limit: 1, search: name });
  if (!listed?.some((o: any) => o.name === name)) {
    throw new Error("Upload didn't complete — try again.");
  }

  const row = {
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

  const data =
    input.kind === "recording"
      ? await saveRecordingSegment(admin, row)
      : await insertAsset(admin, row);

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
  // twelve of them, and twelve near-identical audit rows per event would bury
  // the entries a human actually reads. The admin-facing uploads are audited.
  if (input.kind !== "recording") {
    await logAudit({
      action: "event.asset_added",
      targetType: "event",
      targetId: eventId,
      payload: { kind: input.kind, filename: row.filename },
    });
  }

  revalidatePath("/admin/events");
  const r = data as any;
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

const ASSET_COLUMNS =
  "id, event_id, kind, storage_path, filename, mime_type, size_bytes, duration_seconds, sort_order, created_at";

type AssetRow = {
  event_id: string;
  kind: AssetKind;
  storage_path: string;
  filename: string;
  mime_type: string | null;
  size_bytes: number | null;
  duration_seconds: number | null;
  sort_order: number;
  uploaded_by: string;
};

async function insertAsset(
  admin: ReturnType<typeof createAdminClient>,
  row: AssetRow,
): Promise<any> {
  const { data, error } = await admin
    .from("event_assets")
    .insert(row)
    .select(ASSET_COLUMNS)
    .single();
  if (error) throw new Error(error.message);
  return data;
}

/**
 * Register one recording segment, never at the cost of another one.
 *
 * This used to be a PostgREST upsert with on_conflict=event_id,sort_order —
 * and it failed on EVERY segment with 42P10, because the only matching index
 * (event_assets_recording_segment, 0084) is PARTIAL (`where kind =
 * 'recording'`) and Postgres cannot infer a partial index from an ON CONFLICT
 * with no predicate. The bytes landed in storage and no row was ever written.
 * Its replacement then went too far the other way: ANY second registration at
 * an index replaced the row there and deleted its file. The index is chosen
 * by the client (seeded from the server when recording starts), and two
 * recorders can overlap — a presence blip that briefly picks a second staff
 * host, a handover while the old recorder's final upload is still in flight —
 * so one recorder's 12-second clip could silently replace the other's
 * five-minute segment. Now, in order:
 *
 *  1. The same FILE again (the storage path is minted per upload, so this is
 *     a repeated registration, not a new segment): return the row it already
 *     has. A path already attached to a different segment is refused — one
 *     object must never sit under two indices, or replacing one would delete
 *     the other's bytes.
 *  2. A retry of a segment THIS recorder already registered — same uploader,
 *     same segment name (`segment-0004.webm`, which carries the client's own
 *     index): replace that row wherever it ended up, and delete the file it
 *     pointed at. This is the case the replace exists for: a re-upload after a
 *     dropped connection must not play the same five minutes twice.
 *  3. Otherwise it is a new segment. Insert it at the index the recorder
 *     asked for; if that index is taken — by another staff recorder, or by
 *     one of this recorder's own segments that step 3 had to move earlier —
 *     insert it at the next free index instead. Never replace. The partial
 *     unique index is what makes "taken" atomic: a clash is a 23505, and the
 *     loop re-checks step 2 (a concurrent retry of the same segment) before
 *     moving on.
 *
 * Matching the retry on the segment name rather than on the index is what
 * stops step 3 from undoing itself: a segment moved from index 7 to 9 keeps
 * the name `segment-0007`, so when the same recorder's next segment (its own
 * index 8, then 9) arrives, it is recognised as new and appended — not taken
 * for a retry of the moved one and written over it.
 *
 * Overlapping recorders therefore interleave (playback order is sort_order,
 * so a few seconds may play out of sequence) but never lose a file. Speakers
 * cannot reach any of this: registration is staff-only (see gateWrite).
 */
async function saveRecordingSegment(
  admin: ReturnType<typeof createAdminClient>,
  row: AssetRow,
): Promise<any> {
  type Existing = {
    id: string;
    kind: string;
    storage_path: string;
    filename: string;
    uploaded_by: string | null;
  };
  const EXISTING_COLUMNS = "id, kind, storage_path, filename, uploaded_by";

  // 1. The same file, registered again.
  {
    const { data, error } = await admin
      .from("event_assets")
      .select(`${ASSET_COLUMNS}, uploaded_by`)
      .eq("event_id", row.event_id)
      .eq("storage_path", row.storage_path)
      .limit(1)
      .maybeSingle();
    if (error) throw new Error(error.message);
    const same = data as (Existing & Record<string, unknown>) | null;
    if (same) {
      if (
        same.kind === "recording" &&
        same.uploaded_by === row.uploaded_by &&
        same.filename === row.filename
      ) {
        return same;
      }
      throw new Error("That file is already attached to this event.");
    }
  }

  // 2. This recorder's own earlier registration of this segment, if any.
  const findOwn = async (): Promise<Existing | null> => {
    const { data, error } = await admin
      .from("event_assets")
      .select(EXISTING_COLUMNS)
      .eq("event_id", row.event_id)
      .eq("kind", "recording")
      .eq("uploaded_by", row.uploaded_by)
      .eq("filename", row.filename)
      .order("sort_order", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw new Error(error.message);
    return data as Existing | null;
  };

  const replace = async (existing: Existing) => {
    const { data, error } = await admin
      .from("event_assets")
      .update({
        storage_path: row.storage_path,
        filename: row.filename,
        mime_type: row.mime_type,
        size_bytes: row.size_bytes,
        duration_seconds: row.duration_seconds,
        uploaded_by: row.uploaded_by,
      })
      .eq("id", existing.id)
      .select(ASSET_COLUMNS)
      .single();
    if (error) throw new Error(error.message);
    if (existing.storage_path && existing.storage_path !== row.storage_path) {
      await removeIfUnreferenced(admin, existing.storage_path);
    }
    return data;
  };

  // 3. A new segment: the requested index if it is free, else the next one.
  // A handful of attempts is plenty — each clash means another registration
  // landed in the same instant, and there are at most a couple of recorders.
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const own = await findOwn();
    if (own) return replace(own);
    const sortOrder =
      attempt === 0
        ? row.sort_order
        : await nextFreeRecordingIndex(admin, row.event_id);
    const { data, error } = await admin
      .from("event_assets")
      .insert({ ...row, sort_order: sortOrder })
      .select(ASSET_COLUMNS)
      .single();
    if (!error) return data;
    if (error.code !== "23505") throw new Error(error.message);
  }
  throw new Error("Couldn't save that recording segment — try again.");
}

/**
 * Delete a replaced segment's file — unless some row still points at it.
 *
 * Registration refuses to attach one object twice (step 1 above), but rows
 * written before that rule existed may share a path, and deleting bytes
 * another row still serves would break that segment silently. Best-effort
 * both ways: a file we fail to delete costs storage; a check we cannot make
 * keeps the file.
 */
async function removeIfUnreferenced(
  admin: ReturnType<typeof createAdminClient>,
  storagePath: string,
): Promise<void> {
  try {
    const { count, error } = await admin
      .from("event_assets")
      .select("id", { count: "exact", head: true })
      .eq("storage_path", storagePath);
    if (error || (count ?? 0) > 0) return;
    await admin.storage.from(BUCKET).remove([storagePath]);
  } catch (err) {
    console.error("[webinars] replaced segment delete failed", err);
  }
}

/** One past the highest recording index registered for this event, or 0. */
async function nextFreeRecordingIndex(
  admin: ReturnType<typeof createAdminClient>,
  eventId: string,
): Promise<number> {
  const { data, error } = await admin
    .from("event_assets")
    .select("sort_order")
    .eq("event_id", eventId)
    .eq("kind", "recording")
    .order("sort_order", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(error.message);
  const top = (data as any)?.sort_order;
  return typeof top === "number" ? top + 1 : 0;
}

/**
 * The index the next recording segment should use: one past the highest
 * already registered for this event, or 0.
 *
 * Seeded from the server so a reload, a second recording run after Reopen, or
 * a handover to another staff host starts past everything already there
 * instead of at segment 0. A seed is only a starting point — two recorders
 * that overlap can still be handed the same one — and it is registration
 * (saveRecordingSegment) that guarantees they append rather than overwrite.
 * Staff only, the same gate as uploading a segment.
 */
export async function nextRecordingIndex(eventId: string): Promise<number> {
  await gateWrite(eventId, "staff");
  return nextFreeRecordingIndex(createAdminClient(), eventId);
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
