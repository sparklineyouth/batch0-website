/**
 * Recording takes as stored: numbered parts in the private `recordings`
 * bucket, served back as one file. The numbers and the byte math, with no I/O.
 *
 * A take is ONE MediaRecorder run. Its byte stream is cut into parts (about
 * every PART_TARGET_MS, at most PART_MAX_BYTES) purely for upload: part n is
 * bytes [Σsizes<n, +size n) of the stream, so the parts concatenated are the
 * recording. For WebM a rewritten head (lib/recording-webm.ts) replaces the
 * stream's first `headReplaces` bytes. Everything below maps that virtual file
 * onto head + parts.
 *
 * Pure and import-free; tested by lib/recording-parts.test.ts.
 */

export const RECORDING_BUCKET = "recordings";

/** Composite canvas size and rate. */
export const RECORDING_WIDTH = 1280;
export const RECORDING_HEIGHT = 720;
export const RECORDING_FPS = 24;
/**
 * 1.2 Mbps video + 96 kbps audio: ~580 MB an hour, on an uplink that is also
 * carrying the live call. Slides and faces stay clean at this rate.
 */
export const RECORDING_VIDEO_BITRATE = 1_200_000;
export const RECORDING_AUDIO_BITRATE = 96_000;
/** Keyframe spacing (Chrome honours `videoKeyFrameIntervalDuration`): seek granularity. */
export const RECORDING_KEYFRAME_MS = 2_000;
/** MediaRecorder timeslice. */
export const RECORDING_CHUNK_MS = 1_000;

/** Seal a part after this long… */
export const PART_TARGET_MS = 10_000;
/** …or this many bytes, whichever first. */
export const PART_MAX_BYTES = 8 * 1024 * 1024;
/** Most parts one take may have (~5.5 hours at PART_TARGET_MS). */
export const MAX_PARTS = 2_000;
/** Recorded-but-unsent bytes a tab may hold before it stops recording. */
export const UNSENT_BYTES_CAP = 192 * 1024 * 1024;

/** The recorder bumps its lease at least this often… */
export const HEARTBEAT_MS = 10_000;
/** …and a lease this stale is someone whose tab is gone. */
export const STALE_AFTER_MS = 45_000;

/** Largest 206 the media route sends (under Vercel's 4.5 MB response cap). */
export const RANGE_CAP_BYTES = 4 * 1024 * 1024;

/** Takes shorter than this fold under "Also recorded". */
export const SHORT_TAKE_MS = 15_000;

/** Container and codecs, in preference order. Safari only records MP4. */
export const MIME_CANDIDATES = [
  "video/webm;codecs=vp8,opus",
  "video/webm;codecs=vp9,opus",
  "video/webm",
  "video/mp4",
] as const;

export type Container = "webm" | "mp4";

/** The container a recorder MIME type writes, or null for anything else. */
export function containerFor(mime: unknown): Container | null {
  if (typeof mime !== "string" || mime.length > 100) return null;
  const base = mime.split(";")[0].trim().toLowerCase();
  if (base === "video/webm") return "webm";
  if (base === "video/mp4") return "mp4";
  return null;
}

export function contentTypeFor(container: Container): string {
  return container === "mp4" ? "video/mp4" : "video/webm";
}

/** `part-000042.webm`. */
export function partName(index: number, container: Container): string {
  return `part-${String(index).padStart(6, "0")}.${container}`;
}

export function parsePartName(name: string): { index: number; container: Container } | null {
  const m = /^part-(\d{6})\.(webm|mp4)$/.exec(name);
  if (!m) return null;
  return { index: Number(m[1]), container: m[2] as Container };
}

/** `<kind>/<roomId>/<sessionId>` inside the bucket. */
export function storagePrefix(kind: "webinar" | "call", roomId: string, sessionId: string): string {
  return `${kind}/${roomId}/${sessionId}`;
}

export const HEAD_NAME = "head.webm";

/**
 * Sizes of parts 0..n-1 from a storage listing: the run with no gap from
 * part 0. A part after a gap is unplayable (WebM cannot resume mid-stream), so
 * it is not served.
 */
export function contiguousParts(
  objects: readonly { name: string; size: number | null | undefined }[],
  container: Container,
): number[] {
  const byIndex = new Map<number, number>();
  for (const o of objects) {
    const p = parsePartName(o.name);
    if (!p || p.container !== container) continue;
    if (typeof o.size !== "number" || !(o.size > 0)) continue;
    byIndex.set(p.index, o.size);
  }
  const sizes: number[] = [];
  while (byIndex.has(sizes.length)) sizes.push(byIndex.get(sizes.length)!);
  return sizes;
}

/** How the served file is laid out. */
export type Layout = {
  /** Rewritten head size, or null when the parts are served as they are. */
  headBytes: number | null;
  /** Bytes of the raw stream the head replaces. */
  headReplaces: number;
  partSizes: readonly number[];
};

export function rawLength(partSizes: readonly number[]): number {
  let n = 0;
  for (const s of partSizes) n += s;
  return n;
}

/** Size of the file as served. */
export function servedLength(layout: Layout): number {
  const raw = rawLength(layout.partSizes);
  if (layout.headBytes === null) return raw;
  return layout.headBytes + Math.max(0, raw - layout.headReplaces);
}

export type ByteRange = { start: number; end: number };

