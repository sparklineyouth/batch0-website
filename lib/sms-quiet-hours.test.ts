import test from "node:test";
import assert from "node:assert/strict";
import {
  describeDelay,
  hourIn,
  isWithinQuietHours,
  nextAllowedSend,
  zoneForNumber,
  type QuietHours,
} from "./sms/quiet-hours.ts";

// Run with `npm test`. At the top of lib/ rather than in lib/sms/ because the
// `test` script globs `lib/*.test.ts` and the shell expands that before Node sees
// it — a file one directory down would never run.
//
// Every instant below is written as an explicit UTC string and then checked
// against the real Intl zone conversion, so the assertions stay true wherever the
// suite runs. A test that built its instants from local time would pass on the
// author's laptop and quietly stop meaning anything in CI.
//
// September 2026 is chosen on purpose: it is inside DST for both coasts, so
// Eastern is UTC-4 and Pacific is UTC-7 throughout.

const WINDOW: QuietHours = { startHour: 9, endHour: 20 };

const NJ = "+16095550123"; // 609 — New Jersey, mapped to America/New_York
const SF = "+14155550123"; // 415 — San Francisco, mapped to America/Los_Angeles
const UNMAPPED = "+15555550123"; // 555 is not a real NANP area code and is in no table
const UK = "+442079460958";

test("area codes resolve to the coast they are actually on", () => {
  assert.equal(zoneForNumber(NJ), "America/New_York");
  assert.equal(zoneForNumber(SF), "America/Los_Angeles");
});

test("an unmapped area code and a non-NANP number both admit they are unknown", () => {
  // Returning a zone here would be the bug. The table is not exhaustive and never
  // will be, so the honest answer is null and the caller tightens the window.
  assert.equal(zoneForNumber(UNMAPPED), null);
  assert.equal(zoneForNumber(UK), null, "we do not guess timezones outside the NANP");
  assert.equal(zoneForNumber("+1609555012"), null, "wrong digit count is not a NANP number");
  assert.equal(zoneForNumber("16095550123"), null, "must be E.164 — no bare digits");
});

test("hourIn reads the local hour through tzdata, including the DST offset", () => {
  const at = new Date("2026-09-15T13:00:00Z");
  assert.equal(hourIn("America/New_York", at), 9, "EDT is UTC-4 in September");
  assert.equal(hourIn("America/Los_Angeles", at), 6, "PDT is UTC-7 in September");
});

test("a 9–20 window allows 10am local and refuses 7am and 9pm", () => {
  assert.equal(isWithinQuietHours(NJ, WINDOW, new Date("2026-09-15T14:00:00Z")), true, "10:00 EDT");
  assert.equal(isWithinQuietHours(NJ, WINDOW, new Date("2026-09-15T11:00:00Z")), false, "07:00 EDT");
  // 01:00Z on the 16th is 21:00 EDT on the 15th — endHour is exclusive, so 20:00
  // is the last allowed hour and 21:00 is out.
  assert.equal(isWithinQuietHours(NJ, WINDOW, new Date("2026-09-16T01:00:00Z")), false, "21:00 EDT");
});

test("an unknown zone is refused at an instant that is only fine on the East coast", () => {
  // THE case this file exists for. 13:00Z is 09:00 Eastern — perfectly polite —
  // and 06:00 Pacific. A default-to-Eastern implementation passes this instant
  // and texts a California number at dawn. The conservative intersection has to
  // refuse it, and has to refuse it *only* because the area code is unmapped.
  const dawnOnTheWestCoast = new Date("2026-09-15T13:00:00Z");
  assert.equal(hourIn("America/Los_Angeles", dawnOnTheWestCoast), 6);
  assert.equal(isWithinQuietHours(NJ, WINDOW, dawnOnTheWestCoast), true, "known Eastern: allowed");
  assert.equal(isWithinQuietHours(SF, WINDOW, dawnOnTheWestCoast), false, "known Pacific: refused");
  assert.equal(
    isWithinQuietHours(UNMAPPED, WINDOW, dawnOnTheWestCoast),
    false,
    "unknown zone must be refused whenever ANY plausible zone is asleep",
  );

  // …and the same unknown number is allowed once both coasts are awake:
  // 17:00Z is 13:00 Eastern / 10:00 Pacific.
  const midMorningEverywhere = new Date("2026-09-15T17:00:00Z");
  assert.equal(isWithinQuietHours(UNMAPPED, WINDOW, midMorningEverywhere), true);
});

