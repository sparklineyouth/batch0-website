/**
 * 1:1 recordings: which calls can have one, and the legacy segment files
 * calls were recorded as before one-take recording (migration 0095), named
 * and ordered. No I/O.
 *
 * A call's recording used to be self-contained two-minute files in the
 * private `call-recordings` bucket, with no table: the file name carried
 * which call (the folder), which segment (the index), when (the stamp) and
 * later who uploaded it and whether it was their last —
 * `calls/<id>/recording/segment-NNNN-<stamp>[-<uploader>[-last]].<webm|mp4>`.
 * Nothing writes them any more; the legacy player (lib/recording-legacy.ts)
 * plays them back to back in the order below.
 *
 * Pure; the one import is lib/live.ts by relative path, so `node --test`
 * runs it as is. Tested by lib/call-recording.test.ts.
 */
import { CALL_STAFF_OPENS_MINUTES_BEFORE } from "./live.ts";

/**
 * Could this call have a recording to show? Recording starts with the staff
 * side in the room, which opens CALL_STAFF_OPENS_MINUTES_BEFORE the start —
 * for an invite still unanswered just as for an accepted one. So: an
 * accepted, completed or never-answered call once its room has opened; a
 * cancelled or declined one only if that happened after it opened (or when
 * isn't known). Saying yes too often costs one empty list request; saying no
 * wrongly hides a recording from everyone.
 */
export function callMayHaveRecording(
  call: { status: string; startsAt: string; updatedAt?: string },
  now: Date,
): boolean {
  const opens = Date.parse(call.startsAt) - CALL_STAFF_OPENS_MINUTES_BEFORE * 60_000;
  if (!Number.isFinite(opens) || opens > now.getTime()) return false;
  if (call.status === "accepted" || call.status === "completed" || call.status === "invited") return true;
  if (call.status !== "cancelled" && call.status !== "declined") return false;
  const at = call.updatedAt ? Date.parse(call.updatedAt) : NaN;
  return !Number.isFinite(at) || at >= opens;
}

export const CALL_RECORDING_BUCKET = "call-recordings";

/** A call's segment folder inside the `call-recordings` bucket. */
export function callRecordingFolder(inviteId: string): string {
  return `calls/${inviteId}/recording`;
}

const SEGMENT_RE =
  /^segment-(\d{4,})-(\d{10,})(?:-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(-last)?)?\.(webm|mp4)$/;

export type ParsedCallSegment = {
  index: number;
  stamp: number;
  ext: "webm" | "mp4";
  /** Null for a segment named before uploaders were (migration 0092). */
  uploaderId: string | null;
  /** The segment its recorder captured as it stopped. */
  last: boolean;
};

/** The parts of a segment's file name, or null for anything else in the folder. */
export function parseCallSegmentName(name: string): ParsedCallSegment | null {
  const m = SEGMENT_RE.exec(name);
  if (!m) return null;
  const index = Number(m[1]);
  const stamp = Number(m[2]);
  if (!Number.isSafeInteger(index) || !Number.isSafeInteger(stamp)) return null;
  return {
    index,
    stamp,
    ext: m[5] as "webm" | "mp4",
    uploaderId: m[3] ?? null,
    last: !!m[4],
  };
}

/**
 * Segments in playback order: by run (stamp), then by index within it — a
 * reload numbered from zero again, and its segments come after the first
 * run's. Anything that is not a segment is dropped.
 */
export function sortCallSegments<T extends { name: string }>(files: readonly T[]): T[] {
  return files
    .map((f) => ({ f, p: parseCallSegmentName(f.name) }))
    .filter((x): x is { f: T; p: ParsedCallSegment } => !!x.p)
    .sort((a, b) => a.p.stamp - b.p.stamp || a.p.index - b.p.index)
    .map((x) => x.f);
}
