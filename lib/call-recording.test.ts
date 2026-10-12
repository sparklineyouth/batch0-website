import { test } from "node:test";
import assert from "node:assert/strict";
import {
  callInsetBoxes,
  callRecordingFolder,
  callRecordingRegistry,
  callSegmentName,
  callTileBoxes,
  isUuid,
  isValidSegmentIndex,
  MAX_SEGMENT_INDEX,
  parseCallSegmentName,
  segmentExtension,
  sortCallSegments,
  type Box,
} from "./call-recording.ts";
import {
  RECORDER_LEASE_MS,
  recordingRival,
  recordingSegmentStart,
} from "./webinars.ts";

// Run with `npm test`.

const ID = "3f2b8c1e-9a4d-4c7e-8b21-5d6f7a8b9c0d";

test("a call's segments live under calls/<id>/recording, never at an event's root", () => {
  assert.equal(callRecordingFolder(ID), `calls/${ID}/recording`);
  // Event folders in the same bucket are bare UUIDs (`<eventId>/recording/…`),
  // so the `calls/` prefix is what keeps the two from ever colliding.
  assert.ok(!callRecordingFolder(ID).startsWith(ID));
});

test("segment names round-trip through the parser", () => {
  const name = callSegmentName(3, 1_790_000_000_000);
  assert.equal(name, "segment-0003-1790000000000.webm");
  assert.deepEqual(parseCallSegmentName(name), {
    index: 3,
    stamp: 1_790_000_000_000,
    ext: "webm",
    uploaderId: null,
    last: false,
  });
  assert.deepEqual(
    parseCallSegmentName(callSegmentName(12, 1_790_000_000_001, "mp4")),
    { index: 12, stamp: 1_790_000_000_001, ext: "mp4", uploaderId: null, last: false },
  );
});

const HOST = "11111111-1111-4111-8111-111111111111";
const COHOST = "22222222-2222-4222-8222-222222222222";

test("a segment's name carries who uploaded it, and whether it was their last", () => {
  const name = callSegmentName(4, 1_790_000_000_000, "webm", { userId: HOST });
  assert.equal(name, `segment-0004-1790000000000-${HOST}.webm`);
  assert.deepEqual(parseCallSegmentName(name), {
    index: 4,
    stamp: 1_790_000_000_000,
    ext: "webm",
    uploaderId: HOST,
    last: false,
  });
  const final = callSegmentName(5, 1_790_000_120_000, "mp4", { userId: HOST, last: true });
  assert.equal(final, `segment-0005-1790000120000-${HOST}-last.mp4`);
  assert.equal(parseCallSegmentName(final)?.last, true);
  assert.equal(parseCallSegmentName(final)?.uploaderId, HOST);
  // An id that is not a bare UUID never reaches a storage path.
  assert.equal(
    callSegmentName(1, 1_790_000_000_000, "webm", { userId: "../../x" }),
    "segment-0001-1790000000000.webm",
  );
  // Named segments still sort by stamp alongside older unnamed ones.
  assert.deepEqual(
    sortCallSegments([{ name }, { name: callSegmentName(0, 1_789_999_999_000) }]).map(
      (f) => f.name,
    ),
    [callSegmentName(0, 1_789_999_999_000), name],
  );
});

test("the parser refuses anything that is not a segment", () => {
  for (const bad of [
    "",
    ".emptyFolderPlaceholder",
    "segment-0003.webm",
    "segment-3-1790000000000.webm",
    "segment-0003-1790000000000.mov",
    "../segment-0003-1790000000000.webm",
    "segment-0003-1790000000000.webm/..",
    "SEGMENT-0003-1790000000000.webm",
    "segment-0003-1790000000000-not-a-uuid.webm",
    `segment-0003-1790000000000-${"A".repeat(8)}-1111-4111-8111-111111111111.webm`,
    "segment-0003-1790000000000-last.webm",
  ]) {
    assert.equal(parseCallSegmentName(bad), null, bad);
  }
});

