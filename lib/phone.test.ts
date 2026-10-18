import { test } from "node:test";
import assert from "node:assert/strict";
import {
  E164_PATTERN,
  PHONE_MAX_LENGTH,
  formatE164,
  isE164,
  isReachableByTollFree,
  isValidPhone,
  maskE164,
  normalizeToE164,
} from "./phone.ts";

// Run with `npm test`. No framework — Node strips the types natively.
//
// The point of these is the boundaries: a number one digit too short, or a
// string of punctuation with no digits, are exactly the inputs a lenient
// validator lets slip through if it only checks the character set.

// ---------------------------------------------------------------------------
// isValidPhone — the lenient predicate the application form has always used.
//
// SMS added normalizeToE164 alongside it rather than inside it. These cases are
// therefore a regression fence, not new coverage: the apply flow, its submit
// schema and /dashboard/phone all gate on isValidPhone, and tightening it to
// suit the carrier would start rejecting numbers that have been accepted for
// every cohort so far.
// ---------------------------------------------------------------------------

test("accepts numbers written the way people actually write them", () => {
  for (const v of [
    "5551234567",
    "555-123-4567",
    "(555) 123-4567",
    "+1 555 123 4567",
    "+44 20 7946 0958",
    "+91 98765 43210",
    "555.123.4567",
  ]) {
    assert.equal(isValidPhone(v), true, `expected valid: ${v}`);
  }
});

test("trims surrounding whitespace before judging", () => {
  assert.equal(isValidPhone("  555 123 4567  "), true);
});

test("rejects too few digits", () => {
  // 6 digits — one short of the shortest real number.
  assert.equal(isValidPhone("123456"), false);
});

test("rejects too many digits (past E.164's 15)", () => {
  assert.equal(isValidPhone("1234567890123456"), false);
});

test("rejects empty and whitespace-only", () => {
  assert.equal(isValidPhone(""), false);
  assert.equal(isValidPhone("   "), false);
});

test("rejects letters and stray symbols", () => {
  for (const v of ["555-CALL-NOW", "555 123 4567 x22", "call me!", "<script>"]) {
    assert.equal(isValidPhone(v), false, `expected invalid: ${v}`);
  }
});

test("rejects punctuation with no digits", () => {
  assert.equal(isValidPhone("+()-. "), false);
});

test("rejects a raw string longer than the max", () => {
  assert.equal(isValidPhone("1".repeat(PHONE_MAX_LENGTH + 1)), false);
});

test("isValidPhone still accepts numbers normalization refuses", () => {
  // The two predicates are deliberately not the same test. A reviewer should
  // still see "44207946095" in the admin UI as a number someone typed; the
  // sender must refuse to guess a country code for it. If these two ever agree,
  // one of them has drifted into doing the other's job.
  assert.equal(isValidPhone("44207946095"), true);
  assert.equal(normalizeToE164("44207946095"), null);
});

// ---------------------------------------------------------------------------
// normalizeToE164 — the dialable form
// ---------------------------------------------------------------------------

test("normalizes the two unambiguous North American shapes", () => {
  assert.equal(normalizeToE164("6095550123"), "+16095550123", "ten national digits");
  assert.equal(normalizeToE164("16095550123"), "+16095550123", "eleven starting with 1");
});

test("normalization is blind to the punctuation a human writes", () => {
  for (const v of [
    "(609) 555-0123",
    "609-555-0123",
    "609.555.0123",
    "609 555 0123",
    "  609 555 0123  ",
    "1 (609) 555-0123",
    "+1 (609) 555-0123",
    "+1-609-555-0123",
    "+16095550123",
  ]) {
    assert.equal(normalizeToE164(v), "+16095550123", `expected +16095550123 from ${v}`);
  }
});

test("an explicitly stated country code is preserved, not overwritten", () => {
  assert.equal(normalizeToE164("+44 20 7946 0958"), "+442079460958");
  assert.equal(normalizeToE164("+91 98765 43210"), "+919876543210");
  assert.equal(normalizeToE164("+12345678"), "+12345678", "the short end of the E.164 band");
  assert.equal(normalizeToE164("+123456789012345"), "+123456789012345", "the long end — 15 digits");
});

test("a bare eleven-digit number that does not start with 1 is refused, not guessed", () => {
  // The case this function exists for. "44207946095" is a real London mobile; a
  // normalizer that prefixed +1 would send the text to a stranger in Nebraska.
  // Returning null costs one "we couldn't read this number" prompt.
  assert.equal(normalizeToE164("44207946095"), null);
  assert.equal(normalizeToE164("60955501234"), null);
  assert.equal(normalizeToE164("98765432101"), null);
});

