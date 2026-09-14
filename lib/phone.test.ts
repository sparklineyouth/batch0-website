import { test } from "node:test";
import assert from "node:assert/strict";
import { isValidPhone, PHONE_MAX_LENGTH } from "./phone.ts";

// Run with `npm test`. No framework — Node strips the types natively.
//
// The point of these is the boundaries: a number one digit too short, or a
// string of punctuation with no digits, are exactly the inputs a lenient
// validator lets slip through if it only checks the character set.

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
