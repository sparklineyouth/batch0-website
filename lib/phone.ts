// ---------------------------------------------------------------------------
// Phone number validation, shared by every surface that touches a phone number:
// the application form (client), its submit schema (server), and the accepted-
// student phone collection page. Keeping one predicate here is what stops the
// three from disagreeing about what a valid number is.
//
// Deliberately lenient. We store exactly what the applicant types, formatting
// and all — a reviewer wants something dialable, not something normalized into
// a shape the person no longer recognizes. So this only rejects input that
// can't be a phone number at all: it must be made of the characters a phone
// number is written with, and carry a plausible count of actual digits.
// ---------------------------------------------------------------------------

/** The longest raw string we accept — comfortably fits "+NN (NNN) NNN-NNNN". */
export const PHONE_MAX_LENGTH = 30;

// Digits plus the punctuation people write numbers with: a leading +, spaces,
// hyphens, dots, and parentheses. Nothing else.
const PHONE_ALLOWED = /^[+()\-.\s\d]+$/;

/**
 * Is `input` a plausible phone number?
 *
 * E.164 caps a real number at 15 digits; 7 is about the shortest a national
 * number gets. Anything outside that band, or carrying characters a phone
 * number is never written with, is rejected.
 */
export function isValidPhone(input: string): boolean {
  const v = input.trim();
  if (v.length === 0 || v.length > PHONE_MAX_LENGTH) return false;
  if (!PHONE_ALLOWED.test(v)) return false;
  const digits = v.replace(/\D/g, "");
  return digits.length >= 7 && digits.length <= 15;
}

// ---------------------------------------------------------------------------
// E.164 — the dialable form
//
// Everything above is about accepting what a human types. A carrier wants the
// opposite: exactly "+" then country code then subscriber number, no spaces, no
// punctuation. So normalization lives here as a SEPARATE function rather than
// being folded into isValidPhone, because the raw string is still what gets
// shown to a reviewer and what the applicant recognizes as their own number.
//
// Texting (lib/sms/) normalizes `applications.phone` with this at read time
// rather than keeping a stored copy, so this function is the one definition of
// "the number we would dial" — the consent ledger, the audience and the
// opt-in page all agree because they all call it.
// ---------------------------------------------------------------------------

/** Matches a normalized number: "+" then 8–15 digits, no leading zero. */
export const E164_PATTERN = /^\+[1-9]\d{7,14}$/;

export function isE164(input: string): boolean {
  return E164_PATTERN.test(input);
}

/**
 * Turn what someone typed into E.164, or null when it can't be done safely.
 *
 * The only country this guesses for is the US/Canada (+1), and only from the
 * two shapes that are unambiguous: ten national digits, or eleven starting
 * with a 1. Anything else without an explicit "+" is refused rather than
 * guessed — a bare eleven-digit number beginning with 4 is a valid subscriber
 * number in several countries and prefixing it with +1 would send a text to a
 * stranger. Returning null costs us one "we couldn't read this number" prompt;
 * guessing wrong costs someone else a 2am message.
 */
export function normalizeToE164(input: string | null | undefined): string | null {
  if (!input) return null;
  const v = input.trim();
  if (v.length === 0 || v.length > PHONE_MAX_LENGTH) return null;
  if (!PHONE_ALLOWED.test(v)) return null;

  // A "+" anywhere but the front means this isn't a number we can read.
  if (v.includes("+") && !v.startsWith("+")) return null;

  const digits = v.replace(/\D/g, "");

  if (v.startsWith("+")) {
    // The country code is already stated. Trust it, check the length band.
    return E164_PATTERN.test(`+${digits}`) ? `+${digits}` : null;
  }

  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return null;
}

/**
 * Is this number reachable from our sending number?
 *
 * batch0 sends from a US **toll-free** number, and toll-free A2P traffic is
 * deliverable to the North American Numbering Plan only — a message to a +44 or
 * +91 number is accepted by the API and then dropped, which is worse than a
 * refusal because it bills and reports as sent. So reachability is checked
 * before a number is ever queued, and unreachable numbers are surfaced in the
 * composer as a count rather than discovered in a delivery report.
 *
 * NANP is +1 with a 10-digit subscriber number. That covers the US, Canada, and
 * the Caribbean territories that share the country code.
 */
export function isReachableByTollFree(e164: string): boolean {
  return /^\+1\d{10}$/.test(e164);
}

/** "+15551234567" → "(555) 123-4567". Falls back to the input unchanged. */
export function formatE164(e164: string): string {
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e164);
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : e164;
}

/**
 * The last four digits, for confirming a number back to someone without
 * printing it in full — used in the opt-in confirmation and the admin outbox.
 */
export function maskE164(e164: string): string {
  const digits = e164.replace(/\D/g, "");
  return digits.length >= 4 ? `••• ${digits.slice(-4)}` : "•••";
}