test("segments sort by run, then by index — a reload's segment 0 goes after the first run", () => {
  const firstRun = 1_790_000_000_000;
  const reload = 1_790_000_900_000;
  const files = [
    { name: callSegmentName(0, reload + 1) },
    { name: callSegmentName(1, firstRun + 300_000) },
    { name: ".emptyFolderPlaceholder" },
    { name: callSegmentName(0, firstRun) },
    { name: callSegmentName(1, reload + 300_001) },
  ];
  assert.deepEqual(
    sortCallSegments(files).map((f) => f.name),
    [
      callSegmentName(0, firstRun),
      callSegmentName(1, firstRun + 300_000),
      callSegmentName(0, reload + 1),
      callSegmentName(1, reload + 300_001),
    ],
  );
});

test("the extension follows the recorder's container", () => {
  assert.equal(segmentExtension("video/webm;codecs=vp9,opus"), "webm");
  assert.equal(segmentExtension("video/mp4;codecs=avc1.42E01E,mp4a.40.2"), "mp4");
  assert.equal(segmentExtension(""), "webm");
  assert.equal(segmentExtension(null), "webm");
});

test("segment indices are bounded integers", () => {
  assert.equal(isValidSegmentIndex(0), true);
  assert.equal(isValidSegmentIndex(MAX_SEGMENT_INDEX), true);
  assert.equal(isValidSegmentIndex(MAX_SEGMENT_INDEX + 1), false);
  assert.equal(isValidSegmentIndex(-1), false);
  assert.equal(isValidSegmentIndex(1.5), false);
  assert.equal(isValidSegmentIndex("1"), false);
  assert.equal(isValidSegmentIndex(Number.NaN), false);
});

test("isUuid accepts a bare id and nothing that could escape a storage prefix", () => {
  assert.equal(isUuid(ID), true);
  assert.equal(isUuid(ID.toUpperCase()), true);
  assert.equal(isUuid(`${ID}/../other`), false);
  assert.equal(isUuid("../../x"), false);
  assert.equal(isUuid(""), false);
  assert.equal(isUuid(undefined), false);
});

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

function inside(b: Box, w: number, h: number) {
  return b.x >= 0 && b.y >= 0 && b.x + b.w <= w && b.y + b.h <= h && b.w > 0 && b.h > 0;
}

function overlaps(a: Box, b: Box) {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

test("two people split the frame into equal halves, edge to edge", () => {
  assert.deepEqual(callTileBoxes(2, 1280, 720), [
    { x: 0, y: 0, w: 640, h: 720 },
    { x: 640, y: 0, w: 640, h: 720 },
  ]);
  assert.deepEqual(callTileBoxes(1, 1280, 720), [{ x: 0, y: 0, w: 1280, h: 720 }]);
});

test("uneven splits leave no seam and no overlap", () => {
  const boxes = callTileBoxes(3, 1280, 720);
  assert.equal(boxes.reduce((s, b) => s + b.w, 0), 1280);
  for (let i = 1; i < boxes.length; i++) {
    assert.equal(boxes[i].x, boxes[i - 1].x + boxes[i - 1].w);
  }
});

test("presenting insets stay in frame, 16:9, and never overlap each other", () => {
  for (const n of [1, 2, 3, 6]) {
    const boxes = callInsetBoxes(n, 1280, 720);
    assert.equal(boxes.length, n);
    for (const b of boxes) {
      assert.ok(inside(b, 1280, 720), `n=${n} ${JSON.stringify(b)}`);
      assert.ok(Math.abs(b.w / b.h - 16 / 9) < 0.02, `n=${n} aspect`);
    }
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        assert.equal(overlaps(boxes[i], boxes[j]), false, `n=${n} ${i}/${j}`);
      }
    }
  }
});

// ---------------------------------------------------------------------------
// One recorder per call: the backstop's reading of the folder
// ---------------------------------------------------------------------------

