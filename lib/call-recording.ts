/**
 * Where a 1:1 call's recording lives, what its files are called, and how the
 * two people are laid out in the picture — the rules, with no I/O.
 *
 * ---------------------------------------------------------------------------
 * Why the storage bucket IS the index
 * ---------------------------------------------------------------------------
 *
 * Webinar segments are rows in `event_assets`, whose `event_id` references
 * `events` — so a call has nowhere to put a row, and adding a table (or a
 * `call_id` column) is a migration this change deliberately does not make.
 * Instead the file NAME carries everything a row would have: which call (the
 * folder), which segment (the index) and when (the stamp). Listing the folder
 * with the service role is the whole read path, and it cannot drift from the
 * bytes because it is the bytes.
 *
 * The files go in their OWN private bucket, `call-recordings`, not beside the
 * webinar files. `webinar-media` carries a staff-direct storage policy
 * (0084's "webinar-media staff all", granted by `events.manage`, which interns
 * hold by default) — so anything in it is downloadable through the Storage API
 * by roles the app would never show a 1:1 recording to. These are recordings
 * of calls with minors. The dedicated bucket has NO storage policies at all:
 * only the service role can touch it, and every read and write goes through a
 * server action that checks the call first and mints a one-shot signed URL.
 * The app creates the bucket on first use (lib/call-recordings.ts), so there is
 * no migration.
 *
 * Why the stamp matters and the index is not enough: the recorder numbers
 * segments from zero every time the page loads, so a host who reloads
 * mid-call starts a second run whose segment 0 would collide with the first
 * run's. Names are unique by the stamp, and ordering is by the stamp first —
 * which is also chronological, because a segment is uploaded the moment it
 * finishes.
 *
 * Pure and import-free; tested by lib/call-recording.test.ts.
 */

export const CALL_RECORDING_BUCKET = "call-recordings";

/**
 * Same ceiling as webinar-media (0084), which a five-minute segment is far
 * inside; it bounds what one signed upload can put in the bucket.
 */
export const CALL_RECORDING_MAX_BYTES = 2 * 1024 * 1024 * 1024;

/** A call's segment folder inside the `call-recordings` bucket. */
export function callRecordingFolder(inviteId: string): string {
  return `calls/${inviteId}/recording`;
}

/**
 * Largest segment index accepted. Five-minute segments make a 240-minute call
 * (the longest the CHECK allows) 48 files; this is headroom for many reloads,
 * and a ceiling on what a tampered client can ask to have signed.
 */
export const MAX_SEGMENT_INDEX = 9_999;

export type SegmentExtension = "webm" | "mp4";

/**
 * The container a recorder produced, from its MIME type.
 *
 * Safari's `MediaRecorder` only writes MP4, and a file called `.webm` that is
 * really MP4 plays in some players and not others — so the name follows the
 * bytes rather than assuming Chrome.
 */
export function segmentExtension(mimeType: string | null | undefined): SegmentExtension {
  return /^video\/mp4/i.test(mimeType ?? "") ? "mp4" : "webm";
}

/** `segment-0003-1790000000000.webm` */
export function callSegmentName(
  index: number,
  stamp: number,
  ext: SegmentExtension = "webm",
): string {
  return `segment-${String(index).padStart(4, "0")}-${stamp}.${ext}`;
}

const SEGMENT_RE = /^segment-(\d{4,})-(\d{10,})\.(webm|mp4)$/;

/** The parts of a segment's file name, or null for anything else in the folder. */
export function parseCallSegmentName(
  name: string,
): { index: number; stamp: number; ext: SegmentExtension } | null {
  const m = SEGMENT_RE.exec(name);
  if (!m) return null;
  const index = Number(m[1]);
  const stamp = Number(m[2]);
  if (!Number.isSafeInteger(index) || !Number.isSafeInteger(stamp)) return null;
  return { index, stamp, ext: m[3] as SegmentExtension };
}

/** Segments in playback order: by run (stamp), then by index within it. */
export function sortCallSegments<T extends { name: string }>(files: readonly T[]): T[] {
  return files
    .map((f) => ({ f, p: parseCallSegmentName(f.name) }))
    .filter((x): x is { f: T; p: NonNullable<ReturnType<typeof parseCallSegmentName>> } => !!x.p)
    .sort((a, b) => a.p.stamp - b.p.stamp || a.p.index - b.p.index)
    .map((x) => x.f);
}

/** An index the upload action will sign a path for. */
export function isValidSegmentIndex(index: unknown): index is number {
  return (
    typeof index === "number" &&
    Number.isInteger(index) &&
    index >= 0 &&
    index <= MAX_SEGMENT_INDEX
  );
}

/**
 * A UUID, as Postgres prints one.
 *
 * Route params reach the recording endpoints as free text and go into a
 * storage prefix; anything that is not a bare id must never get that far.
 */
export function isUuid(s: unknown): s is string {
  return (
    typeof s === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)
  );
}

// ---------------------------------------------------------------------------
// The composed picture
// ---------------------------------------------------------------------------

export type Box = { x: number; y: number; w: number; h: number };

/**
 * Side by side, one column per person, the full height of the frame.
 *
 * Equal columns rather than a big speaker and a small one: nobody in a 1:1 is
 * the audience, and a recording that makes the student a thumbnail says
 * something about whose meeting it was. Each video is contain-fitted inside
 * its column by the drawer, so a 16:9 camera in a 640×720 column letterboxes
 * top and bottom instead of being cropped to someone's forehead.
 *
 * Integer edges, with the last column taking any remainder, so three people
 * in 1280 pixels do not leave a one-pixel seam of backdrop between tiles.
 */
export function callTileBoxes(count: number, width: number, height: number): Box[] {
  const n = Math.max(1, Math.floor(count));
  const col = Math.floor(width / n);
  return Array.from({ length: n }, (_, i) => ({
    x: i * col,
    y: 0,
    w: i === n - 1 ? width - i * col : col,
    h: height,
  }));
}

/**
 * Small camera insets along the bottom-right, for while someone presents.
 *
 * The shared screen takes the frame — it is what the two of them are looking
 * at — and each person's face drops to a 16:9 inset, right to left, the way
 * the webinar recording drops the host to a corner. Clamped so any number of
 * people still fits inside the frame rather than running off the left edge.
 */
export function callInsetBoxes(count: number, width: number, height: number): Box[] {
  const n = Math.max(1, Math.floor(count));
  const margin = Math.round(width * 0.01875); // 24px at 1280
  const gap = Math.round(margin / 2);
  const ideal = Math.round(width * 0.2); // 256px at 1280
  const fit = Math.floor((width - margin * 2 - gap * (n - 1)) / n);
  const w = Math.max(1, Math.min(ideal, fit));
  const h = Math.round((w * 9) / 16);
  return Array.from({ length: n }, (_, i) => ({
    x: width - margin - w - i * (w + gap),
    y: height - margin - h,
    w,
    h,
  }));
}
