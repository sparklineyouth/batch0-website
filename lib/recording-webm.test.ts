import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import {
  WebmScanner,
  buildWebmHead,
  isClusterStart,
  parseWebmHead,
  usableCues,
  type Cue,
} from "./recording-webm.ts";

// Run with `npm test`. The fixture is 5 s of a 96×54 canvas + a tone, recorded
// by Chromium's MediaRecorder (VP8/Opus, start(1000), 2 s keyframes) — the
// live-mode WebM the room's recorder produces: unknown-size Segment and
// Clusters, no Duration, no Cues. Keyframe Clusters at 187 (0 ms), 21967
// (2002 ms) and 43038 (4011 ms).
const fixture = new Uint8Array(
  await readFile(new URL("./fixtures/chrome-recording.webm", import.meta.url)),
);
const EXPECTED: Cue[] = [
  [187, 0],
  [21967, 2002],
  [43038, 4011],
];

function scanAll(bytes: Uint8Array, splits: number[]): { cues: Cue[]; s: WebmScanner } {
  const s = new WebmScanner();
  const cues: Cue[] = [];
  let at = 0;
  for (const n of [...splits, bytes.length]) {
    const end = Math.min(bytes.length, n);
    if (end > at) cues.push(...s.push(bytes.subarray(at, end)));
    at = Math.max(at, end);
  }
  return { cues, s };
}

test("the scanner finds every keyframe Cluster in a real Chrome recording", () => {
  const { cues, s } = scanAll(fixture, []);
  assert.equal(s.failed, null);
  assert.deepEqual(cues, EXPECTED);
  assert.equal(s.firstCluster, 187);
  assert.equal(s.bytes, fixture.length);
  assert.ok(s.maxTimeMs > 4800 && s.maxTimeMs < 5200, `maxTimeMs ${s.maxTimeMs}`);
});

test("chunk boundaries anywhere — even one byte at a time — change nothing", () => {
  // MediaRecorder's chunks cut through element headers and block payloads.
  const oneByOne = Array.from({ length: 400 }, (_, i) => i + 1);
  assert.deepEqual(scanAll(fixture, oneByOne).cues, EXPECTED);
  let seed = 7;
  const rand = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
  for (let round = 0; round < 25; round++) {
    const splits: number[] = [];
    let at = 0;
    while (at < fixture.length) {
      at += 1 + Math.floor(rand() * 3000);
      splits.push(at);
    }
    const { cues, s } = scanAll(fixture, splits);
    assert.equal(s.failed, null);
    assert.deepEqual(cues, EXPECTED, `round ${round}`);
  }
});

test("garbage stops the scanner instead of inventing cues", () => {
  const s = new WebmScanner();
  assert.deepEqual(s.push(new Uint8Array([0, 0, 0, 0, 1, 2, 3])), []);
  assert.ok(s.failed);
  assert.deepEqual(s.push(fixture), []);
  assert.equal(s.bytes, 7 + fixture.length);
});

// --- a hand-built stream: BlockGroups, a known-size Cluster ----------------

function vsize(n: number): number[] {
  if (n < 127) return [0x80 | n];
  return [0x40 | (n >> 8), n & 0xff];
}
function el(id: number[], body: number[]): number[] {
  return [...id, ...vsize(body.length), ...body];
}
const UNKNOWN = [0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff];