const T0 = 1_790_000_000_000;
const SEG = 120_000;

/** What getCallRecordingUploadToken decides for `caller`'s segment. */
function rivalFor(caller: string, names: string[], now: number, seconds = SEG / 1000) {
  const { recent, stillRecording } = callRecordingRegistry(names);
  const at = new Date(now);
  return recordingRival({
    callerId: caller,
    recent,
    present: stillRecording,
    now: at,
    segmentStartMs: recordingSegmentStart(at, seconds),
  });
}

test("two staff who can't see each other: only the higher-ranked copy is kept", () => {
  // HOST (lower id) and COHOST both elected themselves — their link never
  // came up. HOST registers every two minutes; each of COHOST's segments
  // overlaps one of those registrations and is refused.
  const files = [
    callSegmentName(0, T0 + SEG, "webm", { userId: HOST }),
    callSegmentName(1, T0 + 2 * SEG, "webm", { userId: HOST }),
  ];
  assert.equal(rivalFor(COHOST, files, T0 + SEG + 30_000), HOST);
  assert.equal(rivalFor(COHOST, files, T0 + 2 * SEG + 30_000), HOST);
  // The ranking runs one way only: HOST is never refused for COHOST.
  const theirs = [callSegmentName(0, T0 + SEG + 30_000, "webm", { userId: COHOST })];
  assert.equal(rivalFor(HOST, theirs, T0 + 2 * SEG), null);
});

test("a recorder who left is no rival — their final flush does not refuse the successor", () => {
  // HOST pressed Leave mid-segment; their final segment is signed just after
  // COHOST (who saw them go) started recording. Dated by arrival it lands
  // "during" COHOST's first segment, but it is marked last: HOST stopped.
  const left = T0 + SEG + 40_000;
  const files = [
    callSegmentName(0, T0 + SEG, "webm", { userId: HOST }),
    callSegmentName(1, left + 800, "webm", { userId: HOST, last: true }),
  ];
  assert.equal(rivalFor(COHOST, files, left + SEG), null);
  // Even the segment COHOST was halfway through when HOST left — HOST's last
  // rotation is inside it, but HOST has since stopped — is kept: a few
  // seconds twice beats a minute lost.
  assert.equal(rivalFor(COHOST, files, T0 + SEG + 60_000), null);
});

test("a recorder whose laptop died stops refusing once their registrations stop", () => {
  // No goodbye, no final flush: HOST's last word is a rotation. COHOST's
  // segment containing it is refused (HOST recorded that stretch); the next
  // one is kept, so at most one segment is lost — not a whole lease.
  const files = [callSegmentName(3, T0 + 4 * SEG, "webm", { userId: HOST })];
  assert.equal(rivalFor(COHOST, files, T0 + 4 * SEG + 20_000), HOST);
  assert.equal(rivalFor(COHOST, files, T0 + 5 * SEG + 20_000), null);
  // And registrations older than the lease never count.
  assert.ok(RECORDER_LEASE_MS < 10 * SEG);
  assert.equal(rivalFor(COHOST, files, T0 + 14 * SEG, 1), null);
});

test("a recorder who stopped and came back counts again from their new run", () => {
  const files = [
    callSegmentName(0, T0 + SEG, "webm", { userId: HOST, last: true }),
    callSegmentName(0, T0 + 3 * SEG, "webm", { userId: HOST }),
  ];
  const { stillRecording } = callRecordingRegistry(files);
  assert.deepEqual([...stillRecording], [HOST]);
  assert.equal(rivalFor(COHOST, files, T0 + 3 * SEG + 10_000), HOST);
});

test("older unnamed segments say nothing about anyone", () => {
  const { recent, stillRecording } = callRecordingRegistry([
    callSegmentName(0, T0),
    ".emptyFolderPlaceholder",
  ]);
  assert.deepEqual(recent, []);
  assert.equal(stillRecording.size, 0);
});
