/**
 * The support-ticket vocabulary and the rules about who may say what, as pure
 * functions over plain data.
 *
 * Why this file has zero imports
 * ------------------------------
 * Same reason as lib/discussions-access.ts: these predicates are the one
 * definition of the rule, and they are needed in three places that cannot
 * share a Supabase client — the server action that writes, the RSC that
 * renders, and the `"use client"` form that has to stop the user before they
 * type 9,000 characters. Keeping it dependency-free is what lets the client
 * bundle import the length caps without dragging a database driver in.
 *
 * The rule lives in THREE places and they must move together:
 *   1. the RLS policies in supabase/migrations/0090_support_tickets.sql
 *   2. these predicates
 *   3. the explicit `.eq()` filters in lib/support.ts (which runs on the
 *      service role, so RLS is its backstop and not its mechanism)
 * A change to one that isn't made in the other two is a silent privilege bug,
 * not a compile error. lib/support-access.test.ts pins this side of it.
 *
 * Not to be confused with lib/discussions-access.ts. A discussion is a
 * question from an *enrolled student* about the programme, scoped to a cohort.
 * A ticket is an administrative request about an account, a payment, or a
 * policy right — it has no cohort, it can outlive an enrolment, and a refund
 * ticket is a formal instrument under app/(legal)/refund-policy: the timestamp
 * on it is what stops the 48-hour clock.
 */

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

/**
 * Lifecycle. Mirrors the `check (status in (...))` on support_tickets.
 *
 * `waiting_on_requester` exists so the queue can distinguish "we owe this
 * person an answer" from "we asked them a question and they went quiet".
 * Without it every answered-but-unresolved ticket looks identical to an
 * unanswered one, and the queue stops being a to-do list.
 */
export const TICKET_STATUSES = [
  "open",
  "waiting_on_requester",
  "resolved",
  "closed",
] as const;

export type TicketStatus = (typeof TICKET_STATUSES)[number];

/**
 * Why the person is writing. Drives the confirmation copy, the admin filter,
 * and whether we ask for a receipt reference.
 *
 * `refund` is first because it is the only category with a deadline attached
 * to it, and the only one the legal copy names. Adding a category means
 * widening the SQL check constraint in a new migration — see 0090's header for
 * why this project uses text + check rather than a Postgres enum.
 */
export const TICKET_CATEGORIES = [
  "refund",
  "billing",
  "account",
  "privacy",
  "application",
  "other",
] as const;

export type TicketCategory = (typeof TICKET_CATEGORIES)[number];

/** Human labels, used in the form's <Select>, the admin filter, and email copy. */
export const CATEGORY_LABELS: Record<TicketCategory, string> = {
  refund: "Refund request",
  billing: "Billing or payment problem",
  account: "Account access",
  privacy: "Privacy or my data",
  application: "My application",
  other: "Something else",
};

/**
 * The one-line hint under each option. Written to set expectations before the
 * person types, because the most expensive support ticket is the one that had
 * to be bounced back for missing information.
 */
export const CATEGORY_HINTS: Record<TicketCategory, string> = {
  refund:
    "Tuition inside the 48-hour window, or a Demo Day ticket. Include your receipt or transaction ID.",
  billing:
    "A duplicate charge, an amount that doesn't match your receipt, or a card that failed.",
  account: "You can't log in, or you need an email address changed.",
  privacy: "A copy of your data, or deletion of your account and its records.",
  application: "A question about your application, its status, or your cohort.",
  other: "Anything that doesn't fit the list.",
};

export const STATUS_LABELS: Record<TicketStatus, string> = {
  open: "Open",
  waiting_on_requester: "Waiting on you",
  resolved: "Resolved",
  closed: "Closed",
};

/** What the team sees. Differs from STATUS_LABELS only for the second-person one. */
export const STAFF_STATUS_LABELS: Record<TicketStatus, string> = {
  open: "Open",
  waiting_on_requester: "Waiting on requester",
  resolved: "Resolved",
  closed: "Closed",
};

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

