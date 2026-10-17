// ---------------------------------------------------------------------------
// The signup form's honeypot. Import-free, so `node --test` runs it and the
// client form shares the field name with the server action.
// ---------------------------------------------------------------------------

/**
 * The hidden field's name. Deliberately meaningless: a field called
 * "website" or "url" is one a password manager or the browser's own autofill
 * will happily fill for a real person, and then the trap catches the very
 * people it exists to let through. The form also marks it for 1Password and
 * LastPass to ignore and keeps it out of the tab order and the accessibility
 * tree.
 */
export const HONEYPOT_FIELD = "b0_hp";

/** Shown to whoever trips it — a bot, or the rare person whose autofill did. */
export const HONEYPOT_MESSAGE =
  "We couldn't create that account. Email hello@batch0.org and we'll set it up for you.";

/** A person never sees the field, so anything in it was put there by software. */
export function honeypotTripped(value: unknown): boolean {
  return typeof value === "string" && value.trim() !== "";
}
