/**
 * Address parsing, shared by the composer form (which counts and validates as
 * you type) and the send action (which resolves the same list server-side).
 *
 * It lives here rather than in actions.ts for two reasons: a `"use server"`
 * module can only export async functions, and — more usefully — the count on
 * the button and the addresses the server actually mails have to come out of
 * the same dedupe, or the button quietly lies about how many people are about
 * to get an email.
 *
 * No imports, so it's safe on both sides of the boundary.
 */

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Deliberately far below the blast ceiling. This is the hand-addressed path;
 * anything bigger belongs in an audience, where addresses are resolved from
 * the database rather than typed.
 */
export const MAX_DIRECT_RECIPIENTS = 50;

/** Split, trim, dedupe, and validate a free-typed recipient list. */
export function parseAddresses(raw: string): {
  valid: string[];
  invalid: string[];
} {
  const seen = new Set<string>();
  const valid: string[] = [];
  const invalid: string[] = [];
  for (const piece of (raw ?? "").split(/[,;\n]/)) {
    const t = piece.trim();
    if (!t) continue;
    // Accept "Name <addr@host>" as well as a bare address — it's what people
    // paste out of a mail client, and rejecting it would make the most
    // natural input the one that doesn't work.
    const m = /^.*<([^>]+)>$/.exec(t);
    const addr = (m ? m[1] : t).trim();
    const key = addr.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    if (EMAIL_RE.test(addr)) valid.push(addr);
    else invalid.push(t);
  }
  return { valid, invalid };
}