/**
 * These mirror `check (char_length(col) between ...)` in migration 0090
 * exactly. They are imported by the form (as `maxLength`), by the server
 * action (as validation), and asserted against the migration text in
 * lib/support-access.test.ts — three consumers so a change can't half-land.
 */
export const TICKET_SUBJECT_MAX = 160;
export const TICKET_BODY_MAX = 8000;
export const REPLY_BODY_MAX = 8000;
/** A Stripe id, a receipt URL, or whatever the person pasted. Free text on purpose. */
export const RECEIPT_REF_MAX = 200;
export const REQUESTER_NAME_MAX = 120;

/**
 * A body shorter than this is almost never a real request — it's "help" or a
 * test. We refuse it with a message asking for detail rather than opening a
 * ticket someone then has to chase.
 */
export const TICKET_BODY_MIN = 20;

// ---------------------------------------------------------------------------
// Identifiers
// ---------------------------------------------------------------------------

/**
 * Shape of the thread token. 32 random bytes as base64url — the same 43-char
 * alphabet and length as the payer capability token in lib/payer-token.ts, and
 * validated the same way: before any database round trip, so a malformed URL
 * costs nothing and a probe learns nothing.
 *
 * The token IS the authorization for the thread page. There is no second check
 * (see lib/demo-day-tickets.ts for the precedent), which is why it must never
 * appear in a page title, an analytics payload, or a Referer header.
 */
export const TICKET_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function isTicketToken(value: unknown): value is string {
  return typeof value === "string" && TICKET_TOKEN_PATTERN.test(value);
}

/**
 * The human-quotable reference, e.g. `B0-4F2A-9C7K`.
 *
 * Distinct from both the uuid and the token, and deliberately so:
 * - the uuid is an internal join key nobody should have to read aloud;
 * - the token is a secret, so it must never be quoted in an email subject, a
 *   chargeback response, or a support conversation;
 * - this is the thing the refund policy tells someone to keep. It is safe to
 *   print because knowing it grants nothing.
 *
 * Crockford-ish alphabet: no I, L, O, U, or digits 0/1, so a reference read
 * over the phone or copied off a screenshot can't be mistyped into a
 * different real ticket.
 */
export const REFERENCE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTVWXYZ";
export const TICKET_REFERENCE_PATTERN = /^B0-[2-9A-HJKMNP-TV-Z]{4}-[2-9A-HJKMNP-TV-Z]{4}$/;

export function isTicketReference(value: unknown): value is string {
  return typeof value === "string" && TICKET_REFERENCE_PATTERN.test(value);
}

/**
 * Normalises whatever the person typed into the canonical form before we look
 * it up — lowercase, missing prefix, spaces instead of hyphens. Someone
 * reading a reference off a printed receipt should not be defeated by case.
 */
export function normalizeReference(input: string): string {
  const bare = input
    .trim()
    .toUpperCase()
    .replace(/^B0[-\s]*/, "")
    .replace(/[^2-9A-HJKMNP-TV-Z]/g, "");
  if (bare.length !== 8) return "";
  return `B0-${bare.slice(0, 4)}-${bare.slice(4)}`;
}

// ---------------------------------------------------------------------------
// The arrival timestamp
// ---------------------------------------------------------------------------

/**
 * The moment a request reached us, formatted for a human, in one fixed zone.
 *
 * Eastern and spelled out, because this string is a refund requester's
 * evidence of when the 48-hour clock stopped and it has to mean the same thing
 * to them, to us, and to a card issuer reading it six weeks later. A
 * viewer-local rendering would be ambiguous in exactly the situation that
 * requires it not to be. The email and the thread page both call this, so the
 * two can never disagree.
 *
 * It lives in this module rather than next to the rest of the ticket code for
 * one reason: this module has no imports, so it is the only place a function
 * like this is reachable by a test. The first version of it combined
 * `dateStyle`/`timeStyle` with `timeZoneName`, which Intl rejects with
 * `TypeError: Invalid option` — a fault that `tsc` cannot see (every option is
 * optional), that `next build` cannot see (all three call sites are
 * force-dynamic), and that therefore broke every entry point to the feature
 * while the whole suite stayed green. Explicit component options are the only
 * way to get a zone abbreviation, and an executed assertion is the only way to
 * know it still works.
 */