test("a non-NANP number gets the same conservative treatment as an unmapped one", () => {
  // Unreachable by our toll-free sender anyway (see isReachableByTollFree), but
  // the quiet-hours gate must not fall open just because the number is foreign.
  assert.equal(isWithinQuietHours(UK, WINDOW, new Date("2026-09-15T13:00:00Z")), false);
});

test("nextAllowedSend returns the instant unchanged when it is already polite", () => {
  // Identity matters, not just equality: a transactional send inside the window
  // must not be nudged onto the next quarter-hour and arrive 14 minutes late.
  const now = new Date("2026-09-15T14:00:00.000Z");
  assert.equal(nextAllowedSend(NJ, WINDOW, now), now);
});

test("nextAllowedSend defers to a quarter-hour-aligned instant, never drops", () => {
  // 07:07:33 EDT. The answer is 09:00 EDT the same morning, and it is aligned so
  // that repeated drains converge on the same instant instead of drifting by
  // however long the previous drain took.
  const tooEarly = new Date("2026-09-15T11:07:33.000Z");
  const when = nextAllowedSend(NJ, WINDOW, tooEarly);
  assert.ok(when, "a satisfiable window must always produce an instant");
  assert.equal(when.toISOString(), "2026-09-15T13:00:00.000Z");
  assert.equal(when.getTime() % (15 * 60 * 1000), 0, "must land on a clean quarter-hour");
  assert.ok(when.getTime() > tooEarly.getTime(), "deferred forward, never backward");
  assert.equal(isWithinQuietHours(NJ, WINDOW, when), true, "and the answer is actually inside");
});

test("an unknown zone defers further than a known Eastern one, to the same rule", () => {
  // Same 07:07 Eastern start. The Eastern number leaves at 09:00 EDT; the unknown
  // number waits until 09:00 Pacific — noon Eastern — because that is the first
  // instant both plausible zones are awake.
  const tooEarly = new Date("2026-09-15T11:07:33.000Z");
  const when = nextAllowedSend(UNMAPPED, WINDOW, tooEarly);
  assert.ok(when);
  assert.equal(when.toISOString(), "2026-09-15T16:00:00.000Z");
  assert.equal(hourIn("America/New_York", when), 12);
  assert.equal(hourIn("America/Los_Angeles", when), 9);
});

test("an unsatisfiable window returns null instead of spinning", () => {
  // startHour 20 / endHour 9 can never be true at once (h >= 20 AND h < 9), and
  // this runs inside a cron invocation. Null lets the drain park the row with a
  // readable reason; a loop that kept stepping would burn the whole invocation.
  assert.equal(nextAllowedSend(NJ, { startHour: 20, endHour: 9 }, new Date("2026-09-15T11:00:00Z")), null);
  assert.equal(nextAllowedSend(UNMAPPED, { startHour: 20, endHour: 9 }, new Date("2026-09-15T11:00:00Z")), null);
});

test("describeDelay names the recipient's own zone, and falls back to Eastern", () => {
  // The composer shows this string to an admin who is deciding whether to wait.
  // It has to be the recipient's clock, not the admin's.
  assert.match(describeDelay(SF, new Date("2026-09-15T16:00:00Z")), /9:00\s?AM.*PDT/);
  assert.match(describeDelay(NJ, new Date("2026-09-15T16:00:00Z")), /12:00\s?PM.*EDT/);
  assert.match(describeDelay(UNMAPPED, new Date("2026-09-15T16:00:00Z")), /EDT/);
});