test("a '+' anywhere but the front means the number is unreadable", () => {
  assert.equal(normalizeToE164("609+5550123"), null);
  assert.equal(normalizeToE164("6095550123+"), null);
  // The check is positional — "is the first + at index 0?" — so a stray SECOND
  // plus inside an otherwise well-formed number is tolerated rather than
  // refused: the digits are unambiguous and the country code is stated. Pinned
  // so a rewrite of the check has to decide this case on purpose.
  assert.equal(normalizeToE164("+1 609+555 0123"), "+16095550123");
});

test("digit counts outside the E.164 band are refused", () => {
  assert.equal(normalizeToE164("609555012"), null, "nine digits");
  assert.equal(normalizeToE164("+1234567"), null, "seven — below the floor of 8");
  assert.equal(normalizeToE164("+1234567890123456"), null, "sixteen — above the ceiling of 15");
  assert.equal(normalizeToE164("+0123456789"), null, "no country code starts with 0");
});

test("empty, absent, over-long and non-numeric input all return null", () => {
  assert.equal(normalizeToE164(""), null);
  assert.equal(normalizeToE164("   "), null);
  assert.equal(normalizeToE164(null), null);
  assert.equal(normalizeToE164(undefined), null);
  assert.equal(normalizeToE164("1".repeat(PHONE_MAX_LENGTH + 1)), null);
  assert.equal(normalizeToE164("555-CALL-NOW"), null);
  assert.equal(normalizeToE164("555 123 4567 x22"), null);
  assert.equal(normalizeToE164("<script>"), null);
  assert.equal(normalizeToE164("+"), null);
  assert.equal(normalizeToE164("+()-. "), null);
});

test("normalization is idempotent — running it on its own output is a no-op", () => {
  // The consent ledger stores the normalized number, and the audience
  // normalizes `applications.phone` again at send time to find it. A second
  // pass must land on exactly what the first produced, or the two never meet.
  for (const raw of ["6095550123", "(609) 555-0123", "+44 20 7946 0958"]) {
    const once = normalizeToE164(raw);
    assert.ok(once);
    assert.equal(normalizeToE164(once), once, raw);
  }
});

test("everything normalization produces satisfies isE164", () => {
  // The DB check constraints on messaging_consent.phone_e164 and
  // sms_outbox.to_phone (0106) are this same pattern, so a value that escapes
  // here becomes an insert failure inside the opt-in or the queue drain.
  for (const raw of ["6095550123", "16095550123", "+44 20 7946 0958", "+12345678"]) {
    const e164 = normalizeToE164(raw);
    assert.ok(e164, raw);
    assert.equal(isE164(e164), true, e164);
    assert.equal(E164_PATTERN.test(e164), true, e164);
  }
  assert.equal(isE164("6095550123"), false, "no leading +");
  assert.equal(isE164("+0609555012"), false, "leading zero");
  assert.equal(isE164("+1 609 555 0123"), false, "spaces are not E.164");
});

// ---------------------------------------------------------------------------
// isReachableByTollFree — the check that stops a silent drop
// ---------------------------------------------------------------------------

test("toll-free reach is NANP only", () => {
  // A +44 number is accepted by the provider API and then discarded by the
  // carrier, so it bills and reports as sent. That is worse than a refusal,
  // which is why this is checked before a row is ever queued.
  assert.equal(isReachableByTollFree("+16095550123"), true);
  assert.equal(isReachableByTollFree("+14155550123"), true);
  assert.equal(isReachableByTollFree("+17875550123"), true, "Puerto Rico shares +1");
  assert.equal(isReachableByTollFree("+442079460958"), false);
  assert.equal(isReachableByTollFree("+919876543210"), false);
});

test("toll-free reach requires exactly ten subscriber digits", () => {
  assert.equal(isReachableByTollFree("+1609555012"), false, "nine");
  assert.equal(isReachableByTollFree("+160955501234"), false, "eleven");
  assert.equal(isReachableByTollFree("+1"), false);
  assert.equal(isReachableByTollFree("6095550123"), false, "not normalized at all");
});

// ---------------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------------

test("formatE164 renders NANP numbers and passes everything else through", () => {
  assert.equal(formatE164("+16095550123"), "(609) 555-0123");
  assert.equal(formatE164("+442079460958"), "+442079460958", "no invented grouping");
  assert.equal(formatE164("nonsense"), "nonsense");
});

test("maskE164 shows only the last four digits", () => {
  // Used in the opt-in confirmation and the admin outbox, where printing a
  // parent's full mobile next to their child's name is the kind of leak nobody
  // notices until a screenshot goes somewhere.
  assert.equal(maskE164("+16095550123"), "••• 0123");
  assert.equal(maskE164("+442079460958"), "••• 0958");
  assert.equal(maskE164("+12"), "•••", "too short to mask meaningfully");
  assert.ok(!maskE164("+16095550123").includes("609"), "the area code must not survive");
});