export function formatReceivedAt(iso: string): string {
  const d = new Date(iso);
  // An unparseable timestamp must not take down a page whose job is to show
  // someone their support request. Better a missing line than a 500.
  if (!Number.isFinite(d.getTime())) return "";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    month: "long",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(d);
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

/** The minimum a caller has to know about a ticket to apply the rules below. */
export type TicketLike = {
  status: TicketStatus;
};

/**
 * May the requester post a follow-up?
 *
 * Open and waiting-on-them: yes, obviously. Resolved: also yes — "that didn't
 * actually fix it" is the single most important message a support system can
 * accept, and forcing it into a brand-new ticket loses the history that makes
 * it answerable. Posting on a resolved ticket reopens it (see
 * `statusAfterRequesterReply`).
 *
 * Closed is the only refusal, and it is reserved for tickets the team has
 * deliberately ended (abuse, duplicates, a thread that turned into something
 * else). A closed ticket is the only state the requester cannot reopen alone.
 */
export function canRequesterReply(t: TicketLike): boolean {
  return t.status !== "closed";
}

/**
 * May the team post? Always — including on a closed ticket, because the last
 * word on a closed thread is sometimes the explanation of why it was closed,
 * and that should still reach the person.
 */
export function canStaffReply(_t: TicketLike): boolean {
  return true;
}

/**
 * Where the ticket lands after the requester posts.
 *
 * A follow-up always puts the ball back in our court, and it revives a
 * resolved ticket rather than leaving a live question filed under "done". This
 * is the TS half of the `needs_reply` bookkeeping; the SQL half is the single
 * `update` in appendReply (lib/support.ts).
 */
export function statusAfterRequesterReply(t: TicketLike): TicketStatus {
  if (t.status === "closed") return "closed";
  return "open";
}

/**
 * Where it lands after the team posts, unless the replier picked a status
 * explicitly. Answering moves it to "waiting on them": we've said our piece,
 * and if they never come back the ticket ages out of the queue instead of
 * sitting in it forever looking unanswered.
 *
 * A reply on an already-finished ticket does NOT revive it. Adding "and here's
 * the refund id" to a resolved thread is the commonest reason to post on one,
 * and it would be perverse for that to mark our own closed work as pending
 * again. An admin who genuinely wants it reopened has the status control.
 */
export function statusAfterStaffReply(t: TicketLike): TicketStatus {
  if (t.status === "closed") return "closed";
  if (t.status === "resolved") return "resolved";
  return "waiting_on_requester";
}

/**
 * Is this ticket waiting on us? The queue is `where needs_reply`, and this is
 * the predicate that column has to agree with. Kept as a function so the
 * definition is stated once, even though it is currently one comparison.
 */
export function needsReplyFor(isStaffAuthor: boolean): boolean {
  return !isStaffAuthor;
}

/** Statuses that count as "still live" — what the default queue view shows. */
export function isOpenStatus(status: TicketStatus): boolean {
  return status === "open" || status === "waiting_on_requester";
}

/**
 * Whether the category should ask for a receipt reference. Only the two
 * money categories do; asking an account-lockout for a Stripe id is noise.
 */
export function wantsReceiptRef(category: TicketCategory): boolean {
  return category === "refund" || category === "billing";
}

/**
 * Narrows an untrusted string — a query param, a form post, a stale row — to a
 * real category. Anything unrecognised becomes `other` rather than an error:
 * a mistyped `?topic=` in a link we put in a legal page should still open a
 * usable form.
 */
export function toCategory(value: unknown): TicketCategory {
  return (TICKET_CATEGORIES as readonly string[]).includes(value as string)
    ? (value as TicketCategory)
    : "other";
}

/** Same narrowing for status, used when reading a filter out of the URL. */
export function toStatus(value: unknown): TicketStatus | null {
  return (TICKET_STATUSES as readonly string[]).includes(value as string)
    ? (value as TicketStatus)
    : null;
}
