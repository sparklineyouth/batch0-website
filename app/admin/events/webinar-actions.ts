"use server";
import { revalidatePath } from "next/cache";
import { randomBytes } from "node:crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import { assertPermission, requireActor } from "@/lib/server-guards";
import { can } from "@/lib/permissions";
import { logAudit } from "@/lib/audit";
import { env } from "@/lib/env";
import {
  isDeckFile,
  MAX_UPLOAD_BYTES,
  recordingSegmentSlot,
  type AssetKind,
  type EventAsset,
  type EventSpeaker,
} from "@/lib/webinars";
import { listAssets, listSpeakers, speakerUserIds } from "@/lib/webinar-data";

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
 * it deliberately does NOT extend to every kind of write: a guest may attach
 * their own deck and upload a recording of the room they are in, and may not
 * edit the speaker list or delete somebody else's file. That split is the whole
 * point of having a per-event grant rather than handing a guest `events.manage`.
 */
async function gateWrite(
  eventId: string,
  need: "staff" | "moderator",
): Promise<{ userId: string; isStaff: boolean }> {
  const actor = await requireActor();
  const isStaff = can(actor.caps, "events.manage");
  if (isStaff) return { userId: actor.userId, isStaff: true };
  if (need === "staff") throw new Error("Forbidden");
  const speakers = await speakerUserIds(eventId);
  if (!speakers.includes(actor.userId)) throw new Error("Forbidden");
  return { userId: actor.userId, isStaff: false };
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
 *  1. The path must live under this event's prefix. Otherwise a moderator of
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
  const { userId } = await gateWrite(
    eventId,
    input.kind === "recording" ? "moderator" : "staff",
  );

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

  const { data, error } =
    input.kind === "recording"
      ? await registerRecordingSegment(admin, row)
      : await admin.from("event_assets").insert(row).select(ASSET_COLUMNS).single();
  if (error) throw new Error(error.message);

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
 * decide (the same file again keeps its row; a free index is taken; an index
 * held by a different file — a reloaded recorder numbering from zero — goes
 * after the last one), and insert. The partial unique index still guards the
 * insert; a 23505 means another segment took the slot between the read and the
 * write, so read again and ask again. Three rounds is far more than two
 * five-minute segments can race for.
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
  return `${env.siteUrl}/dashboard/events/${eventId}/live?speaker=${token}`;
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
 */
export async function claimSpeakerSlot(
  eventId: string,
  token: string,
): Promise<boolean> {
  const actor = await requireActor();
  if (!token || token.length < 16) return false;
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
