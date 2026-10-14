import { test } from "node:test";
import assert from "node:assert/strict";
import {
  canMintPart,
  capRange,
  containerFor,
  contiguousParts,
  downloadName,
  formatDuration,
  isStale,
  locateRaw,
  mapRange,
  MAX_PARTS,
  parsePartName,
  parseRange,
  partName,
  rawLength,
  RANGE_CAP_BYTES,
  retryDelayMs,
  servedLength,
  STALE_AFTER_MS,
  storagePrefix,
  type Layout,
} from "./recording-parts.ts";

// Run with `npm test`.

test("containers come from the recorder's MIME type, codecs and all", () => {
  assert.equal(containerFor("video/webm;codecs=vp8,opus"), "webm");
  assert.equal(containerFor("video/webm"), "webm");
  assert.equal(containerFor("VIDEO/MP4; codecs=avc1.42E01E"), "mp4");
  assert.equal(containerFor("audio/ogg"), null);
  assert.equal(containerFor(42), null);
  assert.equal(containerFor("video/webm" + "x".repeat(200)), null);
});

test("part names are zero-padded and round-trip", () => {
  assert.equal(partName(0, "webm"), "part-000000.webm");
  assert.equal(partName(1234, "mp4"), "part-001234.mp4");
  assert.deepEqual(parsePartName("part-000042.webm"), { index: 42, container: "webm" });
  assert.equal(parsePartName("head.webm"), null);
  assert.equal(parsePartName("part-42.webm"), null);
  assert.equal(parsePartName("../part-000001.webm"), null);
  assert.equal(storagePrefix("call", "c", "s"), "call/c/s");
});

test("only the gap-free run from part 0 is playable", () => {
  const listed = [
    { name: "part-000001.webm", size: 20 },
    { name: "part-000000.webm", size: 10 },
    { name: "part-000003.webm", size: 40 }, // after a gap
    { name: "head.webm", size: 99 },
    { name: "part-000002.mp4", size: 30 }, // other container
  ];
  assert.deepEqual(contiguousParts(listed, "webm"), [10, 20]);
  assert.deepEqual(contiguousParts([{ name: "part-000000.webm", size: 0 }], "webm"), []);
  assert.deepEqual(contiguousParts([], "webm"), []);
});

test("Range headers", () => {
  assert.equal(parseRange(null, 100), null);
  assert.equal(parseRange("items=0-1", 100), null);
  assert.deepEqual(parseRange("bytes=0-", 100), { start: 0, end: 99 });
  assert.deepEqual(parseRange("bytes=10-19", 100), { start: 10, end: 19 });
  assert.deepEqual(parseRange("bytes=90-500", 100), { start: 90, end: 99 });
  assert.deepEqual(parseRange("bytes=-10", 100), { start: 90, end: 99 });
  assert.deepEqual(parseRange("bytes=-500", 100), { start: 0, end: 99 });
  assert.deepEqual(parseRange("bytes=0-1, 5-6", 100), { start: 0, end: 1 });
  assert.equal(parseRange("bytes=100-", 100), "unsatisfiable");
  assert.equal(parseRange("bytes=20-10", 100), "unsatisfiable");
  assert.equal(parseRange("bytes=-0", 100), "unsatisfiable");
  assert.equal(parseRange("bytes=0-", 0), "unsatisfiable");
  assert.equal(parseRange("bytes=-", 100), null);
});

test("a 206 is never larger than the cap", () => {
  assert.deepEqual(capRange({ start: 0, end: 10 ** 9 }), { start: 0, end: RANGE_CAP_BYTES - 1 });
  assert.deepEqual(capRange({ start: 5, end: 9 }, 100), { start: 5, end: 9 });
});

const layout: Layout = { headBytes: 50, headReplaces: 30, partSizes: [100, 200, 300] };

test("served length: the head replaces the stream's own head", () => {
  assert.equal(rawLength(layout.partSizes), 600);
  assert.equal(servedLength(layout), 50 + 600 - 30);
  assert.equal(servedLength({ ...layout, headBytes: null }), 600);
});

test("byte ranges map across the head and the parts", () => {
  // The head, then part 0 from byte 30.
  assert.deepEqual(mapRange(layout, 0, 59), [
    { source: "head", from: 0, to: 49 },
    { source: "part", index: 0, from: 30, to: 39 },
  ]);
  // Across a part boundary: served 119 = raw 99 (last byte of part 0).
  assert.deepEqual(mapRange(layout, 119, 121), [
    { source: "part", index: 0, from: 99, to: 99 },
    { source: "part", index: 1, from: 0, to: 1 },
  ]);
  // The very last byte.
  const last = servedLength(layout) - 1;
  assert.deepEqual(mapRange(layout, last, last), [{ source: "part", index: 2, from: 299, to: 299 }]);
  // No head: straight onto the parts.
  assert.deepEqual(mapRange({ ...layout, headBytes: null }, 95, 105), [
    { source: "part", index: 0, from: 95, to: 99 },
    { source: "part", index: 1, from: 0, to: 5 },
  ]);
  // Every byte of the served file is covered exactly once, in order.
  let covered = 0;
  for (const p of mapRange(layout, 0, last)) covered += p.to - p.from + 1;
  assert.equal(covered, servedLength(layout));
});

test("locateRaw finds the part holding a stream offset", () => {
  assert.deepEqual(locateRaw([100, 200], 0), { index: 0, offset: 0 });
  assert.deepEqual(locateRaw([100, 200], 100), { index: 1, offset: 0 });
  assert.deepEqual(locateRaw([100, 200], 299), { index: 1, offset: 199 });
  assert.equal(locateRaw([100, 200], 300), null);
});

test("parts are minted in order: the next one, or the last one again", () => {
  assert.equal(canMintPart(0, 0), true);
  assert.equal(canMintPart(3, 3), true);
  assert.equal(canMintPart(2, 3), true); // a retry of an earlier part
  assert.equal(canMintPart(4, 3), false); // would leave a gap
  assert.equal(canMintPart(-1, 3), false);
  assert.equal(canMintPart(1.5, 3), false);
  assert.equal(canMintPart("1", 3), false);
  assert.equal(canMintPart(MAX_PARTS, MAX_PARTS), false);
});

test("a lease goes stale after STALE_AFTER_MS without a heartbeat", () => {
  const now = Date.parse("2026-10-14T12:00:00Z");
  assert.equal(isStale(new Date(now - STALE_AFTER_MS + 1000).toISOString(), now), false);
  assert.equal(isStale(new Date(now - STALE_AFTER_MS - 1000).toISOString(), now), true);
  assert.equal(isStale("not a date", now), true);
});

test("upload retries back off and cap", () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5, 50].map(retryDelayMs), [1000, 2000, 4000, 8000, 15000, 15000, 15000]);
});

test("durations and download names", () => {
  assert.equal(formatDuration(0), "0:00");
  assert.equal(formatDuration(65_400), "1:05");
  assert.equal(formatDuration(3_723_000), "1:02:03");
  assert.equal(
    downloadName("Week 3: Pricing / GTM", "2026-10-12T20:00:00Z", "webm"),
    "Week 3 Pricing GTM 2026-10-12.webm",
  );
  assert.equal(downloadName(null, "2026-10-12T20:00:00Z", "mp4"), "Recording 2026-10-12.mp4");
});