test("BlockGroups: a Block without a ReferenceBlock is a keyframe, one with is not", () => {
  const ebml = el([0x1a, 0x45, 0xdf, 0xa3], el([0x42, 0x82], [0x77, 0x65, 0x62, 0x6d]));
  const info = el([0x15, 0x49, 0xa9, 0x66], el([0x2a, 0xd7, 0xb1], [0x0f, 0x42, 0x40]));
  const tracks = el([0x16, 0x54, 0xae, 0x6b], [
    ...el([0xae], [...el([0xd7], [2]), ...el([0x83], [2])]), // audio
    ...el([0xae], [...el([0xd7], [1]), ...el([0x83], [1])]), // video
  ]);
  const block = (track: number, rel: number, flags: number) => [0x80 | track, (rel >> 8) & 0xff, rel & 0xff, flags, 9, 9, 9];
  // Cluster 1 (unknown size): tc 0; a referenced video frame first, then the key.
  const c1 = [
    0x1f, 0x43, 0xb6, 0x75, ...UNKNOWN,
    ...el([0xe7], [0]),
    ...el([0xa0], [...el([0xa1], block(1, 0, 0)), ...el([0xfb], [0x81])]),
    ...el([0xa0], [...el([0xa1], block(1, 40, 0))]),
  ];
  // Cluster 2 (known size): tc 1000; audio key, then a video SimpleBlock key.
  const c2body = [...el([0xe7], [0x03, 0xe8]), ...el([0xa3], block(2, 0, 0x80)), ...el([0xa3], block(1, 5, 0x80))];
  const c2 = el([0x1f, 0x43, 0xb6, 0x75], c2body);
  // Cluster 3: a non-key video block only.
  const c3 = [0x1f, 0x43, 0xb6, 0x75, ...UNKNOWN, ...el([0xe7], [0x07, 0xd0]), ...el([0xa3], block(1, 0, 0))];
  const segHeader = [0x18, 0x53, 0x80, 0x67, ...UNKNOWN];
  const bytes = Uint8Array.from([...ebml, ...segHeader, ...info, ...tracks, ...c1, ...c2, ...c3]);
  const c1At = ebml.length + segHeader.length + info.length + tracks.length;
  const c2At = c1At + c1.length;
  for (const splits of [[], [c1At + 3, c1At + 17, c2At + 2]]) {
    const { cues, s } = scanAll(bytes, splits);
    assert.equal(s.failed, null);
    assert.deepEqual(cues, [
      [c1At, 40],
      [c2At, 1005],
    ]);
    assert.equal(s.maxTimeMs, 2000);
  }
});

// --- the head rewrite ------------------------------------------------------

function stitched(durationMs: number, cues: readonly Cue[], raw = fixture) {
  const head = parseWebmHead(raw.subarray(0, 4096));
  assert.ok(head);
  const built = buildWebmHead({ head, durationMs, cues, rawLength: raw.length });
  const out = new Uint8Array(built.bytes.length + raw.length - built.replaces);
  out.set(built.bytes, 0);
  out.set(raw.subarray(built.replaces), built.bytes.length);
  return { out, built };
}

/** Minimal reader for assertions: top-level Segment children of a finished file. */
function readFinished(bytes: Uint8Array) {
  const vint = (p: number, keep: boolean) => {
    const b = bytes[p];
    let len = 1;
    while (len <= 8 && !(b & (0x80 >> (len - 1)))) len++;
    let v = keep ? b : b & (0xff >> len);
    for (let i = 1; i < len; i++) v = v * 256 + bytes[p + i];
    return { v, len };
  };
  const ebml = vint(4, false);
  const segAt = 4 + ebml.len + ebml.v;
  const segId = vint(segAt, true);
  const segSize = vint(segAt + segId.len, false);
  const dataStart = segAt + segId.len + segSize.len;
  const children: { id: number; at: number; body: number; size: number }[] = [];
  let p = dataStart;
  while (p < bytes.length) {
    const id = vint(p, true);
    const size = vint(p + id.len, false);
    const unknown = size.v === 2 ** (7 * size.len) - 1;
    children.push({ id: id.v, at: p, body: p + id.len + size.len, size: size.v });
    if (id.v === 0x1f43b675) break; // clusters are unknown-size from here on
    if (unknown) throw new Error("unknown size before the clusters");
    p += id.len + size.len + size.v;
  }
  return { segSize: segSize.v, dataStart, children, vint };
}

