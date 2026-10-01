/**
 * The support-ticket vocabulary and the rules about who may say what, as pure
 * functions over plain data.
 *
 * Why this file has zero imports
 * ------------------------------
 * Same reason as lib/discussions-access.ts: these predicates are the one
 * definition of the rule, and they are needed in places that cannot share a
 * Supabase client — the server action that writes, the RSC that renders, the
 * `"use client"` form that has to stop the user before they type 9,000
 * characters, and the housekeeping cron. Keeping it dependency-free is what
 * lets the client bundle import the length caps without dragging a database
 * driver in, and what lets `node --test` run it with no transpile step.
 *
 * The rule lives in THREE places and they must move together:
 *   1. the CHECKs and RLS policies in supabase/migrations/0090_support_tickets.sql
 *   2. these predicates and vocabularies
 *   3. the explicit filters in lib/support.ts (which runs on the service role,
 *      so RLS is its backstop and not its mechanism)
 * A change to one that isn't made in the other two is a silent privilege bug
 * or a runtime insert failure, not a compile error. lib/support-access.test.ts
 * reads the vocabularies back out of the migration to pin this side of it.
 *
 * Not to be confused with lib/discussions-access.ts. A discussion is a
 * question from an *enrolled student* about the programme, scoped to a cohort.
 * A ticket is an administrative request about an account, a payment, a policy
 * right or a safety concern — it has no cohort, it can outlive an enrolment,
 * and a refund ticket is a formal instrument under app/(legal)/refund-policy:
 * the recorded arrival time on it is what stops the 48-hour clock.
 */

// ---------------------------------------------------------------------------
// Vocabulary — statuses
// ---------------------------------------------------------------------------

/**
 * Lifecycle. Mirrors the `check (status in (...))` on support_tickets.
 *
 * `waiting_on_requester` exists so the queue can distinguish "we owe this
 * person an answer" from "we asked them a question and they went quiet".
 * Without it every answered-but-unresolved ticket looks identical to an
 * unanswered one, and the queue stops being a to-do list. `resolved` can still
 * be reopened by the requester; `closed` is final.
 */
export const TICKET_STATUSES = [
  "open",
  "waiting_on_requester",
  "resolved",
  "closed",
] as const;

export type TicketStatus = (typeof TICKET_STATUSES)[number];

/** The requester's words. Second person where it differs from the team's. */
export const STATUS_LABELS: Record<TicketStatus, string> = {
  open: "With the team",
  waiting_on_requester: "Waiting on you",
  resolved: "Resolved",
  closed: "Closed",
};

/** What the team sees. */
export const STAFF_STATUS_LABELS: Record<TicketStatus, string> = {
  open: "Open",
  waiting_on_requester: "Waiting on requester",
  resolved: "Resolved",
  closed: "Closed",
};

/**
 * The admin queue's views, in the order someone working it wants them.
 * "Needs reply" is the work queue (`needs_reply`, which is exactly the open
 * tickets); the rest are status browses.
 */
export const STAFF_TICKET_VIEWS = [
  "needs_reply",
  "waiting_on_requester",
  "resolved",
  "closed",
  "all",
] as const;

export type StaffTicketView = (typeof STAFF_TICKET_VIEWS)[number];

export const STAFF_VIEW_LABELS: Record<StaffTicketView, string> = {
  needs_reply: "Needs reply",
  waiting_on_requester: "Waiting on requester",
  resolved: "Resolved",
  closed: "Closed",
  all: "All",
};

/** A view out of the URL; anything unknown is the work queue. */
export function toStaffTicketView(value: unknown): StaffTicketView {
  return (STAFF_TICKET_VIEWS as readonly string[]).includes(value as string)
    ? (value as StaffTicketView)
    : "needs_reply";
}

/** The queue's assignee filter: anyone, the viewer, or nobody yet. */
export type StaffAssigneeFilter = "anyone" | "mine" | "unassigned";

export function toStaffAssigneeFilter(value: unknown): StaffAssigneeFilter {
  return value === "mine" || value === "unassigned" ? value : "anyone";
}

// ---------------------------------------------------------------------------
// Vocabulary — categories
// ---------------------------------------------------------------------------

/**
 * Why the person is writing, in display order. Drives the form, the default
 * priority, the confidentiality rule, the confirmation copy and the admin
 * filter.
 *
 * Text + CHECK in the database rather than a Postgres enum — section 1c of
 * migration 0090 says why. While 0090 is unapplied, a new category is added
 * there, in place; once it has shipped, a new migration drops and re-adds
 * `support_tickets_category_check` by name with the widened list.
 */
export const TICKET_CATEGORIES = [
  "refund",
  "billing",
  "account",
  "technical",
  "application",
  "program",
  "concern",
  "accessibility",
  "privacy",
  "feedback",
  "other",
] as const;

export type TicketCategory = (typeof TICKET_CATEGORIES)[number];

