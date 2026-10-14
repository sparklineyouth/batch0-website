import { test } from "node:test";
import assert from "node:assert/strict";
import {
  deckKeyAction,
  fitRect,
  formatElapsed,
  greenRoomCta,
  joinNames,
  levelFromRms,
  looksLikePdf,
  Lru,
  nextSpeaking,
  screenShareError,
  SPEAKING_HOLD_MS,
} from "../components/live/room/logic.ts";

test("levelFromRms maps -60..-10 dBFS onto 0..1", () => {
  assert.equal(levelFromRms(0), 0);
  assert.equal(levelFromRms(-1), 0);
  assert.equal(levelFromRms(Number.NaN), 0);
  assert.equal(levelFromRms(0.001), 0); // -60 dB
  assert.ok(Math.abs(levelFromRms(0.316) - 1) < 0.01); // -10 dB
  assert.equal(levelFromRms(1), 1);
  const mid = levelFromRms(0.03); // ≈ -30 dB
  assert.ok(mid > 0.5 && mid < 0.7);
});

test("speaking turns on above the threshold and holds through short pauses", () => {
  let s = { speaking: false, lastLoudAt: 0 };
  s = nextSpeaking(s, 0.005, 0);
  assert.equal(s.speaking, false);
  s = nextSpeaking(s, 0.05, 100);
  assert.deepEqual(s, { speaking: true, lastLoudAt: 100 });
  // Between the thresholds while speaking: stays on and refreshes.
  s = nextSpeaking(s, 0.012, 200);
  assert.deepEqual(s, { speaking: true, lastLoudAt: 200 });
  // Quiet, but within the hold.
  s = nextSpeaking(s, 0.001, 200 + SPEAKING_HOLD_MS - 1);
  assert.equal(s.speaking, true);
  // Quiet past the hold.
  s = nextSpeaking(s, 0.001, 200 + SPEAKING_HOLD_MS);
  assert.equal(s.speaking, false);
  // Between the thresholds while quiet: stays off (hysteresis).
  s = nextSpeaking(s, 0.012, 2000);
  assert.equal(s.speaking, false);
});

test("formatElapsed", () => {
  assert.equal(formatElapsed(0), "0:00");
  assert.equal(formatElapsed(-5000), "0:00");
  assert.equal(formatElapsed(65_400), "1:05");
  assert.equal(formatElapsed(12 * 60_000 + 40_000), "12:40");
  assert.equal(formatElapsed(3_723_000), "1:02:03");
});

test("joinNames", () => {
  assert.equal(joinNames([]), "");
  assert.equal(joinNames(["Ana"]), "Ana");
  assert.equal(joinNames(["Ana", " "]), "Ana");
  assert.equal(joinNames(["Ana", "Ben"]), "Ana and Ben");
  assert.equal(joinNames(["Ana", "Ben", "Cy"]), "Ana, Ben and Cy");
  assert.equal(joinNames(["Ana", "Ben", "Cy", "Di", "Ed"]), "Ana, Ben and 3 others");
});

test("green room CTA per room kind and role", () => {
  assert.deepEqual(greenRoomCta({ kind: "call", broadcaster: true, hosting: ["Ana"] }), {
    label: "Join call",
    detail: null,
    cohost: false,
  });
  assert.equal(greenRoomCta({ kind: "webinar", broadcaster: false, hosting: ["Ana"] }).label, "Join");
  assert.deepEqual(greenRoomCta({ kind: "webinar", broadcaster: true, hosting: [] }), {
    label: "Start webinar",
    detail: null,
    cohost: false,
  });
  assert.equal(greenRoomCta({ kind: "webinar", broadcaster: true, hosting: null }).label, "Start webinar");
  assert.deepEqual(greenRoomCta({ kind: "webinar", broadcaster: true, hosting: ["Ana"] }), {
    label: "Join as co-host",
    detail: "Ana is hosting",
    cohost: true,
  });
  assert.equal(
    greenRoomCta({ kind: "webinar", broadcaster: true, hosting: ["Ana", "Ben"] }).detail,
    "Ana and Ben are hosting",
  );
});

