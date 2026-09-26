import { test } from "node:test";
import assert from "node:assert/strict";
import {
  callInsetBoxes,
  callRecordingFolder,
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
  });
  assert.deepEqual(
    parseCallSegmentName(callSegmentName(12, 1_790_000_000_001, "mp4")),
    { index: 12, stamp: 1_790_000_000_001, ext: "mp4" },
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
