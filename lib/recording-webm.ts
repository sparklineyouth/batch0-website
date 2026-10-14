/**
 * WebM (Matroska/EBML) for recordings: a streaming scanner the recorder runs
 * over its own output, and the head rewrite that makes the stitched file
 * seekable.
 *
 * Chrome's MediaRecorder writes "live" WebM: a Segment and Clusters of unknown
 * size, no Duration, no Cues. Played from a URL that gives no total length and
 * no seek index, so a player can only scan forward. Every byte passes through
 * the recorder's tab, so it notes where each video keyframe's Cluster starts
 * (WebmScanner). At finalize the server rewrites only the head (everything
 * before the first Cluster): Info gains a Duration, and a Cues element listing
 * those Clusters goes in front of them. The Cluster
 * bytes are never touched; the stitched file is head + parts minus the
 * original head.
 *
 * Pure and import-free; tested by lib/recording-webm.test.ts.
 */

export const EBML_ID = 0x1a45dfa3;
export const SEGMENT_ID = 0x18538067;
const SEEKHEAD_ID = 0x114d9b74;
const INFO_ID = 0x1549a966;
const TIMECODE_SCALE_ID = 0x2ad7b1;
const DURATION_ID = 0x4489;
const TRACKS_ID = 0x1654ae6b;
const TRACK_ENTRY_ID = 0xae;
const TRACK_NUMBER_ID = 0xd7;
const TRACK_TYPE_ID = 0x83;
export const CLUSTER_ID = 0x1f43b675;
const TIMECODE_ID = 0xe7;
const SIMPLE_BLOCK_ID = 0xa3;
const BLOCK_GROUP_ID = 0xa0;
const BLOCK_ID = 0xa1;
const REFERENCE_BLOCK_ID = 0xfb;
const CUES_ID = 0x1c53bb6b;
const CUE_POINT_ID = 0xbb;
const CUE_TIME_ID = 0xb3;
const CUE_TRACK_POSITIONS_ID = 0xb7;
const CUE_TRACK_ID = 0xf7;
const CUE_CLUSTER_POSITION_ID = 0xf1;
const VOID_ID = 0xec;
const TAGS_ID = 0x1254c367;
const CHAPTERS_ID = 0x1043a770;
const ATTACHMENTS_ID = 0x1941a469;

/** Segment children: seeing one inside an unknown-size Cluster ends it. */
const LEVEL1 = new Set([
  SEEKHEAD_ID,
  INFO_ID,
  TRACKS_ID,
  CLUSTER_ID,
  CUES_ID,
  TAGS_ID,
  CHAPTERS_ID,
  ATTACHMENTS_ID,
]);

const DEFAULT_TIMECODE_SCALE = 1_000_000; // ns per timecode unit: 1 ms
/** Info and Tracks are read whole; anything larger is not a recorder's head. */
const MAX_HEAD_ELEMENT = 1 << 20;

/** [byte offset of a keyframe Cluster in the raw stream, its time in ms]. */
export type Cue = [offset: number, timeMs: number];

type Header = {
  id: number;
  /** Null: unknown size. */
  size: number | null;
  headerLength: number;
};

/** An element header at `pos`, or null when `buf` ends before it does. */
function readHeader(buf: Uint8Array, pos: number): Header | null | "invalid" {
  if (pos >= buf.length) return null;
  const first = buf[pos];
  const idLen = vintLength(first);
  if (idLen === 0 || idLen > 4) return "invalid";
  if (pos + idLen >= buf.length) return null;
  let id = 0;
  for (let i = 0; i < idLen; i++) id = id * 256 + buf[pos + i];
  const sizeFirst = buf[pos + idLen];
  const sizeLen = vintLength(sizeFirst);
  if (sizeLen === 0) return "invalid";
  if (pos + idLen + sizeLen > buf.length) return null;
  let value = sizeFirst & (0xff >> sizeLen);
  let allOnes = value === 0xff >> sizeLen;
  for (let i = 1; i < sizeLen; i++) {
    const b = buf[pos + idLen + i];
    if (b !== 0xff) allOnes = false;
    value = value * 256 + b;
  }
  return { id, size: allOnes ? null : value, headerLength: idLen + sizeLen };
}

/** Length of a vint from its first byte (0 for a zero byte). */
function vintLength(first: number): number {
  for (let i = 0; i < 8; i++) if (first & (0x80 >> i)) return i + 1;
  return 0;
}

