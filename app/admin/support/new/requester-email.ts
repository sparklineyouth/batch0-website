/**
 * Whether a typed or linked address is worth looking up and sending.
 *
 * The same shape createTicket insists on (EMAIL_SHAPE in lib/support.ts),
 * restated here because that module is server-only and this rule is needed on
 * both sides: by the page, for a `?email=` it was linked with, and by the
 * form, to know when an address is complete enough to look up. In its own
 * file rather than in the form because anything a server component imports
 * from a "use client" module arrives as a client reference, not a function.
 * The server decides for real — this only saves a round trip.
 *
 * 254 characters is the longest address SMTP will carry (RFC 5321's 256-octet
 * path, less its angle brackets).
 */
export const EMAIL_MAX = 254;

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function looksLikeEmail(value: string): boolean {
  const v = value.trim();
  return v.length <= EMAIL_MAX && EMAIL_SHAPE.test(v);
}
