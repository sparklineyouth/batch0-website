/**
 * Placeholder emails for accounts created without one.
 *
 * `profiles.email` is `not null` and every profile is 1:1 with an
 * `auth.users` row, which itself requires an email. So when an admin adds a
 * person to batch0 without an email (see /admin/students/new), we mint a
 * unique, non-deliverable address rather than leaving the column empty.
 *
 * `.invalid` is a reserved TLD (RFC 6761): it can never resolve, so a
 * placeholder can never accidentally receive mail. Callers that send email
 * must still gate on `isPlaceholderEmail()` — a blocked DNS lookup is a poor
 * last line of defence — and the admin UI renders these as "—" so the fake
 * address never shows to a human.
 */

export const PLACEHOLDER_EMAIL_DOMAIN = "no-email.batch0.invalid";

/** A fresh, unique placeholder address for a person with no email. */
export function makePlaceholderEmail(): string {
  return `person-${crypto.randomUUID()}@${PLACEHOLDER_EMAIL_DOMAIN}`;
}

/** True when `email` is one of our synthesized, non-deliverable placeholders. */
export function isPlaceholderEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  return email.toLowerCase().endsWith(`@${PLACEHOLDER_EMAIL_DOMAIN}`);
}

/**
 * The email to show a human: the real address, or `null` when it's a
 * placeholder. Pair with `?? "—"` (or similar) at the call site.
 */
export function displayEmail(email: string | null | undefined): string | null {
  if (!email || isPlaceholderEmail(email)) return null;
  return email;
}
