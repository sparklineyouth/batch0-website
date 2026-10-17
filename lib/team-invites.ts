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
