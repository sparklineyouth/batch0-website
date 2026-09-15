// What an admin types into the "send a Demo Day ticket" form, made safe to
// store and to charge. Import-free on purpose: `npm test` runs the test file
// next to this through Node's type stripping, and the client form imports it
// to validate before the round trip.

/**
 * Stripe's floor for a USD payment. A ticket below it can't be checked out,
 * so it can't be sent either — better to refuse it in the form than to mail
 * someone a link that dies at Stripe.
 */
export const MIN_TICKET_CENTS = 50;

/** Sanity ceiling. Nobody is charging five figures for a Demo Day seat. */
export const MAX_TICKET_CENTS = 1_000_000;

export const TICKET_STATUSES = ["sent", "paid", "cancelled", "refunded"] as const;

/**
 * "$25", "25", "25.00", " 1,250.5 " -> cents. Null when it isn't a price at
 * all or falls outside the sensible range. Cents are rounded, never
 * truncated, so "0.505" doesn't quietly become 50 cents.
 */
export function parseTicketAmount(raw: string): number | null {
  const cleaned = String(raw ?? "").trim().replace(/^\$/, "").replace(/,/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  const cents = Math.round(parseFloat(cleaned) * 100);
  if (!Number.isFinite(cents)) return null;
  if (cents < MIN_TICKET_CENTS || cents > MAX_TICKET_CENTS) return null;
  return cents;
}

/**
 * The recipient address as stored. Lowercased and trimmed so the match
 * against `profiles.email` is exact, and so the same person invited twice
 * with different capitalisation is visibly the same email in the list.
 * Null when it doesn't look like an address.
 */
export function normalizeTicketEmail(raw: string): string | null {
  const email = String(raw ?? "").trim().toLowerCase();
  if (email.length < 3 || email.length > 254) return null;
  // Deliberately loose — one "@" with something on both sides and a dot in
  // the domain. Stripe and the mailer validate for real; this just stops a
  // bare name from being stored as an email.
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
  return email;
}

/** Free-text fields, trimmed and capped. Empty -> null. */
export function normalizeTicketText(raw: string | null | undefined, max: number): string | null {
  const s = String(raw ?? "").trim();
  if (!s) return null;
  return s.length > max ? s.slice(0, max) : s;
}

export const TICKET_NAME_MAX = 120;
export const TICKET_NOTE_MAX = 600;

export function formatTicketAmount(cents: number): string {
  const dollars = cents / 100;
  return Number.isInteger(dollars)
    ? `$${dollars.toLocaleString("en-US")}`
    : `$${dollars.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