/** Human labels — the form's radio cards, the admin filter, email copy. */
export const CATEGORY_LABELS: Record<TicketCategory, string> = {
  refund: "Refund request",
  billing: "Billing or payment problem",
  account: "Account & sign-in",
  technical: "Tech help",
  application: "Admissions & my application",
  program: "Course & program",
  concern: "Report a concern",
  accessibility: "Accessibility & accommodations",
  privacy: "Privacy & my data",
  feedback: "Feedback & ideas",
  other: "Something else",
};

/**
 * The one-line hint under each option. Written to set expectations before the
 * person types, because the most expensive support ticket is the one that had
 * to be bounced back for missing information — or the one filed under the
 * wrong door. The refund line says Demo Day tickets are final sale for exactly
 * that reason: the refund policy says so, and a hint that implied otherwise
 * would be a promise the policy then breaks.
 */
export const CATEGORY_HINTS: Record<TicketCategory, string> = {
  refund:
    "Tuition, within 48 hours of paying. Demo Day tickets are final sale unless batch0 cancels Demo Day.",
  billing:
    "A duplicate charge, a wrong amount, a card that failed, a fee or fine, or a scholarship that didn't apply at checkout.",
  account:
    "You can't sign in, the email on your account is wrong, or you need two accounts merged.",
  technical:
    "Something broken or not loading — lessons, video, live rooms, uploads, or the app. Screenshots help.",
  application:
    "Your application's status, deadlines, choosing a cohort, or a scholarship application.",
  program:
    "Schedule, assignments, your team, your mentor, or Demo Day logistics. Questions about lesson content get a faster answer in Discussions.",
  concern:
    "Safety, bullying or harassment, inappropriate behaviour by anyone — a student, a mentor or staff — or someone's wellbeing. Only a few senior staff can read these.",
  accessibility:
    "An accommodation you need, or something on batch0 you can't use the way it's built.",
  privacy:
    "A copy of your data, a correction, or deleting your account. There's no self-serve deletion — the team does it for you.",
  feedback: "An idea, a suggestion, or something you think we should know.",
  other: "Anything that doesn't fit the list.",
};

/** The picker's sections, in order. Every category appears exactly once. */
export const CATEGORY_GROUPS: readonly {
  label: string;
  categories: readonly TicketCategory[];
}[] = [
  { label: "Money", categories: ["refund", "billing"] },
  { label: "Account & tech", categories: ["account", "technical"] },
  { label: "Program", categories: ["application", "program"] },
  { label: "Safety & rights", categories: ["concern", "accessibility", "privacy"] },
  { label: "Everything else", categories: ["feedback", "other"] },
];

// ---------------------------------------------------------------------------
// Vocabulary — priority
// ---------------------------------------------------------------------------

/** Most urgent first, which is the order a select should offer them in. */
export const TICKET_PRIORITIES = ["urgent", "high", "normal", "low"] as const;

export type TicketPriority = (typeof TICKET_PRIORITIES)[number];

export const PRIORITY_LABELS: Record<TicketPriority, string> = {
  urgent: "Urgent",
  high: "High",
  normal: "Normal",
  low: "Low",
};

/** For sorting: higher is more urgent. */
export const PRIORITY_RANK: Record<TicketPriority, number> = {
  urgent: 3,
  high: 2,
  normal: 1,
  low: 0,
};

/**
 * What a new ticket in each category starts at. A concern is urgent because
 * someone's safety may be at stake; a refund is high because it carries the
 * only legal deadline in the system; feedback can wait. Staff can change any
 * of them afterwards.
 */
export const CATEGORY_DEFAULT_PRIORITY: Record<TicketCategory, TicketPriority> = {
  refund: "high",
  billing: "normal",
  account: "normal",
  technical: "normal",
  application: "normal",
  program: "normal",
  concern: "urgent",
  accessibility: "normal",
  privacy: "normal",
  feedback: "low",
  other: "normal",
};

export function defaultPriorityFor(category: TicketCategory): TicketPriority {
  return CATEGORY_DEFAULT_PRIORITY[category];
}

// ---------------------------------------------------------------------------
// Vocabulary — confidentiality
// ---------------------------------------------------------------------------

/**
 * Categories whose tickets are confidential from the moment they are filed:
 * only holders of `support.sensitive` (and `*`) can see or handle them, and
 * every bell and team email about them is stripped of content. A report of
 * harassment by a staff member must not land in a queue that staff member can
 * read.
 */
export const SENSITIVE_CATEGORIES: readonly TicketCategory[] = ["concern"];

export function isSensitiveCategory(category: TicketCategory): boolean {
  return SENSITIVE_CATEGORIES.includes(category);
}

// ---------------------------------------------------------------------------
// Vocabulary — channel, outcome, reply credential
// ---------------------------------------------------------------------------

/** How the request reached us. Mirrors support_tickets_channel_check. */
export const TICKET_CHANNELS = ["web", "app", "email", "phone", "other"] as const;

export type TicketChannel = (typeof TICKET_CHANNELS)[number];

