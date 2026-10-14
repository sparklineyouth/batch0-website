import { test } from "node:test";
import assert from "node:assert/strict";
import {
  callMayHaveRecording,
  callRecordingFolder,
  parseCallSegmentName,
  sortCallSegments,
} from "./call-recording.ts";

// Run with `npm test`. Legacy segment names, as the pre-0095 recorder wrote them.

const ID = "3f2b8c1e-9a4d-4c7e-8b21-5d6f7a8b9c0d";
const HOST = "11111111-1111-4111-8111-111111111111";

test("a call's segments live under calls/<id>/recording", () => {
  assert.equal(callRecordingFolder(ID), `calls/${ID}/recording`);
});

test("segment names parse, with and without an uploader", () => {
  assert.deepEqual(parseCallSegmentName("segment-0003-1790000000000.webm"), {
    index: 3,
    stamp: 1_790_000_000_000,
    ext: "webm",
    uploaderId: null,
    last: false,
  });
  assert.deepEqual(parseCallSegmentName(`segment-0005-1790000120000-${HOST}-last.mp4`), {
    index: 5,
    stamp: 1_790_000_120_000,
    ext: "mp4",
    uploaderId: HOST,
    last: true,
  });
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
    "segment-0003-1790000000000-last.webm",
  ]) {
    assert.equal(parseCallSegmentName(bad), null, bad);
  }
});

test("segments sort by run, then by index — a reload's segment 0 goes after the first run", () => {
  const firstRun = 1_790_000_000_000;
  const reload = 1_790_000_900_000;
  const name = (i: number, stamp: number, by = "") =>
    `segment-${String(i).padStart(4, "0")}-${stamp}${by ? `-${by}` : ""}.webm`;
  const files = [
    { name: name(0, reload + 1, HOST) },
    { name: name(1, firstRun + 300_000) },
    { name: ".emptyFolderPlaceholder" },
    { name: name(0, firstRun) },
    { name: name(1, reload + 300_001, HOST) },
  ];
  assert.deepEqual(
    sortCallSegments(files).map((f) => f.name),
    [name(0, firstRun), name(1, firstRun + 300_000), name(0, reload + 1, HOST), name(1, reload + 300_001, HOST)],
  );
});

test("which past calls can have a recording", () => {
  const start = "2026-10-14T15:00:00.000Z";
  const opens = Date.parse(start) - 60 * 60_000; // the staff side's early window
  const at = (ms: number) => new Date(ms);
  const call = (status: string, updatedAt?: string) => ({ status, startsAt: start, updatedAt });
  const later = at(Date.parse(start) + 24 * 3600_000);
  // Accepted or done, and an invite nobody answered: its room opened all the same.
  for (const s of ["accepted", "completed", "invited"]) {
    assert.equal(callMayHaveRecording(call(s), later), true, s);
  }
  // Nothing before the room opens.
  assert.equal(callMayHaveRecording(call("accepted"), at(opens - 1)), false);
  assert.equal(callMayHaveRecording(call("invited"), at(opens)), true);
  // Cancelled or declined: only once the room had opened (or when unknown).
  const dated = (s: string, ms: number) => call(s, new Date(ms).toISOString());
  assert.equal(callMayHaveRecording(dated("cancelled", opens - 60_000), later), false, "cancelled days ahead");
  assert.equal(callMayHaveRecording(dated("cancelled", opens + 60_000), later), true, "cancelled mid-call");
  assert.equal(
    callMayHaveRecording(dated("cancelled", Date.parse(start) + 3 * 3600_000), later),
    true,
    "withdrawn after it expired unanswered",
  );
  assert.equal(callMayHaveRecording(dated("declined", opens + 60_000), later), true, "declined after joining");
  assert.equal(callMayHaveRecording(dated("declined", opens - 60_000), later), false);
  assert.equal(callMayHaveRecording(call("cancelled"), later), true, "no date: may have one");
  assert.equal(callMayHaveRecording(call("cancelled", "not a date"), later), true);
  assert.equal(callMayHaveRecording(call("weird"), later), false);
  assert.equal(callMayHaveRecording({ status: "accepted", startsAt: "nope" }, later), false);
});