function readUint(buf: Uint8Array, start: number, length: number): number {
  let v = 0;
  for (let i = 0; i < length; i++) v = v * 256 + buf[start + i];
  return v;
}

/** A Block's track number and relative timecode, from its first bytes. */
function readBlockHeader(
  buf: Uint8Array,
  pos: number,
  available: number,
): { track: number; rel: number; flags: number } | null {
  if (available < 1) return null;
  const tl = vintLength(buf[pos]);
  if (tl === 0 || available < tl + 3) return null;
  let track = buf[pos] & (0xff >> tl);
  for (let i = 1; i < tl; i++) track = track * 256 + buf[pos + i];
  const raw = (buf[pos + tl] << 8) | buf[pos + tl + 1];
  const rel = raw & 0x8000 ? raw - 0x10000 : raw;
  return { track, rel, flags: buf[pos + tl + 2] };
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (a.length === 0) return b;
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/** TrackNumber → TrackType from a Tracks body. */
function parseTracks(body: Uint8Array): Map<number, number> {
  const out = new Map<number, number>();
  let p = 0;
  while (p < body.length) {
    const h = readHeader(body, p);
    if (!h || h === "invalid" || h.size === null) break;
    const start = p + h.headerLength;
    if (h.id === TRACK_ENTRY_ID) {
      let number = 0;
      let type = 0;
      let q = start;
      const end = start + h.size;
      while (q < end) {
        const c = readHeader(body, q);
        if (!c || c === "invalid" || c.size === null) break;
        const cs = q + c.headerLength;
        if (c.id === TRACK_NUMBER_ID) number = readUint(body, cs, c.size);
        if (c.id === TRACK_TYPE_ID) type = readUint(body, cs, c.size);
        q = cs + c.size;
      }
      if (number > 0) out.set(number, type);
    }
    p = start + h.size;
  }
  return out;
}

function parseTimecodeScale(infoBody: Uint8Array): number {
  let p = 0;
  while (p < infoBody.length) {
    const h = readHeader(infoBody, p);
    if (!h || h === "invalid" || h.size === null) break;
    const start = p + h.headerLength;
    if (h.id === TIMECODE_SCALE_ID && h.size > 0 && h.size <= 8) {
      const v = readUint(infoBody, start, h.size);
      if (v > 0) return v;
    }
    p = start + h.size;
  }
  return DEFAULT_TIMECODE_SCALE;
}

// ---------------------------------------------------------------------------
// Streaming scanner
// ---------------------------------------------------------------------------

/**
 * Reads a WebM byte stream as it is produced, chunk by chunk, and reports
 * each Cluster that holds a video keyframe: where it starts and when.
 *
 * Holds only what it must (an element header split across chunks, or the
 * small Info/Tracks bodies); block payloads are skipped by count. Any
 * structure it does not expect stops it (`failed`) rather than guessing — the
 * file is then finalized with a Duration and no Cues.
 */
export class WebmScanner {
  /** Bytes seen so far. */
  bytes = 0;
  /** Offset of the first Cluster: everything before it is the head. */
  firstCluster: number | null = null;
  /** Latest block time seen, in ms. */
  maxTimeMs = 0;
  failed: string | null = null;

  private buf: Uint8Array = new Uint8Array(0);
  private bufStart = 0;
  private skip = 0;
  private ctx: "top" | "segment" | "cluster" | "group" = "top";
  private scale = DEFAULT_TIMECODE_SCALE;
  private videoTracks = new Set<number>();
  private clusterStart = 0;
  private clusterEnd: number | null = null;
  private clusterTimecode: number | null = null;
  private clusterCued = false;
  private groupEnd = 0;
  private groupBlock: { track: number; rel: number } | null = null;
  private groupReferenced = false;

  /** Feed the next chunk; returns the keyframe Clusters it completed. */
  push(chunk: Uint8Array): Cue[] {
    const out: Cue[] = [];
    this.bytes += chunk.length;
    if (this.failed) return out;
    this.buf = concat(this.buf, chunk);
    let pos = 0;
    const fail = (why: string) => {
      this.failed = why;
      this.buf = new Uint8Array(0);
      this.skip = 0;
    };

    for (;;) {
      if (this.skip > 0) {
        const n = Math.min(this.skip, this.buf.length - pos);
        pos += n;
        this.skip -= n;
        if (this.skip > 0) break;
        continue;
      }
      const abs = this.bufStart + pos;
      if (this.ctx === "group" && abs >= this.groupEnd) {
        this.endGroup(out);
        this.ctx = "cluster";
        continue;
      }
      if (this.ctx === "cluster" && this.clusterEnd !== null && abs >= this.clusterEnd) {
        this.ctx = "segment";
        continue;
      }

      const h = readHeader(this.buf, pos);
      if (h === null) break;
      if (h === "invalid") {
        fail(`bad element header at ${abs}`);
        return out;
      }
      const bodyStart = pos + h.headerLength;
      const available = this.buf.length - bodyStart;

      if (this.ctx === "top") {
        if (h.id === SEGMENT_ID) {
          this.ctx = "segment";
          pos = bodyStart;
        } else if (h.id === EBML_ID && h.size !== null) {
          pos = bodyStart;
          this.skip = h.size;
        } else {
          fail(`unexpected element ${h.id.toString(16)} before the Segment`);
          return out;
        }
        continue;
      }

      if (this.ctx === "segment") {
        if (h.id === CLUSTER_ID) {
          this.clusterStart = abs;
          this.firstCluster ??= abs;
          this.clusterEnd = h.size === null ? null : abs + h.headerLength + h.size;
          this.clusterTimecode = null;
          this.clusterCued = false;
          this.ctx = "cluster";
          pos = bodyStart;
          continue;
        }
        if (h.size === null) {
          fail(`unknown-size element ${h.id.toString(16)} in the Segment`);
          return out;
        }
        if (h.id === INFO_ID || h.id === TRACKS_ID) {
          if (h.size > MAX_HEAD_ELEMENT) {
            fail("oversized head element");
            return out;
          }
          if (available < h.size) break;
          const body = this.buf.subarray(bodyStart, bodyStart + h.size);
          if (h.id === INFO_ID) this.scale = parseTimecodeScale(body);
          else {
            for (const [n, type] of parseTracks(body)) if (type === 1) this.videoTracks.add(n);
          }
          pos = bodyStart + h.size;
          continue;
        }
        pos = bodyStart;
        this.skip = h.size;
        continue;
      }

      if (this.ctx === "cluster") {
        if (LEVEL1.has(h.id)) {
          // An unknown-size Cluster ends where the next level-1 element starts.
          this.ctx = "segment";
          continue;
        }
        if (h.size === null) {
          fail(`unknown-size element ${h.id.toString(16)} in a Cluster`);
          return out;
        }
        if (h.id === TIMECODE_ID) {
          if (h.size > 8) {
            fail("bad Cluster timecode");
            return out;
          }
          if (available < h.size) break;
          this.clusterTimecode = readUint(this.buf, bodyStart, h.size);
          pos = bodyStart + h.size;
          continue;
        }
        if (h.id === SIMPLE_BLOCK_ID) {
          const need = Math.min(h.size, 11);
          if (available < need) break;
          const b = readBlockHeader(this.buf, bodyStart, Math.min(available, h.size));
          if (!b) {
            fail("bad SimpleBlock");
            return out;
          }
          if (!this.block(b.track, b.rel, (b.flags & 0x80) !== 0, out)) {
            fail("block before the Cluster timecode");
            return out;
          }
          pos = bodyStart;
          this.skip = h.size;
          continue;
        }
        if (h.id === BLOCK_GROUP_ID) {
          this.groupEnd = abs + h.headerLength + h.size;
          this.groupBlock = null;
          this.groupReferenced = false;
          this.ctx = "group";
          pos = bodyStart;
          continue;
        }
        pos = bodyStart;
        this.skip = h.size;
        continue;
      }

      // ctx === "group"
      if (h.size === null) {
        fail("unknown-size element in a BlockGroup");
        return out;
      }
      if (h.id === BLOCK_ID) {
        const need = Math.min(h.size, 11);
        if (available < need) break;
        const b = readBlockHeader(this.buf, bodyStart, Math.min(available, h.size));
        if (!b) {
          fail("bad Block");
          return out;
        }
        this.groupBlock = { track: b.track, rel: b.rel };
      } else if (h.id === REFERENCE_BLOCK_ID) {
        this.groupReferenced = true;
      }
      pos = bodyStart;
      this.skip = h.size;
    }

    this.bufStart += pos;
    this.buf = this.buf.subarray(pos);
    return out;
  }

  private endGroup(out: Cue[]) {
    const b = this.groupBlock;
    this.groupBlock = null;
    if (b && !this.block(b.track, b.rel, !this.groupReferenced, out)) {
      this.failed = "block before the Cluster timecode";
    }
  }

  /** One block. False when it cannot be placed in time. */
  private block(track: number, rel: number, key: boolean, out: Cue[]): boolean {
    if (this.clusterTimecode === null) return false;
    const timeMs = Math.max(0, ((this.clusterTimecode + rel) * this.scale) / 1e6);
    if (timeMs > this.maxTimeMs) this.maxTimeMs = timeMs;
    if (key && !this.clusterCued && this.videoTracks.has(track)) {
      this.clusterCued = true;
      out.push([this.clusterStart, Math.round(timeMs)]);
    }
    return true;
  }
}

// ---------------------------------------------------------------------------
// Head rewrite
// ---------------------------------------------------------------------------

export type WebmHead = {
  /** The EBML header element, verbatim. */
  ebml: Uint8Array;
  /** Segment children before the first Cluster, verbatim, in order. */
  children: { id: number; bytes: Uint8Array }[];
  /** Byte offset of the first Cluster. */
  firstCluster: number;
  timecodeScale: number;
  /** First video track number, or null. */
  videoTrack: number | null;
};

/** Parse everything up to the first Cluster, or null if it isn't WebM as recorded. */
export function parseWebmHead(bytes: Uint8Array): WebmHead | null {
  const ebml = readHeader(bytes, 0);
  if (!ebml || ebml === "invalid" || ebml.id !== EBML_ID || ebml.size === null) return null;
  const ebmlEnd = ebml.headerLength + ebml.size;
  const seg = readHeader(bytes, ebmlEnd);
  if (!seg || seg === "invalid" || seg.id !== SEGMENT_ID) return null;
  let p = ebmlEnd + seg.headerLength;
  const children: { id: number; bytes: Uint8Array }[] = [];
  let scale = DEFAULT_TIMECODE_SCALE;
  let videoTrack: number | null = null;
  for (;;) {
    const h = readHeader(bytes, p);
    if (!h || h === "invalid") return null;
    if (h.id === CLUSTER_ID) break;
    if (h.size === null) return null;
    const end = p + h.headerLength + h.size;
    if (end > bytes.length) return null;
    const body = bytes.subarray(p + h.headerLength, end);
    if (h.id === INFO_ID) scale = parseTimecodeScale(body);
    if (h.id === TRACKS_ID) {
      for (const [n, type] of parseTracks(body)) {
        if (type === 1 && videoTrack === null) videoTrack = n;
      }
    }
    children.push({ id: h.id, bytes: bytes.subarray(p, end) });
    p = end;
  }
  if (!children.some((c) => c.id === INFO_ID) || !children.some((c) => c.id === TRACKS_ID)) {
    return null;
  }
  return {
    ebml: bytes.subarray(0, ebmlEnd),
    children,
    firstCluster: p,
    timecodeScale: scale,
    videoTrack,
  };
}

// --- writing ---------------------------------------------------------------

function idBytes(id: number): number[] {
  const out: number[] = [];
  let v = id;
  while (v > 0) {
    out.unshift(v & 0xff);
    v = Math.floor(v / 256);
  }
  return out;
}

/** A size vint, minimal length unless `length` is given. */
function sizeBytes(value: number, length?: number): number[] {
  let len = length ?? 1;
  if (length === undefined) while (value >= 2 ** (7 * len) - 1) len++;
  if (len > 8 || value >= 2 ** (7 * len) - 1) throw new Error("EBML size out of range");
  const out = new Array<number>(len);
  let v = value;
  for (let i = len - 1; i >= 0; i--) {
    out[i] = v % 256;
    v = Math.floor(v / 256);
  }
  out[0] |= 0x80 >> (len - 1);
  return out;
}

function uintBytes(value: number, length: number): number[] {
  const out = new Array<number>(length);
  let v = Math.max(0, Math.floor(value));
  for (let i = length - 1; i >= 0; i--) {
    out[i] = v % 256;
    v = Math.floor(v / 256);
  }
  return out;
}

function element(id: number, body: ArrayLike<number>, sizeLength?: number): number[] {
  return [...idBytes(id), ...sizeBytes(body.length, sizeLength), ...Array.from(body)];
}

function float64Bytes(value: number): number[] {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setFloat64(0, value);
  return Array.from(b);
}

/** Info with Duration set (in the head's timecode units). */
function rewriteInfo(info: Uint8Array, durationUnits: number): number[] {
  const h = readHeader(info, 0);
  if (!h || h === "invalid" || h.size === null) throw new Error("bad Info");
  const body: number[] = [];
  let p = h.headerLength;
  while (p < info.length) {
    const c = readHeader(info, p);
    if (!c || c === "invalid" || c.size === null) break;
    const end = p + c.headerLength + c.size;
    if (c.id !== DURATION_ID && c.id !== VOID_ID) body.push(...info.subarray(p, end));
    p = end;
  }
  body.push(...element(DURATION_ID, float64Bytes(durationUnits)));
  return element(INFO_ID, body);
}

/** Bytes of one CuePoint as built below (fixed widths, so sizes are known up front). */
const CUE_POINT_BYTES = 1 + 1 + (1 + 1 + 8) + (1 + 1 + (1 + 1 + 1) + (1 + 1 + 8));

/**
 * Keyframe cues that can be trusted against a stream of `rawLength` bytes whose
 * first Cluster is at `firstCluster`: inside it, offsets strictly rising,
 * times not falling.
 */
export function usableCues(cues: readonly Cue[], firstCluster: number, rawLength: number): Cue[] {
  const sorted = cues
    .filter(
      (c) =>
        Array.isArray(c) &&
        Number.isSafeInteger(c[0]) &&
        Number.isFinite(c[1]) &&
        c[0] >= firstCluster &&
        c[0] < rawLength &&
        c[1] >= 0,
    )
    .slice()
    .sort((a, b) => a[0] - b[0]);
  const out: Cue[] = [];
  for (const c of sorted) {
    const last = out[out.length - 1];
    if (last && (c[0] === last[0] || c[1] < last[1])) continue;
    out.push([c[0], Math.round(c[1])]);
  }
  return out;
}

const UNKNOWN_SIZE = [0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff];

/**
 * The replacement head: EBML header, the Segment header, Info with a
 * Duration, Tracks, any other pre-Cluster elements (never a SeekHead, Cues or
 * Void — their offsets would be stale), then Cues pointing at the Clusters as
 * they sit after this head. Served in place of the first `head.firstCluster`
 * bytes of the raw stream.
 */
export function buildWebmHead(args: {
  head: WebmHead;
  durationMs: number;
  cues: readonly Cue[];
  /** Bytes in the raw stream (the contiguous parts). */
  rawLength: number;
}): { bytes: Uint8Array; replaces: number; cueCount: number } {
  const { head, rawLength } = args;
  const units = (Math.max(0, args.durationMs) * 1e6) / head.timecodeScale;
  const info = head.children.find((c) => c.id === INFO_ID)!;
  const before: number[] = [...rewriteInfo(info.bytes, units)];
  for (const c of head.children) {
    if (c.id === INFO_ID || c.id === SEEKHEAD_ID || c.id === CUES_ID || c.id === VOID_ID) {
      continue;
    }
    before.push(...c.bytes);
  }

  const cues =
    head.videoTrack === null ? [] : usableCues(args.cues, head.firstCluster, rawLength);
  // Cues: ID + an 8-byte size vint, so its length depends only on the count.
  const cuesLength = cues.length > 0 ? 4 + 8 + cues.length * CUE_POINT_BYTES : 0;
  const clustersAt = before.length + cuesLength; // relative to the Segment's data
  const cueBytes: number[] = [];
  if (cues.length > 0) {
    const body: number[] = [];
    for (const [offset, timeMs] of cues) {
      const time = Math.round((timeMs * 1e6) / head.timecodeScale);
      const positions = [
        ...element(CUE_TRACK_ID, uintBytes(head.videoTrack!, 1)),
        ...element(CUE_CLUSTER_POSITION_ID, uintBytes(clustersAt + (offset - head.firstCluster), 8)),
      ];
      const point = [
        ...element(CUE_TIME_ID, uintBytes(time, 8)),
        ...element(CUE_TRACK_POSITIONS_ID, positions),
      ];
      body.push(...element(CUE_POINT_ID, point));
    }
    cueBytes.push(...element(CUES_ID, body, 8));
  }

  // The Segment stays unknown-size, as recorded: its Clusters are
  // unknown-size, and players (FFmpeg) object to those inside a sized parent.
  const out = [...head.ebml, ...idBytes(SEGMENT_ID), ...UNKNOWN_SIZE, ...before, ...cueBytes];
  return { bytes: Uint8Array.from(out), replaces: head.firstCluster, cueCount: cues.length };
}

/** Do these bytes start a Cluster? (Spot-checking a cue against storage.) */
export function isClusterStart(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && readUint(bytes, 0, 4) === CLUSTER_ID;
}