export const CHANNEL_LABELS: Record<TicketChannel, string> = {
  web: "Web form",
  app: "App",
  email: "Email",
  phone: "Phone",
  other: "Other",
};

/** The channels staff can log a request from (/admin/support/new). */
export const STAFF_LOG_CHANNELS = ["email", "phone", "other"] as const;

export type StaffLogChannel = (typeof STAFF_LOG_CHANNELS)[number];

/** Where a self-filed request was submitted: the website or the installed app. */
export type SupportSurface = "web" | "app";

/** Narrows the form's hidden `surface` field. Anything else is the website. */
export function toSurface(value: unknown): SupportSurface {
  return value === "app" ? "app" : "web";
}

/** How a ticket ended. Optional, set on resolve or close, cleared on reopen. */
export const TICKET_OUTCOMES = [
  "answered",
  "fixed",
  "refunded",
  "partially_refunded",
  "declined",
  "duplicate",
  "no_response",
  "other",
] as const;

export type TicketOutcome = (typeof TICKET_OUTCOMES)[number];

export const OUTCOME_LABELS: Record<TicketOutcome, string> = {
  answered: "Answered",
  fixed: "Fixed",
  refunded: "Refunded",
  partially_refunded: "Partially refunded",
  declined: "Declined",
  duplicate: "Duplicate",
  no_response: "No response",
  other: "Other",
};

/**
 * Which credential posted a reply. Mirrors support_ticket_replies_via_check:
 * the requester's session, the emailed token link, a support.manage holder,
 * or an automated message ("system", rendered as from batch0).
 */
export const REPLY_VIAS = ["session", "token", "staff", "system"] as const;

export type ReplyVia = (typeof REPLY_VIAS)[number];

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

/**
 * These mirror `check (char_length(col) between ...)` in migration 0090
 * exactly. They are imported by the forms (as `maxLength`), by the server
 * actions (as validation), and asserted against the migration text in
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

/** How long a subject derived from the body may be (see deriveSubject). */
export const DERIVED_SUBJECT_MAX = 80;

/** support_tickets_context_check: the stored context's size cap, in bytes. */
export const CONTEXT_MAX_BYTES = 4096;

/**
 * Length as Postgres counts it. `char_length` counts characters (code points)
 * and JS `.length` counts UTF-16 units, so ten emoji are 20 to JS and 10 to
 * the database — a body that passed a `.length >= 20` check would then fail
 * the CHECK with a raw Postgres error. Validate with this instead.
 */
export function codePointLength(value: string): number {
  let n = 0;
  for (const _ of value) n++;
  return n;
}

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
 * appear in a page title, an analytics payload, a notification, or a Referer
 * header.
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
 * - this is the thing the refund policy tells someone to keep, and the key of
 *   the requester's own thread URL (/dashboard/support/<reference>). It is
 *   safe to print because knowing it grants nothing — the owner's session is
 *   what authorizes that page.
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
 * Returns "" when the input can't be a reference.
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

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A uuid-shaped string — checked before an id from a form or URL reaches a query. */
export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

// ---------------------------------------------------------------------------
// The arrival timestamp
// ---------------------------------------------------------------------------

const NEW_YORK = "America/New_York";

/**
 * The moment a request reached us, formatted for a human, in one fixed zone.
 *
 * Eastern and spelled out, because this string is a refund requester's
 * evidence of when the 48-hour clock stopped and it has to mean the same thing
 * to them, to us, and to a card issuer reading it six weeks later. A
 * viewer-local rendering would be ambiguous in exactly the situation that
 * requires it not to be. The emails, the thread pages and the admin all call
 * this on `received_at`, so none of them can disagree.
 *
 * It lives in this module rather than next to the rest of the ticket code for
 * one reason: this module has no imports, so it is the only place a function
 * like this is reachable by a test. The first version of it combined
 * `dateStyle`/`timeStyle` with `timeZoneName`, which Intl rejects with
 * `TypeError: Invalid option` — a fault that `tsc` cannot see (every option is
 * optional), that `next build` cannot see (every call site is force-dynamic),
 * and that therefore broke every entry point to the feature while the whole
 * suite stayed green. Explicit component options are the only way to get a
 * zone abbreviation, and an executed assertion is the only way to know it
 * still works.
 */
export function formatReceivedAt(iso: string): string {
  const d = new Date(iso);
  // An unparseable timestamp must not take down a page whose job is to show
  // someone their support request. Better a missing line than a 500.
  if (!Number.isFinite(d.getTime())) return "";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: NEW_YORK,
    month: "long",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(d);
}

