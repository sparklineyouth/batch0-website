import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { QUESTION_FIELDS } from "./application-fields.ts";

// THE INVARIANT: batch0 collects a phone number as a REQUIRED application
// field. Under the TCPA, consent to receive marketing texts can never be a
// condition of participation, so a required field can never carry marketing
// consent — only "prior express consent" for messages directly related to the
// transaction the number was given for (application status, program
// logistics).
//
// Everything below exists so a future copy edit can't quietly widen that.
// If you are here because a test failed, the fix is almost never "update the
// assertion": it's either (a) you removed a promise we make to applicants, or
// (b) you are trying to ship marketing texts, which needs a real opt-in first
// (see docs/sms-marketing-opt-in.md).

// JSX wraps prose across source lines, so a phrase we care about is almost
// never contiguous in the file. Collapse runs of whitespace (and the JSX
// string-literal joiners that sit inside a sentence) before matching, so these
// assertions test the sentence a reader sees, not its line breaks.
function flat(src: string): string {
  return src
    .replace(/\{" "\}/g, " ")
    .replace(/\s+/g, " ");
}

const privacy = flat(
  readFileSync(new URL("../app/(legal)/privacy/page.tsx", import.meta.url), "utf8"),
);
const phoneSettings = flat(
  readFileSync(new URL("../app/dashboard/phone/page.tsx", import.meta.url), "utf8"),
);

const phoneField = QUESTION_FIELDS.find((f) => f.key === "phone");
if (!phoneField) {
  // Thrown at load so every assertion below can rely on it, and so the
  // failure names the real cause instead of eight undefined-property errors.
  throw new Error(
    "No \"phone\" field in QUESTION_FIELDS. If the field was renamed or removed, " +
      "the SMS promises in this file need re-deriving from scratch.",
  );
}

test("the phone field still exists and is still required", () => {
  assert.ok(phoneField, "the phone field disappeared from QUESTION_FIELDS");
  assert.equal(
    phoneField.required,
    true,
    "If phone became optional, the TCPA analysis changes and this whole file " +
      "should be revisited — an optional field CAN carry consent.",
  );
});

test("the application form discloses at collection that we may text", () => {
  assert.match(
    phoneField.help.toLowerCase(),
    /text/,
    "Prior express consent only covers messages the person could expect from " +
      "the context they gave the number in. The help text must say we text.",
  );
  assert.match(
    phoneField.help.toLowerCase(),
    /stop/,
    "The point-of-collection disclosure must name the opt-out keyword.",
  );
});

test("the privacy policy disclaims marketing texts", () => {
  assert.match(
    privacy,
    /do not send promotional or marketing texts/i,
    "The no-marketing promise is load-bearing: the number is collected via a " +
      "required field, so we cannot lawfully send marketing to it.",
  );
});

test("the privacy policy keeps the carrier-required no-sharing clause", () => {
  // 10DLC campaign registration is rejected without an explicit statement
  // that SMS consent data is not shared with third parties.
  for (const phrase of ["SMS opt-in", "consent information", "third party"]) {
    assert.ok(
      privacy.includes(phrase),
      `Missing "${phrase}" — 10DLC registration requires the no-sharing clause.`,
    );
  }
});

test("the privacy policy documents a working opt-out", () => {
  assert.match(privacy, /Reply STOP/i, "STOP must be documented.");
  assert.match(
    privacy,
    /10 business days/i,
    "Since 2025-04-11 a revocation must be honored within 10 business days, " +
      "by any reasonable method, with at most one confirmation message.",
  );
  assert.match(
    privacy,
    /any other reasonable way/i,
    "Revocation is not limited to replying STOP; the policy must say so.",
  );
});

test("opting out of texts never costs the student their place", () => {
  assert.match(privacy, /does not remove you from the program/i);
});

test("the dashboard phone page matches the privacy policy", () => {
  // Two places tell a student what their number is for. They must not drift:
  // the weaker of the two is the one a plaintiff quotes.
  assert.match(phoneSettings, /never send marketing texts/i);
  assert.match(phoneSettings, /STOP/);
});

test("parents can stop texts to their student's number", () => {
  assert.match(
    privacy,
    /stop calling or texting the student/i,
    "Most students are minors; a guardian must have an explicit route to " +
      "revoke on the student's behalf.",
  );
});