/**
 * A `Range` header against a file of `total` bytes. Null: no (usable) Range,
 * serve from the start. "unsatisfiable": answer 416. Several ranges are
 * answered with the first.
 */
export function parseRange(header: string | null | undefined, total: number): ByteRange | null | "unsatisfiable" {
  if (!header) return null;
  const m = /^\s*bytes\s*=\s*([^,]+)/i.exec(header);
  if (!m) return null;
  const spec = m[1].trim();
  const parts = /^(\d*)\s*-\s*(\d*)$/.exec(spec);
  if (!parts || (parts[1] === "" && parts[2] === "")) return null;
  if (total <= 0) return "unsatisfiable";
  if (parts[1] === "") {
    const suffix = Number(parts[2]);
    if (!(suffix > 0)) return "unsatisfiable";
    return { start: Math.max(0, total - suffix), end: total - 1 };
  }
  const start = Number(parts[1]);
  if (!Number.isSafeInteger(start) || start >= total) return "unsatisfiable";
  const end = parts[2] === "" ? total - 1 : Math.min(Number(parts[2]), total - 1);
  if (!Number.isSafeInteger(end) || end < start) return "unsatisfiable";
  return { start, end };
}

/** At most `cap` bytes of a range. */
export function capRange(range: ByteRange, cap: number = RANGE_CAP_BYTES): ByteRange {
  return { start: range.start, end: Math.min(range.end, range.start + cap - 1) };
}

/** Where a slice of the served file comes from: the head, or part `index`. */
export type Piece =
  | { source: "head"; from: number; to: number }
  | { source: "part"; index: number; from: number; to: number };

/**
 * The pieces (inclusive byte ranges in their own objects) that make up bytes
 * [start, end] of the served file, in order.
 */
export function mapRange(layout: Layout, start: number, end: number): Piece[] {
  const out: Piece[] = [];
  let v = start;
  const head = layout.headBytes;
  if (head !== null && v < head) {
    const to = Math.min(end, head - 1);
    out.push({ source: "head", from: v, to });
    v = to + 1;
  }
  if (v > end) return out;
  // Served offset → raw stream offset.
  let raw = head === null ? v : v - head + layout.headReplaces;
  const rawEnd = head === null ? end : end - head + layout.headReplaces;
  let partStart = 0;
  for (let i = 0; i < layout.partSizes.length && raw <= rawEnd; i++) {
    const size = layout.partSizes[i];
    const partEnd = partStart + size - 1;
    if (raw <= partEnd) {
      const to = Math.min(rawEnd, partEnd);
      out.push({ source: "part", index: i, from: raw - partStart, to: to - partStart });
      raw = to + 1;
    }
    partStart += size;
  }
  return out;
}

/** Which part holds raw stream offset `offset`, and where in it. */
export function locateRaw(
  partSizes: readonly number[],
  offset: number,
): { index: number; offset: number } | null {
  let start = 0;
  for (let i = 0; i < partSizes.length; i++) {
    if (offset < start + partSizes[i]) return offset >= start ? { index: i, offset: offset - start } : null;
    start += partSizes[i];
  }
  return null;
}

/** May a part with this index be minted when `minted` parts already have been? */
export function canMintPart(index: unknown, minted: number): index is number {
  return (
    typeof index === "number" &&
    Number.isInteger(index) &&
    index >= 0 &&
    index < MAX_PARTS &&
    // The next part, or the latest one again (a retry after a lost answer).
    // Never ahead (a gap makes everything after it unplayable), and never an
    // earlier part: what is uploaded stays as it was recorded.
    (index === minted || index === minted - 1)
  );
}

/**
 * Did a part's upload fail only because that part is already stored?
 *
 * Part tokens are minted without upsert, so a stored part can't be replaced:
 * not by a second upload during the take, and not with a token kept after it
 * (they live two hours). The one honest way to hit this is a retry of the
 * same part after its first upload landed but the answer was lost, which
 * re-sends the same bytes — so it counts as uploaded. Storage answers HTTP
 * 400 with statusCode "409" / "Duplicate"; older servers sent a plain 409.
 */
export function isDuplicateUpload(
  error: { status?: unknown; statusCode?: unknown; message?: unknown; error?: unknown } | null | undefined,
): boolean {
  if (!error) return false;
  if (error.status === 409 || String(error.statusCode ?? "") === "409") return true;
  const text = `${typeof error.error === "string" ? error.error : ""} ${typeof error.message === "string" ? error.message : ""}`;
  return /\bduplicate\b|already exists/i.test(text);
}

export function isStale(heartbeatAt: string | number | Date, now: number = Date.now()): boolean {
  const t = new Date(heartbeatAt).getTime();
  return !Number.isFinite(t) || now - t > STALE_AFTER_MS;
}

/** Retry delay for upload attempt `n` (0-based): 1s, 2s, 4s… capped at 15s. */
export function retryDelayMs(attempt: number): number {
  return Math.min(15_000, 1000 * 2 ** Math.max(0, Math.min(attempt, 10)));
}

/** "4:05", "1:02:03". */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/** A download file name: "<title> <yyyy-mm-dd>.<ext>", filesystem-safe. */
export function downloadName(title: string | null, startedAt: string, container: Container): string {
  const date = new Date(startedAt);
  const day = Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : "recording";
  const base = (title ?? "")
    .replace(/[^\p{L}\p{N} _.,()-]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  return `${base ? `${base} ` : "Recording "}${day}.${container}`;
}
