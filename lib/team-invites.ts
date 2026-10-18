// ---------------------------------------------------------------------------
// Inviting teammates by email: turning what someone pasted into addresses.
// Import-free, so `node --test` runs it and the Team tab can share it.
// ---------------------------------------------------------------------------

/** inviteStudent's cap, and respondToInvite's: a team is at most five people. */
export const TEAM_MAX_MEMBERS = 5;

/** Most addresses one paste can invite: everyone but the person sending it. */
export const MAX_INVITES_PER_PASTE = TEAM_MAX_MEMBERS - 1;

/** The same test inviteStudentByEmail has always applied to one address. */
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * The one answer an invite by email gives for every address that isn't a
 * student's: no account at all, a staff or investor account, or an address
 * matching more than one profile. One wording on purpose — "You can only
 * invite students." told any student which addresses belong to the batch0
 * team.
 */
export const NO_STUDENT_ACCOUNT =
  "No batch0 student account found for that email. Ask them to sign up first, then send the invite.";

/** Addresses one person may look up by email in INVITE_LOOKUP_WINDOW_SECONDS. */
export const INVITE_LOOKUP_LIMIT = 20;
export const INVITE_LOOKUP_WINDOW_SECONDS = 10 * 60;

/**
 * How to find exactly this address in profiles.email, and nobody else's.
 *
 * EMAIL accepts `%`, `_` and `*`, and to PostgREST's ilike those are
 * wildcards (`*` is its spelling of `%`). Passing an address straight to
 * ilike — what the invite lookup used to do — let `%@batch0.org` or `a_c@x.com`
 * match other people's accounts, and the per-address answers then said which
 * pattern hit a staff account, so any student could mine addresses that the
 * teammate search never shows. ILIKE with `%`, `_` and `\` escaped is a
 * case-insensitive equality; `*` has no escape in PostgREST, so an address
 * with one is matched exactly instead (addresses are already lowercased, and
 * every stored profiles.email is lowercase). The same idiom as
 * findAccountByEmail in lib/support.ts.
 */
export function exactEmailLookup(email: string): { op: "eq" | "ilike"; value: string } {
  const clean = email.trim().toLowerCase();
  if (clean.includes("*")) return { op: "eq", value: clean };
  return { op: "ilike", value: clean.replace(/[\\%_]/g, (c) => `\\${c}`) };
}

export type ParsedInvites = {
  /** Lowercased, de-duplicated, in the order they were pasted. */
  emails: string[];
  /** Things that looked like an address (they had an @) but aren't one. */
  invalid: string[];
  /** Valid addresses past MAX_INVITES_PER_PASTE, left for another paste. */
  overflow: string[];
};

/**
 * Addresses out of whatever was pasted: one per line, comma- or
 * semicolon-separated, or copied out of an email client's To line
 * ("Ada Lovelace <ada@school.edu>, bob@school.edu"). Anything without an @ —
 * a name, a stray word — is ignored rather than reported, because in a To line
 * that is the person's name, not a mistake.
 */
export function parseInviteEmails(raw: string, max: number = MAX_INVITES_PER_PASTE): ParsedInvites {
  const tokens = String(raw ?? "")
    .split(/[\s,;]+/)
    .map((t) => t.replace(/^[<("']+|[>)"'.]+$/g, "").trim().toLowerCase())
    .filter((t) => t.includes("@"));
  const seen = new Set<string>();
  const emails: string[] = [];
  const invalid: string[] = [];
  const overflow: string[] = [];
  for (const t of tokens) {
    if (seen.has(t)) continue;
    seen.add(t);
    if (!EMAIL.test(t)) invalid.push(t);
    else if (emails.length < max) emails.push(t);
    else overflow.push(t);
  }
  return { emails, invalid, overflow };
}
