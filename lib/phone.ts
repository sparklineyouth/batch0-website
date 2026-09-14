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