const nyWallClock = new Intl.DateTimeFormat("en-US", {
  timeZone: NEW_YORK,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

function nyParts(ms: number): Record<string, string> {
  return Object.fromEntries(
    nyWallClock.formatToParts(new Date(ms)).map((p) => [p.type, p.value]),
  );
}

/**
 * A `datetime-local` value ("2026-10-01T09:30") read as New York wall-clock
 * time, as an ISO instant — or null when it isn't a real date and time.
 *
 * Staff logging an email that arrived "at 9:30 this morning" mean 9:30 in the
 * zone batch0 runs on, whatever zone their laptop is in, and that instant
 * becomes the request's refund clock. Resolved against the offset at that
 * instant, iteratively, so it stays right on both sides of a daylight-saving
 * change (the easternEndOfDay idiom in lib/cohort-eligibility.ts). A wall time
 * that doesn't exist (the skipped hour in March) lands an hour off rather than
 * failing; one that happens twice (November) resolves to one of its two
 * instants.
 */
export function easternLocalToIso(local: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(local.trim());
  if (!m) return null;
  const [y, mo, d, h, mi, s] = [m[1], m[2], m[3], m[4], m[5], m[6] ?? "0"].map(Number);
  const target = Date.UTC(y, mo - 1, d, h, mi, s);
  const check = new Date(target);
  // Date.UTC rolls 2026-02-31 over to March 3rd; a typed date must not move.
  if (
    !Number.isFinite(target) ||
    check.getUTCFullYear() !== y ||
    check.getUTCMonth() !== mo - 1 ||
    check.getUTCDate() !== d ||
    check.getUTCHours() !== h ||
    check.getUTCMinutes() !== mi
  ) {
    return null;
  }
  let instant = target;
  for (let i = 0; i < 4; i++) {
    const p = nyParts(instant);
    const wall = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
    const correction = target - wall;
    if (correction === 0) break;
    instant += correction;
  }
  return new Date(instant).toISOString();
}

/** An instant as a New York `datetime-local` value — a form's default. */
export function toEasternLocalInput(value: string | number | Date): string {
  const ms = value instanceof Date ? value.getTime() : new Date(value).getTime();
  if (!Number.isFinite(ms)) return "";
  const p = nyParts(ms);
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}

/** How far back staff may date a request they log on someone's behalf. */
export const STAFF_LOG_MAX_AGE_DAYS = 90;

/**
 * Why a staff-entered arrival time is unacceptable, or null when it's fine.
 * Not in the future (a minute of slack for a clock that runs fast), and not
 * older than STAFF_LOG_MAX_AGE_DAYS — past that, the record is history rather
 * than a request, and the refund window it could affect is long gone.
 */
export function checkStaffReceivedAt(iso: string | null, now: number = Date.now()): string | null {
  const ms = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(ms)) return "Enter the date and time the request arrived.";
  if (ms > now + 60_000) return "That time is in the future. Enter when the request actually arrived.";
  if (ms < now - STAFF_LOG_MAX_AGE_DAYS * 86_400_000) {
    return `That's more than ${STAFF_LOG_MAX_AGE_DAYS} days ago. Requests older than that can't be logged here.`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// The status machine
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
 * Closed is the only refusal: it is final, and a requester with something new
 * to say opens a new request. The housekeeping cron closes a resolved ticket
 * after 14 quiet days, and the team closes duplicates and abuse.
 */
export function canRequesterReply(t: TicketLike): boolean {
  return t.status !== "closed";
}

/**
 * May the requester mark their own ticket solved ("This is solved")? Only
 * while it is live — there is nothing to solve on a resolved or closed one.
 */
export function canRequesterMarkSolved(t: TicketLike): boolean {
  return t.status === "open" || t.status === "waiting_on_requester";
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
 * Where the ticket lands after the requester posts, by session or by token.
 *
 * A follow-up always puts the ball back in our court, and it revives a
 * resolved ticket rather than leaving a live question filed under "done".
 */
export function statusAfterRequesterReply(t: TicketLike): TicketStatus {
  if (t.status === "closed") return "closed";
  return "open";
}

/**
 * Where it lands after the team posts a PUBLIC reply. An internal note never
 * moves the status at all.
 *
 * By default answering moves it to "waiting on them": we've said our piece,
 * and if they never come back the ticket ages out (the cron resolves it after
 * 7 days) instead of sitting in the queue forever looking unanswered. The
 * replier can ask for a different status instead — "Send & resolve" asks for
 * `resolved`, and keeping it `open` means we still owe something.
 *
 * A reply never changes a closed ticket (use the status control), and a plain
 * reply on an already-resolved ticket does NOT revive it: adding "and here's
 * the refund id" to a finished thread is the commonest reason to post on one,
 * and it would be perverse for that to mark our own finished work as pending.
 */
export function statusAfterStaffReply(
  t: TicketLike,
  requested?: TicketStatus | null,
): TicketStatus {
  if (t.status === "closed") return "closed";
  if (requested && requested !== "closed") return requested;
  if (t.status === "resolved") return "resolved";
  return "waiting_on_requester";
}

/**
 * The queue flag for a status: the team owes a reply exactly when the ticket
 * is open. Stated once, because `needs_reply` is stored (the queue is a
 * partial index on it) and must never disagree with `status`.
 */
export function needsReplyForStatus(status: TicketStatus): boolean {
  return status === "open";
}

/** Statuses that count as "still live". */
export function isOpenStatus(status: TicketStatus): boolean {
  return status === "open" || status === "waiting_on_requester";
}

/**
 * The columns a status change writes, as a snake_case patch — the ONE place
 * the bookkeeping that rides along with a status is decided, used by
 * lib/support.ts and by the housekeeping cron alike. Call it only for a real
 * change (`from !== to`).
 *
 *   needs_reply        follows the status (needsReplyForStatus)
 *   status_changed_at  now — the cron's clock
 *   resolved_at        stamped on entering `resolved`; cleared on reopening
 *                      (→ open / waiting); kept when a resolved ticket closes,
 *                      because "resolved on the 3rd, closed on the 17th" is
 *                      history worth keeping
 *   outcome            set when given on resolve/close, kept otherwise;
 *                      cleared on reopening, since it described an ending
 *                      that didn't stick
 */
export type TicketStatusFields = {
  status: TicketStatus;
  needs_reply: boolean;
  status_changed_at: string;
  resolved_at?: string | null;
  outcome?: TicketOutcome | null;
};

export function statusChangeFields(
  from: TicketStatus,
  to: TicketStatus,
  nowIso: string,
  outcome?: TicketOutcome | null,
): TicketStatusFields {
  const fields: TicketStatusFields = {
    status: to,
    needs_reply: needsReplyForStatus(to),
    status_changed_at: nowIso,
  };
  if (to === "resolved" && from !== "resolved") fields.resolved_at = nowIso;
  if (to === "open" || to === "waiting_on_requester") {
    fields.resolved_at = null;
    fields.outcome = null;
  } else if (outcome !== undefined) {
    fields.outcome = outcome;
  }
  return fields;
}

/**
 * Whether the category asks for a receipt reference and offers the "which
 * payment?" picker. Only the two money categories do; asking an account
 * lockout for a Stripe id is noise.
 */
export function wantsReceiptRef(category: TicketCategory): boolean {
  return category === "refund" || category === "billing";
}

/**
 * Narrows an untrusted string — a query param, a stale row — to a real
 * category. Anything unrecognised becomes `other` rather than an error: a
 * mistyped `?topic=` in a link we put in a legal page should still open a
 * usable form. NOT for a form post — see parseCategory.
 */
export function toCategory(value: unknown): TicketCategory {
  return parseCategory(value) ?? "other";
}

/**
 * The strict version, for a submitted form: an unknown or missing category is
 * null, so the action can ask the person to choose rather than silently
 * filing a refund under "Something else".
 */
export function parseCategory(value: unknown): TicketCategory | null {
  return (TICKET_CATEGORIES as readonly string[]).includes(value as string)
    ? (value as TicketCategory)
    : null;
}

/** Same narrowing for status, used when reading a filter out of the URL. */
export function toStatus(value: unknown): TicketStatus | null {
  return (TICKET_STATUSES as readonly string[]).includes(value as string)
    ? (value as TicketStatus)
    : null;
}

export function toPriority(value: unknown): TicketPriority | null {
  return (TICKET_PRIORITIES as readonly string[]).includes(value as string)
    ? (value as TicketPriority)
    : null;
}

export function toChannel(value: unknown): TicketChannel | null {
  return (TICKET_CHANNELS as readonly string[]).includes(value as string)
    ? (value as TicketChannel)
    : null;
}

export function toStaffLogChannel(value: unknown): StaffLogChannel | null {
  return (STAFF_LOG_CHANNELS as readonly string[]).includes(value as string)
    ? (value as StaffLogChannel)
    : null;
}

export function toOutcome(value: unknown): TicketOutcome | null {
  return (TICKET_OUTCOMES as readonly string[]).includes(value as string)
    ? (value as TicketOutcome)
    : null;
}

// ---------------------------------------------------------------------------
// Who on the team may see what
// ---------------------------------------------------------------------------

/**
 * What one staff member may do with support tickets, resolved once per
 * request (lib/support.ts getSupportScope / assertSupportScope) and passed to
 * every staff read and write, which apply it as explicit filters.
 *
 * Mirrors the RLS in 0090: reading needs support.view OR support.manage;
 * writing needs support.manage; a sensitive ticket additionally needs
 * support.sensitive. `*` holds all three.
 */
export type SupportStaffScope = {
  userId: string;
  /** support.view or support.manage (or '*'): may read the queue and tickets. */
  canView: boolean;
  /** support.manage (or '*'): may reply, change, assign, link and log. */
  canManage: boolean;
  /** support.sensitive (or '*') AND canView: may see confidential concerns. */
  canSeeSensitive: boolean;
};

/**
 * The scope for a viewer, from their resolved capabilities. Takes the
 * structural shape of lib/permissions.ts `Capabilities` rather than importing
 * it, so this file stays import-free.
 */
export function supportScopeFor(
  userId: string,
  caps: { permissions: readonly string[]; superAdmin: boolean } | null,
): SupportStaffScope {
  const has = (p: string) => !!caps && (caps.superAdmin || caps.permissions.includes(p));
  const canManage = has("support.manage");
  const canView = canManage || has("support.view");
  return {
    userId,
    canView,
    canManage,
    // Only meaningful with read access: support.sensitive on its own opens
    // nothing, exactly as in the policies.
    canSeeSensitive: canView && has("support.sensitive"),
  };
}

/** May this staff scope see this ticket at all? */
export function canStaffSeeTicket(
  scope: SupportStaffScope,
  ticket: { sensitive: boolean },
): boolean {
  return scope.canView && (!ticket.sensitive || scope.canSeeSensitive);
}

/** May this staff scope change it — reply, set status, assign, link? */
export function canStaffManageTicket(
  scope: SupportStaffScope,
  ticket: { sensitive: boolean },
): boolean {
  return scope.canManage && canStaffSeeTicket(scope, ticket);
}

// ---------------------------------------------------------------------------
// Reply targets (SLA)
// ---------------------------------------------------------------------------

/**
 * How long the team has to reply, from the requester's last message, by
 * priority. Internal targets — never shown to a requester as a promise.
 */
export const SLA_TARGET_HOURS: Record<TicketPriority, number> = {
  urgent: 4,
  high: 24,
  normal: 48,
  low: 72,
};

/** "Due soon" once this much of the target has elapsed. */
export const SLA_DUE_SOON_FRACTION = 0.75;

export type SlaState = "ok" | "due_soon" | "overdue";

/** The fields the reply target is computed from. */
export type SlaTicket = {
  needsReply: boolean;
  priority: TicketPriority;
  requesterActivityAt: string;
};

/** When a reply is due, or null when nobody owes one. */
export function slaDueAt(t: SlaTicket): string | null {
  if (!t.needsReply) return null;
  const from = Date.parse(t.requesterActivityAt);
  if (!Number.isFinite(from)) return null;
  return new Date(from + SLA_TARGET_HOURS[t.priority] * 3_600_000).toISOString();
}

/**
 * Where a ticket stands against its reply target. A ticket nobody owes a
 * reply on is always 'ok'. Overdue means strictly past the due instant.
 */
export function slaState(t: SlaTicket, now: Date | number = Date.now()): SlaState {
  const due = slaDueAt(t);
  if (!due) return "ok";
  const nowMs = typeof now === "number" ? now : now.getTime();
  const dueMs = Date.parse(due);
  if (nowMs > dueMs) return "overdue";
  const target = SLA_TARGET_HOURS[t.priority] * 3_600_000;
  if (nowMs >= dueMs - target * (1 - SLA_DUE_SOON_FRACTION)) return "due_soon";
  return "ok";
}

// ---------------------------------------------------------------------------
// The refund window
// ---------------------------------------------------------------------------

/** The refund policy's window: 48 consecutive hours from payment. */
export const REFUND_WINDOW_HOURS = 48;

export type RefundWindowState = "inside" | "outside" | "before_payment" | "unknown";

export type RefundWindow = {
  state: RefundWindowState;
  /** received − paid, in milliseconds; null when either time is unusable. */
  elapsedMs: number | null;
  /** A sentence for the admin: "Received 3h 12m after payment — inside the 48-hour window." */
  label: string;
};

/** "45m", "3h 12m", "4d 2h" — compact elapsed time for staff surfaces. */
export function formatElapsed(ms: number): string {
  const minutes = Math.floor(Math.abs(ms) / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 72) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

/**
 * Was this refund request inside the window? Measured from the payment's
 * `paid_at` to the ticket's `received_at` — consecutive wall-clock hours, so
 * exactly 48:00:00 is inside and 48:00:01 is not.
 *
 * A request received before the payment it is linked to (a mis-linked charge,
 * or someone asking ahead of paying) is 'before_payment' rather than "inside"
 * with a negative number. A payment with no recorded paid time is 'unknown':
 * guessing from `created_at` — the checkout session's start — would lengthen
 * the apparent wait and could turn a valid request into a refusal.
 */
export function refundWindow(
  receivedAtIso: string | null | undefined,
  paidAtIso: string | null | undefined,
): RefundWindow {
  const received = receivedAtIso ? Date.parse(receivedAtIso) : NaN;
  const paid = paidAtIso ? Date.parse(paidAtIso) : NaN;
  if (!Number.isFinite(paid)) {
    return {
      state: "unknown",
      elapsedMs: null,
      label: "There's no recorded payment time for this charge, so the window can't be checked here.",
    };
  }
  if (!Number.isFinite(received)) {
    return { state: "unknown", elapsedMs: null, label: "The request has no usable received time." };
  }
  const elapsedMs = received - paid;
  if (elapsedMs < 0) {
    return {
      state: "before_payment",
      elapsedMs,
      label: `Received ${formatElapsed(elapsedMs)} before this payment was made.`,
    };
  }
  const inside = elapsedMs <= REFUND_WINDOW_HOURS * 3_600_000;
  return {
    state: inside ? "inside" : "outside",
    elapsedMs,
    label: `Received ${formatElapsed(elapsedMs)} after payment — ${
      inside ? "inside" : "outside"
    } the ${REFUND_WINDOW_HOURS}-hour window.`,
  };
}

// ---------------------------------------------------------------------------
// Filing context
// ---------------------------------------------------------------------------

/**
 * Technical and prefill context stored on a ticket (support_tickets.context).
 * Every key is whitelisted and shape-checked; nothing a client sends is stored
 * as-is. `chargeId` / `demoDayTicketId` are never read from the client at all:
 * lib/support.ts sets them after verifying the person owns that charge.
 */
export type SupportContext = {
  /** The page they came from — a pathname, never a query string or a secret URL. */
  page?: string;
  /** Which entry point sent them, e.g. "billing", "error_screen". */
  source?: string;
  /** A Next.js error digest from the error screen they reported. */
  digest?: string;
  userAgent?: string;
  surface?: SupportSurface;
  /** A fee or fine (user_charges) this is about, ownership-verified. */
  chargeId?: string;
  /** A Demo Day ticket (demo_day_tickets) this is about, ownership-verified. */
  demoDayTicketId?: string;
};

export const CONTEXT_PAGE_MAX = 300;
export const CONTEXT_USER_AGENT_MAX = 300;

/**
 * Paths where the URL itself is the credential — a mirror of
 * `isSecretUrlPath` in lib/payment-privacy.ts, kept here because this module
 * must stay import-free. lib/support-access.test.ts asserts the two agree, so
 * a secret path added there and forgotten here fails a test.
 */
export function isSecretPath(path: string | null | undefined): boolean {
  return !!path?.startsWith("/support/t/") || !!path?.startsWith("/demo-day/ticket/");
}

/**
 * The page a request was filed from, cleaned to something safe to store and
 * render as a link: a same-site pathname only. The query and hash are cut
 * (they are where tokens and session ids travel), protocol-relative and
 * backslash forms are refused (`//evil.example` and `/\evil.example` are
 * other sites to a browser), and a secret URL is dropped entirely rather than
 * trimmed — its path IS the secret.
 */
export function sanitizeContextPage(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const path = raw.trim().split(/[?#]/, 1)[0];
  if (!/^\/(?![/\\])[\x21-\x7e]*$/.test(path)) return null;
  if (path.includes("\\")) return null;
  if (path.length > CONTEXT_PAGE_MAX) return null;
  if (isSecretPath(path)) return null;
  return path;
}

function cleanSource(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const v = raw.trim().toLowerCase();
  return /^[a-z_-]{1,40}$/.test(v) ? v : undefined;
}

function cleanDigest(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const v = raw.trim();
  return /^[A-Za-z0-9_-]{1,64}$/.test(v) ? v : undefined;
}

function cleanUserAgent(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const v = raw.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  if (!v) return undefined;
  return Array.from(v).slice(0, CONTEXT_USER_AGENT_MAX).join("");
}

/**
 * Builds a ticket's context from what the form and the request carried —
 * `page`, `source` and `digest` from the form's hidden fields, `userAgent`
 * from the request header, `surface` from the form — keeping only what passes
 * each key's rule and dropping the rest silently. Context is a convenience for
 * the team, never a reason to refuse a request.
 */
export function sanitizeContext(input: {
  page?: unknown;
  source?: unknown;
  digest?: unknown;
  userAgent?: unknown;
  surface?: unknown;
}): SupportContext {
  const out: SupportContext = {};
  const page = sanitizeContextPage(input.page);
  if (page) out.page = page;
  const source = cleanSource(input.source);
  if (source) out.source = source;
  const digest = cleanDigest(input.digest);
  if (digest) out.digest = digest;
  const userAgent = cleanUserAgent(input.userAgent);
  if (userAgent) out.userAgent = userAgent;
  if (input.surface === "web" || input.surface === "app") out.surface = input.surface;
  return out;
}

/**
 * Reads a stored context back, applying the same rules — the column is jsonb
 * and a row written by anything else must not reach a page unchecked.
 */
export function readStoredContext(stored: unknown): SupportContext {
  if (!stored || typeof stored !== "object" || Array.isArray(stored)) return {};
  const s = stored as Record<string, unknown>;
  const out = sanitizeContext(s);
  if (isUuid(s.chargeId)) out.chargeId = s.chargeId;
  if (isUuid(s.demoDayTicketId)) out.demoDayTicketId = s.demoDayTicketId;
  return out;
}

// ---------------------------------------------------------------------------
// Subject
// ---------------------------------------------------------------------------

function collapse(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function clampCodePoints(s: string, max: number): string {
  const chars = Array.from(s);
  if (chars.length <= max) return s;
  // Cut at a word boundary when there is one in the back half, so "Refund for
  // tuition I paid on Septem…" reads as "Refund for tuition I paid on…".
  const cut = chars.slice(0, max - 1).join("");
  const space = cut.lastIndexOf(" ");
  const head = space >= Math.floor(max / 2) ? cut.slice(0, space) : cut;
  return `${head.trimEnd()}…`;
}

/**
 * The subject a ticket is filed under. The form's subject is optional: when
 * the person leaves it blank, the first line of what they wrote becomes the
 * subject (up to DERIVED_SUBJECT_MAX characters), and failing that the
 * category's label does. Whitespace is collapsed either way, and a typed
 * subject is held to the column's cap rather than failing the insert.
 */
export function deriveSubject(args: {
  subject?: string | null;
  body: string;
  category: TicketCategory;
}): string {
  const typed = collapse(args.subject ?? "");
  if (typed) return clampCodePoints(typed, TICKET_SUBJECT_MAX);
  const firstLine = args.body
    .split(/\r?\n/)
    .map(collapse)
    .find((line) => line.length > 0);
  if (firstLine) return clampCodePoints(firstLine, DERIVED_SUBJECT_MAX);
  return CATEGORY_LABELS[args.category];
}

// ---------------------------------------------------------------------------
// Staff search
// ---------------------------------------------------------------------------

/**
 * What the queue's search box should look for. A reference-shaped query (the
 * "B0-" prefix, or two hyphen- or space-separated halves) is an exact lookup
 * on the normalised reference — someone quoting their reference should land on
 * exactly that ticket. Anything else is a case-insensitive "contains" over
 * email, name, subject and reference. A bare eight-letter word is NOT treated
 * as a reference: plenty of names are eight letters from the alphabet.
 */
export type SupportSearchPlan =
  | { kind: "reference"; reference: string }
  | { kind: "text"; pattern: string };

export const SEARCH_QUERY_MAX = 100;

/** Escapes `\`, `%` and `_` so a LIKE pattern matches them literally. */
export function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

export function supportSearchPlan(query: string | null | undefined): SupportSearchPlan | null {
  // PostgREST treats `*` in a like pattern as `%`, with no escape for it.
  const q = collapse((query ?? "").replace(/\*/g, " ")).slice(0, SEARCH_QUERY_MAX);
  if (!q) return null;
  const referenceShaped =
    /^b0[-\s]*[a-z0-9]{4}[-\s]*[a-z0-9]{4}$/i.test(q) ||
    /^[a-z0-9]{4}[-\s]+[a-z0-9]{4}$/i.test(q);
  const reference = referenceShaped ? normalizeReference(q) : "";
  if (reference) return { kind: "reference", reference };
  return { kind: "text", pattern: `%${escapeLikePattern(q)}%` };
}

/**
 * A PostgREST `or` filter: `pattern` ILIKE-matched against each column. The
 * value is double-quoted, with `"` and `\` backslash-escaped, because a search
 * can contain the characters PostgREST reserves in a filter list (`,` `.` `:`
 * `(` `)`) — an email address always contains a dot.
 */
export function ilikeAnyFilter(columns: readonly string[], pattern: string): string {
  const quoted = `"${pattern.replace(/["\\]/g, (c) => `\\${c}`)}"`;
  return columns.map((c) => `${c}.ilike.${quoted}`).join(",");
}

// ---------------------------------------------------------------------------
// Email template keys
// ---------------------------------------------------------------------------

/**
 * The `email_templates` keys the support emails are sent under. Named once so
 * the key the sender looks up (lib/support.ts) and the row the seed inserts
 * (lib/email/seed.ts) can't drift — lib/support-email-seeds.test.ts asserts
 * every one has a seed row.
 */
export const SUPPORT_EMAIL_KEYS = {
  /** To the requester: "we got your request", with the received time. */
  received: "support.ticket_received",
  /** To the requester: the team replied. */
  replied: "support.ticket_replied",
  /** To the requester: marked resolved (by the team or the cron). */
  resolved: "support.ticket_resolved",
  /** To the team inbox: a new (non-confidential) request. */
  internal: "support.ticket_received_internal",
  /** To the team inbox: a confidential concern arrived — reference and link only. */
  concernInternal: "support.concern_received_internal",
  /** To the team inbox, daily: requests past their reply target. */
  overdueDigest: "support.overdue_digest",
} as const;

// ---------------------------------------------------------------------------
// Housekeeping (the daily cron) — shared so the emails and the cron agree
// ---------------------------------------------------------------------------

/** A ticket waiting on its requester this long is resolved, with a note. */
export const AUTO_RESOLVE_AFTER_DAYS = 7;
/** A resolved ticket nobody reopened is closed after this long. */
export const AUTO_CLOSE_AFTER_DAYS = 14;

/**
 * The system message posted on the thread, and the note in the resolved
 * email, when the cron resolves a ticket nobody answered.
 */
export const AUTO_RESOLVE_NOTE = `We marked this resolved after ${AUTO_RESOLVE_AFTER_DAYS} days without a reply. Reply on the thread any time to reopen it.`;