test("the rewritten head has a Duration, and Cues that land on Clusters", () => {
  const { out, built } = stitched(4977, EXPECTED);
  assert.equal(built.replaces, 187);
  assert.equal(built.cueCount, 3);
  const f = readFinished(out);
  assert.equal(f.segSize, 2 ** 56 - 1, "Segment stays unknown-size, like its Clusters");
  const ids = f.children.map((c) => c.id.toString(16));
  assert.deepEqual(ids, ["1549a966", "1654ae6b", "1c53bb6b", "1f43b675"]);

  // Duration: float64 in ms (TimecodeScale 1e6).
  const info = f.children[0];
  const infoBytes = out.subarray(info.body, info.body + info.size);
  const at = infoBytes.findIndex((b, i) => b === 0x44 && infoBytes[i + 1] === 0x89 && infoBytes[i + 2] === 0x88);
  assert.ok(at >= 0, "Duration element present");
  const dv = new DataView(infoBytes.buffer, infoBytes.byteOffset + at + 3, 8);
  assert.equal(dv.getFloat64(0), 4977);

  // Every cue: its CueClusterPosition, from the Segment's data start, is a Cluster.
  const cuesEl = f.children[2];
  let p = cuesEl.body;
  const found: Cue[] = [];
  while (p < cuesEl.body + cuesEl.size) {
    assert.equal(out[p], 0xbb);
    const body = p + 2;
    const time = Number(new DataView(out.buffer, out.byteOffset + body + 2, 8).getBigUint64(0));
    const posAt = body + 10 + 2 + 3 + 2;
    const pos = Number(new DataView(out.buffer, out.byteOffset + posAt, 8).getBigUint64(0));
    assert.ok(isClusterStart(out.subarray(f.dataStart + pos, f.dataStart + pos + 4)), `cue ${time} → cluster`);
    found.push([f.dataStart + pos, time]);
    p += 27;
  }
  // The same Clusters the scanner saw, moved by the head's growth.
  const shift = built.bytes.length - built.replaces;
  assert.deepEqual(found, EXPECTED.map(([o, t]) => [o + shift, t]));

  // And the finished file scans to the same keyframes.
  const rescan = scanAll(out, []);
  assert.equal(rescan.s.failed, null);
  assert.deepEqual(rescan.cues, found);
});

test("no usable cues: Duration only, still a valid head", () => {
  const { out, built } = stitched(4977, []);
  assert.equal(built.cueCount, 0);
  const f = readFinished(out);
  assert.deepEqual(
    f.children.map((c) => c.id.toString(16)),
    ["1549a966", "1654ae6b", "1f43b675"],
  );
});

test("an interrupted take (stream cut mid-Cluster) still gets a consistent head", () => {
  const cut = fixture.subarray(0, 30_000);
  const { out, built } = stitched(2900, EXPECTED, cut);
  assert.equal(built.cueCount, 2);
  assert.equal(scanAll(out, []).cues.length, 2);
  const head = parseWebmHead(cut);
  assert.ok(head);
  // Cues past the cut are dropped.
  assert.deepEqual(usableCues(EXPECTED, head.firstCluster, cut.length), EXPECTED.slice(0, 2));
});

test("usableCues drops cues it cannot trust", () => {
  assert.deepEqual(
    usableCues(
      [
        [500, 1000],
        [100, 0], // before the first cluster
        [500, 1200], // same cluster twice
        [400, 900],
        [700, 800], // time goes backwards
        [9999, 5000], // past the end
        [600, -1],
        ["x" as unknown as number, 1],
      ],
      187,
      2000,
    ),
    [
      [400, 900],
      [500, 1000],
    ],
  );
});

test("parseWebmHead refuses what is not a recorder's WebM", () => {
  assert.equal(parseWebmHead(new Uint8Array([1, 2, 3])), null);
  assert.equal(parseWebmHead(fixture.subarray(0, 100)), null, "head cut before the first Cluster");
  const head = parseWebmHead(fixture);
  assert.ok(head);
  assert.equal(head.firstCluster, 187);
  assert.equal(head.videoTrack, 1);
  assert.equal(head.timecodeScale, 1_000_000);
});

function hasFfprobe(): boolean {
  try {
    execFileSync("ffprobe", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

test("ffprobe reads the finished file's duration and decodes it end to end", { skip: !hasFfprobe() }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "rec-webm-"));
  try {
    const { out } = stitched(4977, EXPECTED);
    const file = join(dir, "take.webm");
    await writeFile(file, out);
    const duration = Number(
      execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file])
        .toString()
        .trim(),
    );
    assert.ok(Math.abs(duration - 4.977) < 0.01, `duration ${duration}`);
    const errors = execFileSync("ffmpeg", ["-v", "error", "-i", file, "-f", "null", "-"], {
      stdio: ["ignore", "pipe", "pipe"],
    }).toString();
    assert.equal(errors.trim(), "");
    // A seek near the end reads from the indexed Cluster rather than the top.
    const seek = execFileSync("ffprobe", [
      "-v", "error", "-read_intervals", "4.1%+0.3", "-select_streams", "v",
      "-show_entries", "frame=pts_time", "-of", "csv=p=0", file,
    ]).toString().trim().split("\n").map(Number);
    assert.ok(seek.length > 0 && seek[0] >= 3.9, `first frame after seek ${seek[0]}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