test("screen share errors: cancel is silent, a macOS block explains the fix", () => {
  assert.equal(screenShareError("NotAllowedError", "Permission denied"), null);
  assert.equal(screenShareError("AbortError", ""), null);
  const mac = screenShareError("NotAllowedError", "Permission denied by system", "mac");
  assert.match(mac ?? "", /System Settings › Privacy & Security › Screen Recording/);
  assert.match(screenShareError("NotAllowedError", "Permission denied by system") ?? "", /system settings/);
  assert.match(screenShareError("NotReadableError", "") ?? "", /Couldn't capture/);
  assert.match(screenShareError("NotSupportedError", "") ?? "", /can't share/);
  assert.match(screenShareError("WeirdError", "") ?? "", /Try again/);
});

test("fitRect letterboxes into 1920×1080", () => {
  // 4:3 slide → pillarboxed.
  assert.deepEqual(fitRect(1024, 768, 1920, 1080), { x: 240, y: 0, w: 1440, h: 1080, scale: 1080 / 768 });
  // 16:9 fills.
  const f = fitRect(960, 540, 1920, 1080);
  assert.deepEqual([f.x, f.y, f.w, f.h], [0, 0, 1920, 1080]);
  // Portrait page → narrow column.
  const p = fitRect(612, 792, 1920, 1080);
  assert.equal(p.h, 1080);
  assert.ok(p.w < 1000 && p.x > 400);
  // Degenerate.
  assert.deepEqual(fitRect(0, 0, 10, 10), { x: 0, y: 0, w: 10, h: 10, scale: 1 });
});

test("deck keys: next, previous, ends, stop", () => {
  for (const k of ["ArrowRight", "ArrowDown", "PageDown", " "]) assert.equal(deckKeyAction(k, 3, 10), 4);
  for (const k of ["ArrowLeft", "ArrowUp", "PageUp"]) assert.equal(deckKeyAction(k, 3, 10), 2);
  assert.equal(deckKeyAction("ArrowRight", 10, 10), 10);
  assert.equal(deckKeyAction("ArrowLeft", 1, 10), 1);
  assert.equal(deckKeyAction("Home", 7, 10), 1);
  assert.equal(deckKeyAction("End", 2, 10), 10);
  assert.equal(deckKeyAction("Escape", 2, 10), "stop");
  assert.equal(deckKeyAction("a", 2, 10), null);
  assert.equal(deckKeyAction("ArrowRight", 1, 0), null);
  assert.equal(deckKeyAction("Escape", 1, 0), "stop");
});

test("looksLikePdf checks the signature", () => {
  const enc = (s: string) => new Uint8Array([...s].map((c) => c.charCodeAt(0)));
  assert.equal(looksLikePdf(enc("%PDF-1.7\n")), true);
  assert.equal(looksLikePdf(enc("\n\n%PDF-1.4")), true);
  assert.equal(looksLikePdf(enc("PK\u0003\u0004 pptx")), false);
  assert.equal(looksLikePdf(enc("%PD")), false);
  assert.equal(looksLikePdf(new Uint8Array()), false);
});

test("Lru evicts least recently used, honours keep, and reports evictions", () => {
  const evicted: number[] = [];
  const lru = new Lru<string>(2, (k) => evicted.push(k));
  lru.set(1, "a");
  lru.set(2, "b");
  assert.equal(lru.get(1), "a"); // 1 is now most recent
  lru.set(3, "c");
  assert.deepEqual(evicted, [2]);
  assert.equal(lru.has(2), false);
  // Keep pins 1 even though it is the oldest.
  lru.set(4, "d", [1]);
  assert.deepEqual(evicted, [2, 3]);
  assert.equal(lru.has(1), true);
  // Replacing a value evicts the old one.
  lru.set(1, "a2");
  assert.deepEqual(evicted, [2, 3, 1]);
  assert.equal(lru.size, 2);
  lru.clear();
  assert.equal(lru.size, 0);
  assert.deepEqual(evicted.slice(3).sort(), [1, 4]);
});
