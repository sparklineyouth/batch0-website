import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { isDeckFile, MAX_DECK_BYTES } from "@/lib/webinars";

/**
 * Slides for an event: one PDF in the private `webinar-media` bucket at
 * `<eventId>/deck/<name>`, and an `event_assets` row (kind 'deck') pointing at
 * it. The bytes go straight from the browser to Storage on a signed URL, so
 * the upload can happen before the event row exists (a new event's id is
 * minted up front); the row is written when the event is saved.
 */

export const WEBINAR_BUCKET = "webinar-media";

type Admin = ReturnType<typeof createAdminClient>;

export type StagedDeck = {
  storagePath: string;
  filename: string;
  mimeType: string | null;
  sizeBytes: number | null;
};

function safeSegment(s: string) {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

/** A signed upload URL for one deck. The path is built here, never taken from the client. */
export async function mintDeckUpload(
  eventId: string,
  filename: string,
): Promise<{ path: string; token: string; signedUrl: string }> {
  if (!isDeckFile(filename)) throw new Error("Slides have to be a PDF.");
  const dot = filename.lastIndexOf(".");
  const base = dot > 0 ? filename.slice(0, dot) : filename;
  const path = `${eventId}/deck/${safeSegment(base) || "slides"}-${Date.now()}.pdf`;
  const { data, error } = await createAdminClient()
    .storage.from(WEBINAR_BUCKET)
    .createSignedUploadUrl(path);
  if (error) throw new Error(error.message);
  return { path: data.path, token: data.token, signedUrl: data.signedUrl };
}

/** Is this staged path one of `eventId`'s decks? (Prefix check; no I/O.) */
export function isDeckPathFor(eventId: string, storagePath: string): boolean {
  const prefix = `${eventId}/deck/`;
  return (
    storagePath.startsWith(prefix) &&
    !storagePath.slice(prefix.length).includes("/") &&
    !storagePath.includes("..")
  );
}

/** Throws a sentence unless the staged deck belongs to `eventId`, is a PDF, and is really in the bucket. */
export async function verifyStagedDeck(
  admin: Admin,
  eventId: string,
  deck: StagedDeck,
): Promise<void> {
  if (!isDeckPathFor(eventId, deck.storagePath)) {
    throw new Error("Those slides don't belong to this event.");
  }
  if (!isDeckFile(deck.filename, deck.mimeType)) {
    throw new Error("Slides have to be a PDF.");
  }
  if (deck.sizeBytes != null && deck.sizeBytes > MAX_DECK_BYTES) {
    throw new Error(`Slides are capped at ${MAX_DECK_BYTES / 1024 / 1024} MB.`);
  }
  const name = deck.storagePath.slice(`${eventId}/deck/`.length);
  const { data } = await admin.storage
    .from(WEBINAR_BUCKET)
    .list(`${eventId}/deck`, { limit: 1, search: name });
  if (!data?.some((o: any) => o.name === name)) {
    throw new Error("The slides didn't finish uploading. Pick the file again.");
  }
}

/** Register a verified deck and drop any older one (one deck per event). */
export async function attachDeck(
  admin: Admin,
  eventId: string,
  deck: StagedDeck,
  userId: string,
): Promise<void> {
  const { data: existing } = await admin
    .from("event_assets")
    .select("id, storage_path")
    .eq("event_id", eventId)
    .eq("kind", "deck");
  const already = (existing ?? []).find(
    (r: any) => r.storage_path === deck.storagePath,
  );
  if (!already) {
    const { error } = await admin.from("event_assets").insert({
      event_id: eventId,
      kind: "deck",
      storage_path: deck.storagePath,
      filename: deck.filename.slice(0, 200),
      mime_type: deck.mimeType || "application/pdf",
      size_bytes: deck.sizeBytes,
      duration_seconds: null,
      sort_order: 0,
      uploaded_by: userId,
    });
    if (error) throw new Error(error.message);
  }
  const older = (existing ?? []).filter(
    (r: any) => r.storage_path !== deck.storagePath,
  );
  if (older.length > 0) {
    await removeObjects(
      admin,
      older.map((r: any) => r.storage_path as string),
    );
    await admin
      .from("event_assets")
      .delete()
      .in(
        "id",
        older.map((r: any) => r.id as string),
      );
  }
}

/** Best-effort: a file we fail to delete costs storage, not correctness. */
export async function removeObjects(admin: Admin, paths: string[]): Promise<void> {
  if (paths.length === 0) return;
  try {
    const { error } = await admin.storage.from(WEBINAR_BUCKET).remove(paths);
    if (error) console.error("[events] storage remove failed", error.message);
  } catch (err) {
    console.error("[events] storage remove threw", err);
  }
}
