import "server-only";
import { cache } from "react";
import { randomBytes } from "node:crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import { getAllRoles } from "@/lib/roles";
import { getViewer } from "@/lib/auth";
import { requireActor } from "@/lib/server-guards";
import { env } from "@/lib/env";
import { sendTemplated } from "@/lib/email/dispatch";
import { isMissingTable } from "@/lib/email/store";
import {
  Templates,
  supportConcernInternalVars,
  supportDigestVars,
  supportInternalVars,
  supportReceivedVars,
  supportRepliedVars,
  supportResolvedVars,
  type SupportDigestItem,
  type SupportInternalEmail,
  type SupportReceivedEmail,
} from "@/lib/email/templates";
import { notifyMany, type NotifyArgs } from "@/lib/notifications";
import { getPublicSiteConfig } from "@/lib/site-config";
import { displayEmail, isPlaceholderEmail } from "@/lib/placeholder-email";
import {
  AUTO_RESOLVE_NOTE,
  CATEGORY_LABELS,
  PRIORITY_LABELS,
  RECEIPT_REF_MAX,
  REFERENCE_ALPHABET,
  REPLY_BODY_MAX,
  REQUESTER_NAME_MAX,
  SUPPORT_EMAIL_KEYS,
  TICKET_BODY_MAX,
  TICKET_BODY_MIN,
  canRequesterMarkSolved,
  checkStaffReceivedAt,
  codePointLength,
  defaultPriorityFor,
  deriveSubject,
  formatElapsed,
  formatReceivedAt,
  ilikeAnyFilter,
  isSensitiveCategory,
  isTicketToken,
  isUuid,
  normalizeReference,
  readStoredContext,
  sanitizeContext,
  slaDueAt,
  slaState,
  statusAfterRequesterReply,
  statusAfterStaffReply,
  statusChangeFields,
  supportScopeFor,
  supportSearchPlan,
  wantsReceiptRef,
  type ReplyVia,
  type StaffAssigneeFilter,
  type StaffLogChannel,
  type StaffTicketView,
  type SupportContext,
  type SupportStaffScope,
  type SupportSurface,
  type TicketCategory,
  type TicketChannel,
  type TicketOutcome,
  type TicketPriority,
  type TicketStatus,
} from "@/lib/support-access";

/**
 * Reads and writes for support tickets (migration 0090).
 *
 * Service-role throughout, with explicit filters on every read — the same
 * shape as lib/discussions.ts and lib/interview-requests.ts. RLS is the
 * backstop and never the thing that saves us, and here it *can't* be: the
 * requester's emailed thread page authorizes on a bearer token, so there is no
 * auth.uid() for a policy to key off at all. Every function below takes the
 * credential it is answering for — a token, the owner's userId, or a staff
 * scope (SupportStaffScope, which carries the confidentiality rule) — and
 * filters on it. The few that take only a ticket id say who must have
 * authorized that ticket first.
 *
 * Keep the rules in this file in lockstep with lib/support-access.ts (the pure
 * predicates) and the policies in 0090. The migration header says the same
 * thing from the other side.
 *
 * MUST NOT be imported by anything a marketing page's module graph reaches.
 * It pulls createAdminClient, which forces `cache: "no-store"`, which throws a
 * DynamicServerError during prerendering and silently downgrades the whole
 * route to per-request rendering — the failure scripts/verify-static.mjs
 * exists to catch. /privacy, /terms and /refund-policy all link to the
 * support form with a plain <a href>, never a component from here.
 */

// Re-exported so the pages that render a ticket have one import path for
// everything about it. The definition lives in lib/support-access.ts because
// that module has no imports and is therefore the only one a test can reach.
export { formatReceivedAt };

// ---------------------------------------------------------------------------
// Template keys — named in lib/support-access.ts so the seed test can see them
// ---------------------------------------------------------------------------

export const SUPPORT_RECEIVED_TEMPLATE = SUPPORT_EMAIL_KEYS.received;
export const SUPPORT_REPLIED_TEMPLATE = SUPPORT_EMAIL_KEYS.replied;
export const SUPPORT_RESOLVED_TEMPLATE = SUPPORT_EMAIL_KEYS.resolved;
export const SUPPORT_INTERNAL_TEMPLATE = SUPPORT_EMAIL_KEYS.internal;
export const SUPPORT_CONCERN_INTERNAL_TEMPLATE = SUPPORT_EMAIL_KEYS.concernInternal;
export const SUPPORT_OVERDUE_DIGEST_TEMPLATE = SUPPORT_EMAIL_KEYS.overdueDigest;

// ---------------------------------------------------------------------------
// Who is asking (staff)
// ---------------------------------------------------------------------------

/**
 * The signed-in viewer's support scope, for a page (RSC). Request-cached, and
 * built on the request-cached getViewer(), so a page, its layout and every
 * read it makes agree on what this person may see. Null when signed out — a
 * scope with no access at all is still returned for a signed-in non-staff
 * viewer, so callers check `canView` / `canManage`, not truthiness.
 *
 * Pages still gate on requirePermission("support.view") first; this is what
 * the reads take, so the confidentiality rule rides along with every query.
 */
export const getSupportScope = cache(
  async function getSupportScope(): Promise<SupportStaffScope | null> {
    const viewer = await getViewer();
    return viewer ? supportScopeFor(viewer.profile.id, viewer.caps) : null;
  },
);

/**
 * The same scope for a server action or a route handler, resolved through
 * the write guard (requireActor verifies the session with the auth server) and
 * refused unless it holds `permission`. Defaults to the write key, so
 * forgetting the argument on a mutation is the stricter mistake.
 */
export async function assertSupportScope(
  permission: "support.view" | "support.manage" = "support.manage",
): Promise<SupportStaffScope> {
  const actor = await requireActor();
  const scope = supportScopeFor(actor.userId, actor.caps);
  if (permission === "support.manage" ? !scope.canManage : !scope.canView) {
    throw new Error("Forbidden");
  }
  return scope;
}

// ---------------------------------------------------------------------------
// Row types
// ---------------------------------------------------------------------------

export type SupportTicket = {
  id: string;
  reference: string;
  /** The bearer capability for /support/t/<token>. Email links only — never a page, title, bell or log. */
  token: string;
  userId: string | null;
  /** Snapshot taken at filing time. Admin surfaces only — see forRequester(). */
  requesterEmail: string;
  requesterName: string | null;
  /** Current account name, when the profile still exists. */
  accountName: string | null;
  category: TicketCategory;
  subject: string;
  body: string;
  status: TicketStatus;
  needsReply: boolean;
  priority: TicketPriority;
  /** A confidential concern: support.sensitive (or '*') only. */
  sensitive: boolean;
  channel: TicketChannel;
  context: SupportContext;
  outcome: TicketOutcome | null;
  receiptRef: string | null;
  /** The tuition payment this is about (fees/fines and Demo Day tickets are in `context`). */
  paymentId: string | null;
  assignedTo: string | null;
  assignedName: string | null;
  /** Staff who logged it on the requester's behalf; null when self-filed. */
  createdBy: string | null;
  createdByName: string | null;
  /** PUBLIC replies only. */
  replyCount: number;
  /** THE refund clock — when the request reached us. Show this, not createdAt. */
  receivedAt: string;
  /** When the requester last wrote; the reply target runs from here. */
  requesterActivityAt: string;
  firstResponseAt: string | null;
  /** Last PUBLIC message. */
  lastActivityAt: string;
  statusChangedAt: string;
  resolvedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

/** A row in a list: no body, token, context or receipt reference. */
export type SupportTicketSummary = Omit<SupportTicket, "token" | "body" | "context" | "receiptRef">;

export type SupportReply = {
  id: string;
  ticketId: string;
  authorId: string | null;
  /** Which side wrote it: the requester, a person on the team, or batch0 itself. */
  author: "requester" | "staff" | "system";
  /**
   * Display name. Staff: their profile name, else "The batch0 team". System:
   * "batch0". Requester: their profile name, or null when there isn't one —
   * the surface decides ("You" on the requester's own pages, the ticket's
   * requester name for the team).
   */
  authorName: string | null;
  /** Admin surfaces only — see forRequester(). */
  authorEmail: string;
  body: string;
  isStaff: boolean;
  isInternal: boolean;
  via: ReplyVia;
  createdAt: string;
};

/** A charge a refund or billing ticket points at. Staff-facing only. */
export type TicketPayment = {
  id: string;
  amountCents: number;
  amountRefundedCents: number;
  currency: string;
  status: string;
  paidAt: string | null;
  createdAt: string;
  stripeSessionId: string | null;
  stripePaymentIntentId: string | null;
  receiptUrl: string | null;
};

const TICKET_COLUMNS = `
  id, reference, token, user_id, requester_email, requester_name, category,
  subject, body, status, needs_reply, priority, sensitive, channel, context,
  outcome, receipt_ref, payment_id, assigned_to, created_by, reply_count,
  received_at, requester_activity_at, first_response_at, last_activity_at,
  status_changed_at, resolved_at, created_at, updated_at`;

const SUMMARY_COLUMNS = `
  id, reference, user_id, requester_email, requester_name, category, subject,
  status, needs_reply, priority, sensitive, channel, outcome, payment_id,
  assigned_to, created_by, reply_count, received_at, requester_activity_at,
  first_response_at, last_activity_at, status_changed_at, resolved_at,
  created_at, updated_at`;

// Three FKs point at profiles, so every embed names its constraint
// (lib/support-migration-db.test.ts pins the names).
const TICKET_EMBEDS = `
  account:profiles!support_tickets_user_id_fkey(full_name),
  assignee:profiles!support_tickets_assigned_to_fkey(full_name),
  creator:profiles!support_tickets_created_by_fkey(full_name)`;

const TICKET_SELECT = `${TICKET_COLUMNS},${TICKET_EMBEDS}`;
const SUMMARY_SELECT = `${SUMMARY_COLUMNS},${TICKET_EMBEDS}`;

const REPLY_SELECT = `
  id, ticket_id, author_id, body, is_staff, is_internal, via, created_at,
  author:profiles!support_ticket_replies_author_id_fkey(full_name, email)
`;

function one<T>(v: T | T[] | null | undefined): T | null {
  return Array.isArray(v) ? (v[0] ?? null) : (v ?? null);
}

function toSummary(row: any): SupportTicketSummary {
  const account = one<any>(row.account);
  const assignee = one<any>(row.assignee);
  const creator = one<any>(row.creator);
  return {
    id: row.id,
    reference: row.reference,
    userId: row.user_id ?? null,
    requesterEmail: row.requester_email ?? "",
    requesterName: row.requester_name ?? null,
    accountName: account?.full_name ?? null,
    category: row.category,
    subject: row.subject,
    status: row.status,
    needsReply: !!row.needs_reply,
    priority: row.priority ?? "normal",
    sensitive: !!row.sensitive,
    channel: row.channel ?? "web",
    outcome: row.outcome ?? null,
    paymentId: row.payment_id ?? null,
    assignedTo: row.assigned_to ?? null,
    assignedName: assignee?.full_name ?? null,
    createdBy: row.created_by ?? null,
    createdByName: creator?.full_name ?? null,
    replyCount: row.reply_count ?? 0,
    receivedAt: row.received_at ?? row.created_at,
    requesterActivityAt: row.requester_activity_at ?? row.created_at,
    firstResponseAt: row.first_response_at ?? null,
    lastActivityAt: row.last_activity_at,
    statusChangedAt: row.status_changed_at ?? row.created_at,
    resolvedAt: row.resolved_at ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at ?? row.created_at,
  };
}

function toTicket(row: any): SupportTicket {
  return {
    ...toSummary(row),
    token: row.token,
    body: row.body,
    context: readStoredContext(row.context),
    receiptRef: row.receipt_ref ?? null,
  };
}

function toReply(row: any): SupportReply {
  const author = one<any>(row.author);
  const isStaff = !!row.is_staff;
  const via: ReplyVia = row.via ?? (isStaff ? "staff" : "token");
  const kind = via === "system" ? "system" : isStaff ? "staff" : "requester";
  const named = author?.full_name?.trim() || null;
  return {
    id: row.id,
    ticketId: row.ticket_id,
    authorId: row.author_id ?? null,
    author: kind,
    // An unnamed reply from the team reads as institutional, not anonymous.
    authorName:
      kind === "system" ? "batch0" : kind === "staff" ? (named ?? "The batch0 team") : named,
    authorEmail: author?.email ?? "",
    body: row.body,
    isStaff,
    isInternal: !!row.is_internal,
    via,
    createdAt: row.created_at,
  };
}

/**
 * The fields a requester-facing surface must never receive. The token is in
 * here as well as the email addresses: the thread page already has the token
 * in its URL (or, on the dashboard, doesn't need it at all), and putting it
 * into a component's props is how it ends up in a server-rendered payload, a
 * client-side router cache, or an error report. The triage fields — who it's
 * assigned to, its priority, how staff classified the outcome, the technical
 * context — are the team's working notes about the person, not theirs.
 */
const REQUESTER_HIDDEN = [
  "token",
  "requesterEmail",
  "authorEmail",
  "authorId",
  "priority",
  "assignedTo",
  "assignedName",
  "createdBy",
  "createdByName",
  "context",
  "outcome",
] as const;

type RequesterHidden = (typeof REQUESTER_HIDDEN)[number];

/**
 * Strips everything a requester must not receive, at the type level. The Omit
 * is what makes forgetting impossible — a component typed on the scrubbed
 * shape cannot read the fields at all. Works on tickets, summaries and replies.
 */
export function forRequester<T extends object>(x: T): Omit<T, RequesterHidden> {
  const out = { ...x } as Record<string, unknown>;
  for (const key of REQUESTER_HIDDEN) delete out[key];
  return out as Omit<T, RequesterHidden>;
}

/**
 * The shapes the requester-facing components are typed on. Spelled out so the
 * omitted keys are readable at a glance — these lines are the privacy contract.
 */
export type RequesterTicket = Omit<SupportTicket, RequesterHidden>;
export type RequesterTicketSummary = Omit<SupportTicketSummary, RequesterHidden>;
export type RequesterReply = Omit<SupportReply, RequesterHidden>;

// ---------------------------------------------------------------------------
// Identifiers and links
// ---------------------------------------------------------------------------

/** 32 bytes base64url — 43 chars, the shape lib/support-access.ts validates. */
function mintToken(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * A quotable reference like `B0-4F2A-9C7K`.
 *
 * Rejection sampling over the 30-character alphabet rather than `% 30` on a
 * byte, because 256 isn't a multiple of 30 and the modulo would make the first
 * 16 symbols measurably likelier. That bias wouldn't be a security problem —
 * the reference authorizes nothing — but it shrinks the effective space and
 * this costs one loop.
 */
function mintReference(): string {
  const chars: string[] = [];
  while (chars.length < 8) {
    for (const byte of randomBytes(16)) {
      if (byte >= 240) continue; // 240 = 8 * 30, the largest unbiased ceiling
      chars.push(REFERENCE_ALPHABET[byte % 30]);
      if (chars.length === 8) break;
    }
  }
  return `B0-${chars.slice(0, 4).join("")}-${chars.slice(4).join("")}`;
}

/** The emailed thread URL. Absolute, because it goes in email — and ONLY in email. */
export function ticketUrl(token: string): string {
  return `${env.siteUrl}/support/t/${token}`;
}

/** The staff-facing URL, absolute, for the team's email. */
export function adminTicketUrl(id: string): string {
  return `${env.siteUrl}${adminTicketPath(id)}`;
}

/** The staff-facing path — bells and in-app links (relative, so they work on either host). */
export function adminTicketPath(id: string): string {
  return `/admin/support/${id}`;
}

/**
 * The requester's own thread, by session: the dashboard on the website, the
 * app's screen on app.batch0.org. Keyed on the reference, which grants
 * nothing — the owner's session is what authorizes the page.
 */
export function requesterThreadPath(reference: string, surface: SupportSurface = "web"): string {
  return surface === "app" ? `/app/support/${reference}` : `/dashboard/support/${reference}`;
}

// ---------------------------------------------------------------------------
// Small shared pieces
// ---------------------------------------------------------------------------

const GENERIC_FAILURE = `That didn't go through. Try again in a minute, or email ${env.contactEmail}.`;

/** Logs a database failure and returns the sentence a person should see instead. */
function dbFailure(where: string, error: { message?: string; code?: string } | null): Error {
  console.error(`[support] ${where} failed`, error?.code, error?.message);
  return new Error(GENERIC_FAILURE);
}

/**
 * For the cron-facing functions, whose errors no person reads: keeps the
 * database's message, so the caller can tell an unapplied 0090 apart
 * (isMissingTable() from lib/email/store matches it) and report it as such.
 */
function systemFailure(where: string, error: { message?: string; code?: string } | null): Error {
  console.error(`[support] ${where} failed`, error?.code, error?.message);
  return new Error(`[support] ${where}: ${error?.message ?? "unknown error"}`);
}

/** A value for a PostgREST `or` list: double-quoted, `"` and `\` escaped. */
function quoted(value: string): string {
  return `"${value.replace(/["\\]/g, (c) => `\\${c}`)}"`;
}

/** Can this address receive mail from us? Placeholder accounts' addresses can't. */
function isMailable(email: string | null | undefined): email is string {
  return !!email && email.includes("@") && !isPlaceholderEmail(email);
}

function trimToCodePoints(value: string, max: number): string {
  return Array.from(value).slice(0, max).join("");
}

function excerpt(body: string, max = 160): string {
  const flat = body.replace(/\s+/g, " ").trim();
  const chars = Array.from(flat);
  return chars.length <= max ? flat : `${chars.slice(0, max - 1).join("").trimEnd()}…`;
}

function firstNameOf(name: string | null | undefined): string | null {
  return name?.trim().split(/\s+/)[0] || null;
}

/** The requester's name as we know it: what they filed under, else the account's. */
function requesterNameOf(t: Pick<SupportTicket, "requesterName" | "accountName">): string | null {
  return t.requesterName?.trim() || t.accountName?.trim() || null;
}

/** How a ticket's requester is described to the team. */
function requesterLabel(t: Pick<SupportTicket, "requesterName" | "accountName" | "requesterEmail">): string {
  const name = requesterNameOf(t);
  const email = displayEmail(t.requesterEmail);
  if (name && email) return `${name} <${email}>`;
  return name ?? email ?? "Someone without an email on file";
}

// ---------------------------------------------------------------------------
// Creating a ticket
// ---------------------------------------------------------------------------

/** Raw filing context from the form and the request; sanitized inside createTicket. */
export type RawSupportContext = {
  page?: unknown;
  source?: unknown;
  digest?: unknown;
  userAgent?: unknown;
};

export type CreateTicketInput =
  | {
      /** Self-filed by a signed-in person, on the website or in the app. */
      filedBy: "requester";
      userId: string;
      /** The account's email — refused if it is a placeholder. */
      email: string;
      name: string | null;
      category: TicketCategory;
      /** Optional; derived from the body when blank (deriveSubject). */
      subject?: string | null;
      body: string;
      receiptRef?: string | null;
      /**
       * Which of their charges it's about, for a refund or billing request: a
       * tuition payment, a fee or fine, or a Demo Day ticket id (listOwnPayables
       * offers them). Ownership is verified here; a tuition payment becomes
       * `payment_id`, the others are recorded in `context`.
       */
      paymentId?: string | null;
      surface: SupportSurface;
      context?: RawSupportContext;
    }
  | {
      /** Logged by staff for a request that arrived by email, phone or otherwise. */
      filedBy: "staff";
      staffId: string;
      /** Matched to an account when one has this email (findAccountByEmail). */
      requesterEmail: string;
      requesterName?: string | null;
      channel: StaffLogChannel;
      /** When the request actually arrived, ISO. See checkStaffReceivedAt. */
      receivedAt: string;
      category: TicketCategory;
      /** Defaults to the category's priority. */
      priority?: TicketPriority | null;
      subject?: string | null;
      body: string;
      receiptRef?: string | null;
    };

/** A charge someone could be asking about, for the "which payment?" picker. */
export type OwnPayable = {
  kind: "tuition" | "charge" | "demo_day";
  id: string;
  /** "Tuition", the fee or fine's description, or "Demo Day ticket". */
  description: string;
  amountCents: number;
  currency: string;
  status: string;
  paidAt: string | null;
  createdAt: string;
};

/**
 * Every charge on this person's account a refund or billing request could be
 * about — tuition payments, fees and fines, Demo Day tickets (matched by
 * account or by email, since a ticket can be bought before the account
 * exists). Newest first within each kind. The form offers these; createTicket
 * re-verifies whichever one comes back.
 */
export async function listOwnPayables(userId: string, email: string | null): Promise<OwnPayable[]> {
  const admin = createAdminClient();
  const ddt = admin
    .from("demo_day_tickets")
    .select("id, status, amount_cents, paid_at, created_at")
    .in("status", ["paid", "refunded"]);
  const [payments, charges, tickets] = await Promise.all([
    admin
      .from("payments")
      .select("id, amount_cents, currency, status, paid_at, created_at")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(20),
    admin
      .from("user_charges")
      .select("id, kind, description, amount_cents, status, paid_at, created_at")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(20),
    (isMailable(email)
      ? ddt.or(`user_id.eq.${userId},email.eq.${quoted(email.toLowerCase())}`)
      : ddt.eq("user_id", userId)
    )
      .order("created_at", { ascending: false })
      .limit(10),
  ]);
  for (const [what, r] of [["payments", payments], ["charges", charges], ["demo day tickets", tickets]] as const) {
    if (r.error) console.error(`[support] listOwnPayables ${what}`, r.error.message);
  }
  return [
    ...(payments.data ?? []).map((p: any) => ({
      kind: "tuition" as const,
      id: p.id,
      description: "Tuition",
      amountCents: p.amount_cents ?? 0,
      currency: p.currency ?? "usd",
      status: p.status,
      paidAt: p.paid_at ?? null,
      createdAt: p.created_at,
    })),
    ...(charges.data ?? []).map((c: any) => ({
      kind: "charge" as const,
      id: c.id,
      description: c.description || (c.kind === "fine" ? "Fine" : "Fee"),
      amountCents: c.amount_cents ?? 0,
      currency: "usd",
      status: c.status,
      paidAt: c.paid_at ?? null,
      createdAt: c.created_at,
    })),
    ...(tickets.data ?? []).map((t: any) => ({
      kind: "demo_day" as const,
      id: t.id,
      description: "Demo Day ticket",
      amountCents: t.amount_cents ?? 0,
      currency: "usd",
      status: t.status,
      paidAt: t.paid_at ?? null,
      createdAt: t.created_at,
    })),
  ];
}

/** Which of this person's charges `id` is, or null when it isn't theirs. */
async function resolveOwnPayable(
  userId: string,
  email: string,
  id: string,
): Promise<OwnPayable["kind"] | null> {
  if (!isUuid(id)) return null;
  const admin = createAdminClient();
  const [payment, charge, ticket] = await Promise.all([
    admin.from("payments").select("id").eq("id", id).eq("user_id", userId).maybeSingle(),
    admin.from("user_charges").select("id").eq("id", id).eq("user_id", userId).maybeSingle(),
    admin
      .from("demo_day_tickets")
      .select("id")
      .eq("id", id)
      .or(`user_id.eq.${userId},email.eq.${quoted(email.toLowerCase())}`)
      .maybeSingle(),
  ]);
  if (payment.data) return "tuition";
  if (charge.data) return "charge";
  if (ticket.data) return "demo_day";
  return null;
}

/** An existing account with exactly this email (case-insensitive), for staff logging a request. */
export async function findAccountByEmail(
  email: string,
): Promise<{ id: string; email: string; fullName: string | null; role: string } | null> {
  const clean = email.trim();
  if (!clean.includes("@")) return null;
  const admin = createAdminClient();
  const base = admin.from("profiles").select("id, email, full_name, role");
  const { data, error } = await (clean.includes("*")
    ? // PostgREST reads `*` in a like pattern as a wildcard and has no escape
      // for it — and `*` is legal in an address — so that rare address gets
      // an exact, lowercased match instead.
      base.eq("email", clean.toLowerCase())
    : // ILIKE with every metacharacter escaped is a case-insensitive equality.
      base.ilike("email", clean.replace(/[\\%_]/g, (c) => `\\${c}`))
  ).limit(2);
  if (error) throw dbFailure("findAccountByEmail", error);
  // Two accounts differing only by case is possible in principle; refuse to
  // guess between them rather than attach the request to the wrong person.
  if (!data || data.length !== 1) return null;
  const p = data[0] as any;
  return { id: p.id, email: p.email, fullName: p.full_name ?? null, role: p.role };
}

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Files a ticket and returns it. Throws with a sentence a person can act on —
 * the calling action surfaces the message — and never with a raw database
 * error.
 *
 * Everything the server owns is decided here, whichever surface filed it, so
 * the website, the app and the admin's "log a request" can't disagree: the
 * subject when it was left blank, the priority and confidentiality from the
 * category, the channel, the received time, the sanitized context, and the
 * ownership of whichever charge it's about.
 *
 * Retries on a unique-constraint collision (Postgres 23505). Both `reference`
 * and `token` are random and unique, and while a token collision is not going
 * to happen, the reference is only 8 symbols from a 30-symbol alphabet — about
 * 6.6e11 values. That is ample for the volume here, but it is a birthday
 * problem rather than an impossibility, and the cost of handling it is this
 * loop. Retrying with fresh values is correct for either column.
 */
export async function createTicket(input: CreateTicketInput): Promise<SupportTicket> {
  const body = input.body.trim();
  const length = codePointLength(body);
  if (length < TICKET_BODY_MIN) {
    throw new Error("Tell us a bit more — a few sentences about what happened is enough.");
  }
  if (length > TICKET_BODY_MAX) {
    throw new Error(`That's too long — keep it under ${TICKET_BODY_MAX} characters.`);
  }
  const subject = deriveSubject({ subject: input.subject, body, category: input.category });
  const receiptRef = wantsReceiptRef(input.category)
    ? trimToCodePoints(input.receiptRef?.trim() ?? "", RECEIPT_REF_MAX) || null
    : null;

  let row: Record<string, unknown>;
  if (input.filedBy === "requester") {
    const email = input.email.trim().toLowerCase();
    if (!isMailable(email) || !EMAIL_SHAPE.test(email)) {
      // Accounts an admin created without an email carry a placeholder
      // address that can never receive mail — and a ticket we can't answer
      // is worse than none. Email works for them, and counts the same.
      throw new Error(
        `Your account doesn't have an email address we can reply to. Email ${env.contactEmail} instead — it reaches the same people and counts the same.`,
      );
    }
    const context: SupportContext = sanitizeContext({ ...input.context, surface: input.surface });
    let paymentId: string | null = null;
    if (input.paymentId && wantsReceiptRef(input.category)) {
      const kind = await resolveOwnPayable(input.userId, email, input.paymentId);
      if (!kind) {
        throw new Error("That payment isn't on your account. Pick one from the list, or leave it blank.");
      }
      if (kind === "tuition") paymentId = input.paymentId;
      if (kind === "charge") context.chargeId = input.paymentId;
      if (kind === "demo_day") context.demoDayTicketId = input.paymentId;
    }
    row = {
      user_id: input.userId,
      requester_email: email,
      requester_name: input.name ? trimToCodePoints(input.name.trim(), REQUESTER_NAME_MAX) || null : null,
      channel: input.surface === "app" ? "app" : "web",
      context,
      payment_id: paymentId,
      // received_at is left to the column default — now(), in the same
      // statement that creates the row, so a self-filed request's clock is
      // exactly its creation.
    };
  } else {
    const typed = input.requesterEmail.trim().toLowerCase();
    if (!EMAIL_SHAPE.test(typed) || isPlaceholderEmail(typed)) {
      throw new Error("Enter the email address the request came from.");
    }
    const problem = checkStaffReceivedAt(input.receivedAt);
    if (problem) throw new Error(problem);
    // Attach it to their account when they have one: they then see it on the
    // dashboard and in the app, not just through the emailed link.
    const account = await findAccountByEmail(typed);
    const name = input.requesterName?.trim() || account?.fullName?.trim() || null;
    row = {
      user_id: account?.id ?? null,
      requester_email: account && isMailable(account.email) ? account.email.toLowerCase() : typed,
      requester_name: name ? trimToCodePoints(name, REQUESTER_NAME_MAX) : null,
      channel: input.channel,
      context: {},
      created_by: input.staffId,
      received_at: new Date(input.receivedAt).toISOString(),
    };
  }

  const admin = createAdminClient();
  for (let attempt = 0; attempt < 5; attempt++) {
    const { data, error } = await admin
      .from("support_tickets")
      .insert({
        ...row,
        reference: mintReference(),
        token: mintToken(),
        category: input.category,
        subject,
        body,
        receipt_ref: receiptRef,
        priority:
          (input.filedBy === "staff" ? input.priority : null) ?? defaultPriorityFor(input.category),
        sensitive: isSensitiveCategory(input.category),
        // A brand-new ticket is by definition waiting on us. Stated rather
        // than left to the column defaults so the intent is visible here too.
        status: "open",
        needs_reply: true,
      })
      .select(TICKET_SELECT)
      .single();

    if (!error && data) return toTicket(data);
    if (error?.code !== "23505") throw dbFailure("createTicket", error);
  }
  throw dbFailure("createTicket (five reference collisions)", null);
}

// ---------------------------------------------------------------------------
// Replies
// ---------------------------------------------------------------------------

/**
 * Who is posting, derived by the caller from the credential actually
 * presented — never from anything the client sent. The kind decides the row's
 * `is_staff`, `via` and `is_internal`, so they can't be combined wrongly (the
 * CHECKs in 0090 refuse it anyway).
 */
export type ReplyAuthor =
  | {
      kind: "requester";
      /** The owner's id (session), or the ticket's userId for a token holder. */
      userId: string | null;
      via: "session" | "token";
    }
  | {
      kind: "staff";
      userId: string;
      /** An internal note: staff-only, never emailed, moves no status. */
      internal?: boolean;
      /** "Send & resolve" asks for 'resolved'; keep-open asks for 'open'. Default: waiting on the requester. */
      nextStatus?: TicketStatus | null;
      /** Recorded when the reply resolves the ticket. */
      outcome?: TicketOutcome | null;
    }
  | {
      /** An automated message (the cron's auto-resolve note). Moves no status — the caller does. */
      kind: "system";
    };

export type AppendReplyResult = {
  reply: SupportReply;
  /** The status this reply's transition started from (fresh, if it had to retry). */
  from: TicketStatus;
  /** Where the ticket ended up. */
  status: TicketStatus;
  /** Whether this reply moved the status. */
  changed: boolean;
  /**
   * The reply was saved but the status update failed (logged). The thread is
   * right; the queue may be stale until the next change.
   */
  statusError: boolean;
};

/**
 * Appends a message and moves the ticket's status in one place.
 *
 * The counters and clocks (reply_count, last_activity_at, first_response_at,
 * requester_activity_at) are the trigger's job in 0090; this does the status.
 * The transition is the pure function from lib/support-access.ts, so "a
 * follow-up reopens a resolved ticket" is stated once and testable.
 *
 * The status write is conditional on the status it was computed from — an
 * optimistic lock. If something moved the ticket in between (another admin,
 * the cron auto-resolving it), the update matches nothing, and the transition
 * is recomputed from where the ticket actually is: a requester's follow-up
 * racing the cron's auto-resolve still reopens the ticket, and never leaves it
 * open with a stale resolved_at.
 *
 * Caller authorizes the ticket first (owner, token or staff scope) and checks
 * canRequesterReply / canStaffReply.
 */
export async function appendReply(args: {
  ticket: Pick<SupportTicket, "id" | "status">;
  body: string;
  author: ReplyAuthor;
}): Promise<AppendReplyResult> {
  const body = args.body.trim();
  if (!body) throw new Error("Write something before sending.");
  if (codePointLength(body) > REPLY_BODY_MAX) {
    throw new Error(`That's too long — keep it under ${REPLY_BODY_MAX} characters.`);
  }
  const a = args.author;
  const internal = a.kind === "staff" && a.internal === true;

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("support_ticket_replies")
    .insert({
      ticket_id: args.ticket.id,
      author_id: a.kind === "system" ? null : a.userId,
      is_staff: a.kind !== "requester",
      is_internal: internal,
      via: a.kind === "requester" ? a.via : a.kind,
      body,
    })
    .select(REPLY_SELECT)
    .single();
  if (error || !data) throw dbFailure("appendReply", error);
  const reply = toReply(data);

  // A note to the team and an automated message are not a turn in the
  // conversation: neither moves the status.
  const unchanged = (status: TicketStatus): AppendReplyResult => ({
    reply,
    from: status,
    status,
    changed: false,
    statusError: false,
  });
  if (internal || a.kind === "system") return unchanged(args.ticket.status);

  let current = args.ticket.status;
  for (let attempt = 0; attempt < 3; attempt++) {
    const next =
      a.kind === "requester"
        ? statusAfterRequesterReply({ status: current })
        : statusAfterStaffReply({ status: current }, a.nextStatus);
    if (next === current) return unchanged(current);

    const outcome = a.kind === "staff" && next === "resolved" ? (a.outcome ?? undefined) : undefined;
    const { data: moved, error: moveError } = await admin
      .from("support_tickets")
      .update(statusChangeFields(current, next, new Date().toISOString(), outcome))
      .eq("id", args.ticket.id)
      .eq("status", current)
      .select("id");
    if (moveError) {
      console.error("[support] appendReply status update failed", moveError.message);
      return { ...unchanged(current), statusError: true };
    }
    if ((moved ?? []).length > 0) {
      return { reply, from: current, status: next, changed: true, statusError: false };
    }
    // Lost the race: decide again from where the ticket actually is.
    const { data: fresh } = await admin
      .from("support_tickets")
      .select("status")
      .eq("id", args.ticket.id)
      .maybeSingle();
    if (!fresh) return unchanged(current);
    current = fresh.status as TicketStatus;
  }
  console.error("[support] appendReply gave up after three status races", args.ticket.id);
  return { ...unchanged(current), statusError: true };
}

/**
 * Claims the notification for a reply, returning true exactly once.
 *
 * `.is("notified_at", null)` is the lock, not decoration: a retried server
 * action or a double-clicked Send would otherwise mail the same reply twice,
 * and `dedupeKey` on the direct sendTemplated() path is inert — only the
 * queued path honours the outbox's unique index. Claim first, then send; if
 * the send fails, releaseReplyNotification() gives the claim back so a retry
 * can deliver it.
 */
export async function claimReplyNotification(replyId: string): Promise<boolean> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("support_ticket_replies")
    .update({ notified_at: new Date().toISOString() })
    .eq("id", replyId)
    .is("notified_at", null)
    .select("id");
  if (error) console.error("[support] claimReplyNotification", error.message);
  return (data ?? []).length > 0;
}

/** Undoes a claim whose email didn't go out, so the next attempt can send it. */
export async function releaseReplyNotification(replyId: string): Promise<void> {
  const admin = createAdminClient();
  const { error } = await admin
    .from("support_ticket_replies")
    .update({ notified_at: null })
    .eq("id", replyId);
  if (error) console.error("[support] releaseReplyNotification", error.message);
}

/**
 * Messages in posting order.
 *
 * `includeInternal` defaults to false so the safe answer is the one you get by
 * forgetting the argument. Only staff surfaces pass true, after
 * getTicketForStaff() has authorized the ticket for their scope. The caller
 * has always authorized `ticketId` first — this takes no credential.
 */
export async function listTicketReplies(
  ticketId: string,
  opts: { includeInternal?: boolean } = {},
): Promise<SupportReply[]> {
  const admin = createAdminClient();
  let q = admin.from("support_ticket_replies").select(REPLY_SELECT).eq("ticket_id", ticketId);
  if (opts.includeInternal !== true) q = q.eq("is_internal", false);
  const { data, error } = await q.order("created_at", { ascending: true }).limit(500);
  if (error) throw dbFailure("listTicketReplies", error);
  return (data ?? []).map(toReply);
}

// ---------------------------------------------------------------------------
// Reads — the requester
// ---------------------------------------------------------------------------

/**
 * One ticket by its bearer token, or null.
 *
 * The token shape is checked before the round trip so a malformed URL costs
 * nothing and tells a prober nothing. "No such ticket" and "not yours" are the
 * same answer by construction: there is no second credential to be wrong
 * about — holding the token IS the authorization, exactly as in
 * lib/demo-day-tickets.ts (whose getTicketByToken is why this one has a longer
 * name). Pass the result through forRequester() before rendering it.
 */
export async function getSupportTicketByToken(token: string): Promise<SupportTicket | null> {
  if (!isTicketToken(token)) return null;
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("support_tickets")
    .select(TICKET_SELECT)
    .eq("token", token)
    .maybeSingle();
  if (error) throw dbFailure("getSupportTicketByToken", error);
  return data ? toTicket(data) : null;
}

/**
 * The signed-in owner's ticket by its reference, or null — the same null for
 * "no such reference" and "not yours", so the page 404s identically. The
 * reference is normalized first, so a lowercased or space-separated one from
 * a URL still resolves. Pass the result through forRequester() before
 * rendering it.
 */
export async function getTicketForOwner(
  userId: string,
  reference: string,
): Promise<SupportTicket | null> {
  const ref = normalizeReference(reference);
  if (!ref) return null;
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("support_tickets")
    .select(TICKET_SELECT)
    .eq("reference", ref)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw dbFailure("getTicketForOwner", error);
  return data ? toTicket(data) : null;
}

/**
 * Every ticket this account filed (or that the team logged against it),
 * most recent activity first, already scrubbed for a requester — no token, no
 * triage fields.
 */
export async function listTicketsForUser(
  userId: string,
  opts: { limit?: number } = {},
): Promise<RequesterTicketSummary[]> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("support_tickets")
    .select(SUMMARY_SELECT)
    .eq("user_id", userId)
    .order("last_activity_at", { ascending: false })
    .limit(Math.min(opts.limit ?? 100, 200));
  if (error) throw dbFailure("listTicketsForUser", error);
  return (data ?? []).map((row: any) => forRequester(toSummary(row)));
}

// ---------------------------------------------------------------------------
// Reads — staff
// ---------------------------------------------------------------------------

/** Confidential tickets drop out of every staff read for a scope without support.sensitive. */
function visibleTo(q: any, scope: SupportStaffScope): any {
  return scope.canSeeSensitive ? q : q.eq("sensitive", false);
}

function requireView(scope: SupportStaffScope) {
  if (!scope.canView) throw new Error("Forbidden");
}

function requireManage(scope: SupportStaffScope) {
  if (!scope.canManage) throw new Error("Forbidden");
}

/**
 * One ticket for the team, or null when it doesn't exist OR this scope may not
 * see it (a confidential concern without support.sensitive) — the same null,
 * so the page 404s the same way and a non-sensitive staff member can't learn a
 * concern exists by guessing its id.
 */
export async function getTicketForStaff(
  id: string,
  scope: SupportStaffScope,
): Promise<SupportTicket | null> {
  requireView(scope);
  if (!isUuid(id)) return null;
  const admin = createAdminClient();
  const { data, error } = await visibleTo(
    admin.from("support_tickets").select(TICKET_SELECT).eq("id", id),
    scope,
  ).maybeSingle();
  if (error) throw dbFailure("getTicketForStaff", error);
  return data ? toTicket(data) : null;
}

export type StaffTicketFilter = {
  /** Default "needs_reply" — the work queue. */
  view?: StaffTicketView;
  category?: TicketCategory | null;
  priority?: TicketPriority | null;
  /** Anyone, the viewer, nobody — or a specific staff member's id. */
  assignee?: StaffAssigneeFilter | string | null;
  /** A reference (exact, normalized) or text in the email, name, subject or reference. */
  search?: string | null;
  /** One person's tickets — the Support card on /admin/students/[id]. */
  userId?: string | null;
  /** 1-based. */
  page?: number;
  /** Default 50, at most 100. */
  pageSize?: number;
};

export type StaffTicketPage = {
  tickets: SupportTicketSummary[];
  /** Every ticket matching the filter, not just this page. */
  total: number;
  page: number;
  pageSize: number;
  /** Set when the read failed. isMissingTable(error) means 0090 isn't applied here. */
  error: { message: string; code?: string } | null;
};

export const SUPPORT_PAGE_SIZE = 50;
const SUPPORT_PAGE_SIZE_MAX = 100;
/** How many needs-reply tickets are read to sort the work queue by due time. */
const NEEDS_REPLY_SCAN = 500;

function applyStaffFilter(q: any, f: Omit<StaffTicketFilter, "view" | "page" | "pageSize">, scope: SupportStaffScope) {
  q = visibleTo(q, scope);
  if (f.category) q = q.eq("category", f.category);
  if (f.priority) q = q.eq("priority", f.priority);
  if (f.assignee === "mine") q = q.eq("assigned_to", scope.userId);
  else if (f.assignee === "unassigned") q = q.is("assigned_to", null);
  else if (f.assignee && isUuid(f.assignee)) q = q.eq("assigned_to", f.assignee);
  if (f.userId) q = q.eq("user_id", f.userId);
  const plan = supportSearchPlan(f.search);
  if (plan?.kind === "reference") q = q.eq("reference", plan.reference);
  else if (plan?.kind === "text") {
    q = q.or(ilikeAnyFilter(["reference", "requester_email", "requester_name", "subject"], plan.pattern));
  }
  return q;
}

/** Most overdue first: the earliest reply-target due time, then the longest wait. */
function byDueTime(a: SupportTicketSummary, b: SupportTicketSummary): number {
  const due = (t: SupportTicketSummary) => Date.parse(slaDueAt(t) ?? t.requesterActivityAt);
  return due(a) - due(b) || Date.parse(a.requesterActivityAt) - Date.parse(b.requesterActivityAt);
}

/**
 * A page of the admin queue for this scope. Confidential tickets are simply
 * absent for a scope without support.sensitive — from the rows AND the total —
 * so nothing on the page reveals that one exists.
 *
 * "Needs reply" is ordered by reply-target due time (an urgent concern filed
 * an hour ago outranks a normal request from yesterday). That order is
 * computed from the priority, which Postgres can't sort by meaning, so up to
 * the first 500 waiting tickets (longest-waiting first) are read and sorted
 * here; past that, the tail is in waiting order. Every other view is a browse,
 * newest activity first.
 */
export async function listTicketsForStaff(
  filter: StaffTicketFilter,
  scope: SupportStaffScope,
): Promise<StaffTicketPage> {
  requireView(scope);
  const view = filter.view ?? "needs_reply";
  // Page numbers usually come straight out of a query string.
  const whole = (n: number | undefined, fallback: number) =>
    Number.isFinite(n) ? Math.floor(n as number) : fallback;
  const pageSize = Math.min(Math.max(1, whole(filter.pageSize, SUPPORT_PAGE_SIZE)), SUPPORT_PAGE_SIZE_MAX);
  const page = Math.max(1, whole(filter.page, 1));
  const from = (page - 1) * pageSize;
  const admin = createAdminClient();

  const query = (select: string, opts: { count: "exact"; head?: boolean }) => {
    let q = applyStaffFilter(admin.from("support_tickets").select(select, opts), filter, scope);
    if (view === "needs_reply") q = q.eq("needs_reply", true);
    else if (view !== "all") q = q.eq("status", view);
    return q;
  };

  const { data, error, count } =
    view === "needs_reply"
      ? await query(SUMMARY_SELECT, { count: "exact" })
          .order("requester_activity_at", { ascending: true })
          .limit(NEEDS_REPLY_SCAN)
      : await query(SUMMARY_SELECT, { count: "exact" })
          .order("last_activity_at", { ascending: false })
          .range(from, from + pageSize - 1);

  // A page past the end is PostgREST's 416 (PGRST103), not an empty list: say
  // how many there are, so the page can offer the way back.
  if ((error as any)?.code === "PGRST103") {
    const { count: total } = await query("id", { count: "exact", head: true });
    return { tickets: [], total: total ?? 0, page, pageSize, error: null };
  }
  if (error) {
    if (!isMissingTable(error)) console.error("[support] listTicketsForStaff", error.message);
    return {
      tickets: [],
      total: 0,
      page,
      pageSize,
      error: { message: error.message, code: (error as any).code },
    };
  }
  let tickets = (data ?? []).map(toSummary);
  if (view === "needs_reply") tickets = tickets.sort(byDueTime).slice(from, from + pageSize);
  return { tickets, total: count ?? tickets.length, page, pageSize, error: null };
}

export type SupportCounts = {
  /** The work queue (open tickets). */
  needs_reply: number;
  waiting_on_requester: number;
  resolved: number;
  closed: number;
  all: number;
  /** Needs a reply and is urgent. */
  urgent: number;
  /** Needs a reply and is past its reply target. */
  overdue: number;
  /** Needs a reply and is within the last quarter of its target. */
  dueSoon: number;
  /** Needs a reply and is assigned to the viewer. */
  mine: number;
  /** Needs a reply and nobody has it. */
  unassigned: number;
  /** False when the counts couldn't be read (they are then all 0). */
  available: boolean;
};

const ZERO_COUNTS: SupportCounts = {
  needs_reply: 0,
  waiting_on_requester: 0,
  resolved: 0,
  closed: 0,
  all: 0,
  urgent: 0,
  overdue: 0,
  dueSoon: 0,
  mine: 0,
  unassigned: 0,
  available: false,
};

/**
 * The queue's numbers for this scope — the view tabs, the admin overview tile,
 * the app's Today stat. Computed with exactly the filter the list uses, so a
 * confidential concern is never counted for someone who can't open it (a "1"
 * that leads to an empty list would say it exists). Never throws: zeros with
 * `available: false` when the read fails or 0090 isn't applied.
 */
export async function countTicketsForStaff(
  scope: SupportStaffScope,
  filter: Omit<StaffTicketFilter, "view" | "page" | "pageSize"> = {},
  now: number = Date.now(),
): Promise<SupportCounts> {
  if (!scope.canView) return { ...ZERO_COUNTS };
  try {
    const admin = createAdminClient();
    const head = () =>
      applyStaffFilter(
        admin.from("support_tickets").select("id", { count: "exact", head: true }),
        filter,
        scope,
      );
    const [needsReply, waiting, resolved, closed, open, scan] = await Promise.all([
      head().eq("needs_reply", true),
      head().eq("status", "waiting_on_requester"),
      head().eq("status", "resolved"),
      head().eq("status", "closed"),
      head().eq("status", "open"),
      applyStaffFilter(
        admin.from("support_tickets").select("priority, requester_activity_at, assigned_to"),
        filter,
        scope,
      )
        .eq("needs_reply", true)
        .limit(2000),
    ]);
    const failed = [needsReply, waiting, resolved, closed, open, scan].find((r: any) => r.error);
    if (failed) {
      if (!isMissingTable(failed.error)) console.error("[support] countTicketsForStaff", failed.error.message);
      return { ...ZERO_COUNTS };
    }
    const counts: SupportCounts = {
      ...ZERO_COUNTS,
      needs_reply: needsReply.count ?? 0,
      waiting_on_requester: waiting.count ?? 0,
      resolved: resolved.count ?? 0,
      closed: closed.count ?? 0,
      all: (open.count ?? 0) + (waiting.count ?? 0) + (resolved.count ?? 0) + (closed.count ?? 0),
      available: true,
    };
    for (const row of (scan.data ?? []) as any[]) {
      const t = { needsReply: true, priority: row.priority, requesterActivityAt: row.requester_activity_at };
      if (row.priority === "urgent") counts.urgent++;
      const state = slaState(t, now);
      if (state === "overdue") counts.overdue++;
      if (state === "due_soon") counts.dueSoon++;
      if (row.assigned_to === scope.userId) counts.mine++;
      if (!row.assigned_to) counts.unassigned++;
    }
    return counts;
  } catch (err) {
    console.error("[support] countTicketsForStaff threw", err);
    return { ...ZERO_COUNTS };
  }
}

/**
 * The work-queue count for the signed-in viewer (the admin overview tile).
 * Resolves the viewer's scope itself when none is given, so the count always
 * respects confidentiality. 0 for anyone without support access.
 */
export async function countTicketsNeedingReply(scope?: SupportStaffScope | null): Promise<number> {
  const s = scope ?? (await getSupportScope());
  if (!s?.canView) return 0;
  return (await countTicketsForStaff(s)).needs_reply;
}

// ---------------------------------------------------------------------------
// Writes — staff
//
// Each takes the scope and enforces it itself — support.manage, and the
// confidentiality rule as a filter on the update — so a server action that
// forgot a check still can't change a ticket its caller can't see. Each
// returns the ticket as it is afterwards.
// ---------------------------------------------------------------------------

async function updateVisibleTicket(
  where: string,
  ticketId: string,
  scope: SupportStaffScope,
  patch: Record<string, unknown>,
  extra?: (q: any) => any,
): Promise<SupportTicket | null> {
  requireManage(scope);
  if (!isUuid(ticketId)) return null;
  const admin = createAdminClient();
  let q: any = visibleTo(
    admin.from("support_tickets").update(patch).eq("id", ticketId),
    scope,
  );
  if (extra) q = extra(q);
  const { data, error } = await q.select(TICKET_SELECT).maybeSingle();
  if (error) throw dbFailure(where, error);
  return data ? toTicket(data) : null;
}

const GONE = "That request no longer exists.";

/**
 * Sets the status from the staff controls, without posting a reply.
 *
 * `from` is the status the page showed, used as an optimistic lock: another
 * admin (or the cron) may have moved it between render and click, and
 * silently overwriting them is worse than saying so. Returns the updated
 * ticket, or null when the lock was lost — "someone else changed this; reload".
 * A database failure throws instead, so the two are never confused.
 *
 * Notify with announceResolved(updated) when `to` is 'resolved'.
 */
export async function setTicketStatus(args: {
  ticketId: string;
  from: TicketStatus;
  to: TicketStatus;
  outcome?: TicketOutcome | null;
  scope: SupportStaffScope;
}): Promise<SupportTicket | null> {
  requireManage(args.scope);
  if (args.from === args.to) return getTicketForStaff(args.ticketId, args.scope);
  return updateVisibleTicket(
    "setTicketStatus",
    args.ticketId,
    args.scope,
    { ...statusChangeFields(args.from, args.to, new Date().toISOString(), args.outcome) },
    (q) => q.eq("status", args.from),
  );
}

/**
 * The requester's "This is solved". Only from a live status
 * (canRequesterMarkSolved), conditional on the status the page showed.
 * Returns the updated ticket, or null when it wasn't live or something moved
 * it first. Caller authorized the ticket as its owner (or token holder).
 * No email: they did it themselves.
 */
export async function markTicketSolvedByRequester(
  ticket: Pick<SupportTicket, "id" | "status">,
): Promise<SupportTicket | null> {
  if (!canRequesterMarkSolved(ticket)) return null;
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("support_tickets")
    .update(statusChangeFields(ticket.status, "resolved", new Date().toISOString()))
    .eq("id", ticket.id)
    .eq("status", ticket.status)
    .select(TICKET_SELECT)
    .maybeSingle();
  if (error) throw dbFailure("markTicketSolvedByRequester", error);
  return data ? toTicket(data) : null;
}

export async function setTicketPriority(args: {
  ticketId: string;
  priority: TicketPriority;
  scope: SupportStaffScope;
}): Promise<SupportTicket> {
  const t = await updateVisibleTicket("setTicketPriority", args.ticketId, args.scope, {
    priority: args.priority,
  });
  if (!t) throw new Error(GONE);
  return t;
}

/**
 * Recategorises a ticket. Moving one INTO a confidential category makes it
 * confidential (so a staff member without support.sensitive loses sight of it
 * the moment they do); moving one out never clears the flag — that is a
 * deliberate act, setTicketSensitive, for someone who holds the key. Priority
 * is left alone.
 */
export async function setTicketCategory(args: {
  ticketId: string;
  category: TicketCategory;
  scope: SupportStaffScope;
}): Promise<SupportTicket> {
  const t = await updateVisibleTicket("setTicketCategory", args.ticketId, args.scope, {
    category: args.category,
    ...(isSensitiveCategory(args.category) ? { sensitive: true } : {}),
  });
  if (!t) throw new Error(GONE);
  return t;
}

/** Marks or unmarks a ticket confidential. Needs support.sensitive (or '*') as well as support.manage. */
export async function setTicketSensitive(args: {
  ticketId: string;
  sensitive: boolean;
  scope: SupportStaffScope;
}): Promise<SupportTicket> {
  if (!args.scope.canSeeSensitive) throw new Error("Forbidden");
  const t = await updateVisibleTicket("setTicketSensitive", args.ticketId, args.scope, {
    sensitive: args.sensitive,
  });
  if (!t) throw new Error(GONE);
  return t;
}

/**
 * Assigns (or, with null, unassigns) a ticket. The assignee must be someone
 * who can answer support requests — and, on a confidential ticket, someone who
 * can see it. Notify with announceAssigned().
 */
export async function assignTicket(args: {
  ticketId: string;
  assigneeId: string | null;
  scope: SupportStaffScope;
}): Promise<SupportTicket> {
  const ticket = await getTicketForStaff(args.ticketId, args.scope);
  if (!ticket) throw new Error(GONE);
  if (args.assigneeId) {
    const staff = await listAssignableStaff({ sensitive: ticket.sensitive });
    if (!staff.some((s) => s.id === args.assigneeId)) {
      throw new Error(
        ticket.sensitive
          ? "Assign it to someone who can see confidential concerns."
          : "Assign it to someone who can answer support requests.",
      );
    }
  }
  const t = await updateVisibleTicket("assignTicket", ticket.id, args.scope, {
    assigned_to: args.assigneeId,
  });
  if (!t) throw new Error(GONE);
  return t;
}

/**
 * Pins the ticket to a tuition payment, or (null) unlinks it. Only a payment
 * that belongs to the ticket's own account: the page offers a list and an
 * action takes whatever it is sent, and without this check an admin could be
 * induced to attach a stranger's payment, which the ticket page would then
 * render as though it were the requester's.
 */
export async function linkTicketPayment(args: {
  ticketId: string;
  paymentId: string | null;
  scope: SupportStaffScope;
}): Promise<SupportTicket> {
  const ticket = await getTicketForStaff(args.ticketId, args.scope);
  if (!ticket) throw new Error(GONE);
  if (args.paymentId) {
    if (!isUuid(args.paymentId)) throw new Error("That payment doesn't exist.");
    const admin = createAdminClient();
    const { data, error } = await admin
      .from("payments")
      .select("id, user_id")
      .eq("id", args.paymentId)
      .maybeSingle();
    if (error) throw dbFailure("linkTicketPayment", error);
    if (!data) throw new Error("That payment doesn't exist.");
    if (!ticket.userId || (data as any).user_id !== ticket.userId) {
      throw new Error(
        "That payment belongs to a different account, so it can't be attached to this request.",
      );
    }
  }
  const t = await updateVisibleTicket("linkTicketPayment", ticket.id, args.scope, {
    payment_id: args.paymentId,
  });
  if (!t) throw new Error(GONE);
  return t;
}

// ---------------------------------------------------------------------------
// The team
// ---------------------------------------------------------------------------

/**
 * Role slugs whose holders answer support requests: support.manage or '*' —
 * and, for a confidential ticket, support.sensitive as well (or '*').
 *
 * Derived from the role table rather than a hard-coded `role = 'admin'` list,
 * because roles are rows (migration 0048) and a custom "support" role granted
 * the key at /admin/roles must start receiving these without a deploy.
 * Mirrors listModeratorIds() in lib/dm.ts.
 */
async function supportRoleSlugs(opts: { sensitive: boolean }): Promise<{
  slugs: string[];
  sensitiveSlugs: Set<string>;
}> {
  const roles = await getAllRoles();
  const holds = (perms: readonly string[], p: string) => perms.includes("*") || perms.includes(p);
  const managers = roles.filter((r) => holds(r.permissions, "support.manage"));
  const sensitiveSlugs = new Set(
    managers.filter((r) => holds(r.permissions, "support.sensitive")).map((r) => r.slug),
  );
  const slugs = managers.map((r) => r.slug).filter((s) => !opts.sensitive || sensitiveSlugs.has(s));
  return { slugs, sensitiveSlugs };
}

/** Everyone who should hear about a ticket of this sensitivity. */
export async function listSupportTeamIds(opts: { sensitive?: boolean } = {}): Promise<string[]> {
  const { slugs } = await supportRoleSlugs({ sensitive: !!opts.sensitive });
  if (slugs.length === 0) return [];
  const admin = createAdminClient();
  const { data, error } = await admin.from("profiles").select("id").in("role", slugs).limit(500);
  if (error) console.error("[support] listSupportTeamIds", error.message);
  return (data ?? []).map((p: any) => p.id as string);
}

export type AssignableStaff = {
  id: string;
  name: string;
  /** Holds support.sensitive (or '*'): may be given a confidential concern. */
  canSeeSensitive: boolean;
};

/**
 * Who a ticket can be assigned to: support.manage holders (and '*'), with
 * names. `sensitive: true` narrows it to those who can also see confidential
 * concerns — pass the ticket's own flag.
 */
export async function listAssignableStaff(opts: { sensitive?: boolean } = {}): Promise<AssignableStaff[]> {
  const { slugs, sensitiveSlugs } = await supportRoleSlugs({ sensitive: !!opts.sensitive });
  if (slugs.length === 0) return [];
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("profiles")
    .select("id, full_name, email, role")
    .in("role", slugs)
    .order("full_name", { ascending: true })
    .limit(200);
  if (error) console.error("[support] listAssignableStaff", error.message);
  return (data ?? []).map((p: any) => ({
    id: p.id as string,
    name: (p.full_name as string | null)?.trim() || displayEmail(p.email) || "Unnamed",
    canSeeSensitive: sensitiveSlugs.has(p.role),
  }));
}

// ---------------------------------------------------------------------------
// The requester, for the team
// ---------------------------------------------------------------------------

export type TicketCharge = {
  id: string;
  kind: "fee" | "fine";
  description: string;
  amountCents: number;
  amountRefundedCents: number;
  status: string;
  createdAt: string;
  paidAt: string | null;
  receiptUrl: string | null;
};

export type TicketDemoDayTicket = {
  id: string;
  status: string;
  amountCents: number;
  amountRefundedCents: number;
  createdAt: string;
  paidAt: string | null;
  refundedAt: string | null;
  receiptUrl: string | null;
};

export type RequesterContext = {
  /** Null when the ticket has no account (logged for someone without one, or deleted). */
  profile: {
    id: string;
    fullName: string | null;
    /** Null for a placeholder address. */
    email: string | null;
    role: string;
    roleLabel: string;
    createdAt: string;
  } | null;
  /** Newest first. */
  applications: {
    id: string;
    status: string;
    cohortId: string | null;
    cohortName: string | null;
    submittedAt: string | null;
    createdAt: string;
  }[];
  /** The most recent enrolment, if any. */
  enrollment: {
    cohortId: string;
    cohortName: string | null;
    enrolledAt: string;
    startsOn: string | null;
    endsOn: string | null;
  } | null;
  /** Tuition, newest first, with paid time (for refundWindow) and receipt. */
  payments: TicketPayment[];
  /** Fees and fines. */
  charges: TicketCharge[];
  /** Matched by account or by the requester's email. */
  demoDayTickets: TicketDemoDayTicket[];
  /** This person's other tickets that this scope may see, newest first. */
  otherTickets: SupportTicketSummary[];
};

const PAYMENT_SELECT =
  "id, amount_cents, amount_refunded_cents, currency, status, paid_at, created_at, stripe_session_id, stripe_payment_intent_id, stripe_receipt_url";

function toPayment(row: any): TicketPayment {
  return {
    id: row.id,
    amountCents: row.amount_cents ?? 0,
    amountRefundedCents: row.amount_refunded_cents ?? 0,
    currency: row.currency ?? "usd",
    status: row.status,
    paidAt: row.paid_at ?? null,
    createdAt: row.created_at,
    stripeSessionId: row.stripe_session_id ?? null,
    stripePaymentIntentId: row.stripe_payment_intent_id ?? null,
    receiptUrl: row.stripe_receipt_url ?? null,
  };
}

/**
 * Everything the team needs beside a ticket to answer it without opening five
 * other pages: who they are, where their application stands, their enrolment,
 * every charge, and their other requests. Best-effort — a part that fails to
 * read comes back empty (and is logged) rather than failing the ticket page.
 *
 * The caller holds the ticket from getTicketForStaff(id, scope). Other tickets
 * are filtered by the same scope, so a confidential concern by the same person
 * is not even counted for someone who can't open it. Money is shown to every
 * support.view holder (the ticket is often about it); the links that act on
 * money are the page's to gate on payments.view / payments.manage.
 */
export async function getRequesterContext(
  ticket: Pick<SupportTicket, "id" | "userId" | "requesterEmail">,
  scope: SupportStaffScope,
): Promise<RequesterContext> {
  requireView(scope);
  const admin = createAdminClient();
  const uid = ticket.userId;
  const email = ticket.requesterEmail?.toLowerCase() ?? "";
  const none = Promise.resolve({ data: null, error: null } as { data: any; error: any });
  const byPerson = uid
    ? `user_id.eq.${uid}${isMailable(email) ? `,email.eq.${quoted(email)}` : ""}`
    : isMailable(email)
      ? `email.eq.${quoted(email)}`
      : null;
  const otherFilter = uid
    ? `user_id.eq.${uid}${isMailable(email) ? `,requester_email.eq.${quoted(email)}` : ""}`
    : isMailable(email)
      ? `requester_email.eq.${quoted(email)}`
      : null;

  const [roles, profile, apps, enrolments, payments, charges, demoDay, others] = await Promise.all([
    getAllRoles().catch(() => []),
    uid
      ? admin.from("profiles").select("id, full_name, email, role, created_at").eq("id", uid).maybeSingle()
      : none,
    uid
      ? admin
          .from("applications")
          .select("id, status, cohort_id, submitted_at, created_at, cohort:cohorts(name)")
          .eq("user_id", uid)
          .order("created_at", { ascending: false })
          .limit(5)
      : none,
    uid
      ? admin
          .from("enrollments")
          .select("cohort_id, enrolled_at, cohort:cohorts(name, starts_on, ends_on)")
          .eq("user_id", uid)
          .order("enrolled_at", { ascending: false })
          .limit(1)
      : none,
    uid
      ? admin
          .from("payments")
          .select(PAYMENT_SELECT)
          .eq("user_id", uid)
          .order("created_at", { ascending: false })
          .limit(20)
      : none,
    uid
      ? admin
          .from("user_charges")
          .select("id, kind, description, amount_cents, amount_refunded_cents, status, created_at, paid_at, stripe_receipt_url")
          .eq("user_id", uid)
          .order("created_at", { ascending: false })
          .limit(20)
      : none,
    byPerson
      ? admin
          .from("demo_day_tickets")
          .select("id, status, amount_cents, amount_refunded_cents, created_at, paid_at, refunded_at, stripe_receipt_url")
          .or(byPerson)
          .order("created_at", { ascending: false })
          .limit(10)
      : none,
    otherFilter
      ? visibleTo(
          admin.from("support_tickets").select(SUMMARY_SELECT).neq("id", ticket.id).or(otherFilter),
          scope,
        )
          .order("created_at", { ascending: false })
          .limit(20)
      : none,
  ]);

  for (const [what, r] of [
    ["profile", profile],
    ["applications", apps],
    ["enrollments", enrolments],
    ["payments", payments],
    ["charges", charges],
    ["demo day tickets", demoDay],
    ["other tickets", others],
  ] as const) {
    if ((r as any).error) console.error(`[support] getRequesterContext ${what}`, (r as any).error.message);
  }

  const p = (profile as any).data;
  const roleLabel = p ? (roles.find((r) => r.slug === p.role)?.label ?? p.role) : "";
  const enrolment = ((enrolments as any).data ?? [])[0];
  return {
    profile: p
      ? {
          id: p.id,
          fullName: p.full_name ?? null,
          email: displayEmail(p.email),
          role: p.role,
          roleLabel,
          createdAt: p.created_at,
        }
      : null,
    applications: ((apps as any).data ?? []).map((a: any) => ({
      id: a.id,
      status: a.status,
      cohortId: a.cohort_id ?? null,
      cohortName: one<any>(a.cohort)?.name ?? null,
      submittedAt: a.submitted_at ?? null,
      createdAt: a.created_at,
    })),
    enrollment: enrolment
      ? {
          cohortId: enrolment.cohort_id,
          cohortName: one<any>(enrolment.cohort)?.name ?? null,
          enrolledAt: enrolment.enrolled_at,
          startsOn: one<any>(enrolment.cohort)?.starts_on ?? null,
          endsOn: one<any>(enrolment.cohort)?.ends_on ?? null,
        }
      : null,
    payments: ((payments as any).data ?? []).map(toPayment),
    charges: ((charges as any).data ?? []).map((c: any) => ({
      id: c.id,
      kind: c.kind,
      description: c.description ?? "",
      amountCents: c.amount_cents ?? 0,
      amountRefundedCents: c.amount_refunded_cents ?? 0,
      status: c.status,
      createdAt: c.created_at,
      paidAt: c.paid_at ?? null,
      receiptUrl: c.stripe_receipt_url ?? null,
    })),
    demoDayTickets: ((demoDay as any).data ?? []).map((t: any) => ({
      id: t.id,
      status: t.status,
      amountCents: t.amount_cents ?? 0,
      amountRefundedCents: t.amount_refunded_cents ?? 0,
      createdAt: t.created_at,
      paidAt: t.paid_at ?? null,
      refundedAt: t.refunded_at ?? null,
      receiptUrl: t.stripe_receipt_url ?? null,
    })),
    otherTickets: ((others as any).data ?? []).map(toSummary),
  };
}

export type SupportHistoryEntry = {
  id: string;
  /** e.g. "support_ticket.replied", "support_ticket.auto_resolved". */
  action: string;
  /** Null for the system (the housekeeping cron). */
  actorId: string | null;
  actorName: string | null;
  payload: Record<string, unknown> | null;
  createdAt: string;
};

/**
 * What happened to a ticket, oldest first, from audit_log (every support
 * action logs with target_type 'support_ticket' and the ticket id). Caller
 * authorized the ticket with getTicketForStaff.
 */
export async function getTicketHistory(ticketId: string): Promise<SupportHistoryEntry[]> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("audit_log")
    .select("id, action, actor_id, payload, created_at")
    .eq("target_type", "support_ticket")
    .eq("target_id", ticketId)
    .order("created_at", { ascending: true })
    .limit(200);
  if (error) {
    console.error("[support] getTicketHistory", error.message);
    return [];
  }
  const ids = [...new Set((data ?? []).map((r: any) => r.actor_id).filter(Boolean))] as string[];
  const names = new Map<string, string | null>();
  if (ids.length > 0) {
    const { data: people } = await admin.from("profiles").select("id, full_name, email").in("id", ids);
    for (const p of (people ?? []) as any[]) {
      names.set(p.id, p.full_name?.trim() || displayEmail(p.email));
    }
  }
  return (data ?? []).map((r: any) => ({
    id: r.id,
    action: r.action,
    actorId: r.actor_id ?? null,
    actorName: r.actor_id ? (names.get(r.actor_id) ?? null) : null,
    payload: r.payload ?? null,
    createdAt: r.created_at,
  }));
}

/**
 * The tuition payment a refund or billing ticket is about, plus every payment
 * on the account so an admin can link, change or unlink it.
 *
 * Deliberately scoped to the ticket's own `user_id`. A pasted `cs_…` is
 * untrusted input, and resolving it globally would let anyone who files a
 * ticket and guesses — or simply mistypes — a session id read a stranger's
 * amount, currency, and receipt URL off the admin page as though it were
 * theirs. So: an explicit link wins; otherwise the identifier is matched only
 * among that account's payments. The raw string is always shown to the admin
 * regardless; it may be a PayPal transaction id, which this schema has no
 * concept of.
 */
export async function resolveTicketPayments(
  ticket: Pick<SupportTicket, "userId" | "receiptRef" | "paymentId">,
): Promise<{ matched: TicketPayment | null; candidates: TicketPayment[] }> {
  const admin = createAdminClient();
  const [linked, own] = await Promise.all([
    ticket.paymentId
      ? admin.from("payments").select(PAYMENT_SELECT).eq("id", ticket.paymentId).maybeSingle()
      : Promise.resolve({ data: null, error: null } as { data: any; error: any }),
    ticket.userId
      ? admin
          .from("payments")
          .select(PAYMENT_SELECT)
          .eq("user_id", ticket.userId)
          .order("created_at", { ascending: false })
          .limit(20)
      : Promise.resolve({ data: [], error: null } as { data: any; error: any }),
  ]);
  const candidates = ((own.data ?? []) as any[]).map(toPayment);
  if (linked.data) return { matched: toPayment(linked.data), candidates };

  const ref = ticket.receiptRef?.trim() ?? "";
  if (!ref) return { matched: null, candidates };
  // Both identifiers can appear anywhere in what was pasted — people paste
  // whole receipt URLs.
  const session = /cs_(?:test_|live_)?[A-Za-z0-9_]{8,220}/.exec(ref)?.[0];
  const intent = /pi_[A-Za-z0-9_]{8,220}/.exec(ref)?.[0];
  const matched =
    (session && candidates.find((p) => p.stripeSessionId === session)) ||
    (intent && candidates.find((p) => p.stripePaymentIntentId === intent)) ||
    null;
  return { matched: matched ?? null, candidates };
}

// ---------------------------------------------------------------------------
// Housekeeping — for the daily cron (no viewer; the cron is the system)
// ---------------------------------------------------------------------------

/**
 * Candidates for a housekeeping step: tickets in `status` whose `column` is
 * older than `before`, oldest first. Full tickets, because a resolved one is
 * announced (which needs its token for the email link).
 */
export async function listTicketsForHousekeeping(args: {
  status: TicketStatus;
  column: "status_changed_at" | "resolved_at" | "requester_activity_at";
  before: string;
  limit?: number;
}): Promise<SupportTicket[]> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("support_tickets")
    .select(TICKET_SELECT)
    .eq("status", args.status)
    .lt(args.column, args.before)
    .order(args.column, { ascending: true })
    .limit(Math.min(args.limit ?? 200, 500));
  if (error) throw systemFailure("listTicketsForHousekeeping", error);
  return (data ?? []).map(toTicket);
}

/**
 * Moves every ticket in `ids` that is STILL in `from` to `to`, and returns the
 * ones this call actually moved — the conditional update is the claim, so two
 * overlapping cron runs can't both act on the same ticket, and a ticket a
 * person touched in between is left alone. The bookkeeping is
 * statusChangeFields(), exactly as for a person.
 */
export async function transitionTickets(args: {
  ids: string[];
  from: TicketStatus;
  to: TicketStatus;
  outcome?: TicketOutcome | null;
}): Promise<SupportTicket[]> {
  const ids = args.ids.filter(isUuid);
  if (ids.length === 0 || args.from === args.to) return [];
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("support_tickets")
    .update(statusChangeFields(args.from, args.to, new Date().toISOString(), args.outcome))
    .in("id", ids)
    .eq("status", args.from)
    .select(TICKET_SELECT);
  if (error) throw systemFailure("transitionTickets", error);
  return (data ?? []).map(toTicket);
}

/**
 * Tickets needing a reply that are past their reply target at `now`, most
 * overdue first — confidential ones included (the digest shows them by
 * reference only).
 */
export async function listOverdueTickets(
  now: number = Date.now(),
  limit = 100,
): Promise<SupportTicketSummary[]> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("support_tickets")
    .select(SUMMARY_SELECT)
    .eq("needs_reply", true)
    .order("requester_activity_at", { ascending: true })
    .limit(NEEDS_REPLY_SCAN);
  if (error) throw systemFailure("listOverdueTickets", error);
  return (data ?? [])
    .map(toSummary)
    .filter((t) => slaState(t, now) === "overdue")
    .sort(byDueTime)
    .slice(0, limit);
}

// ---------------------------------------------------------------------------
// Notifications
//
// Every write surface calls into here, so "who hears about what" is decided
// once. Everything in this section is best-effort: a mail or bell failure must
// never fail the write it reports on, because the ticket existing matters more
// than the email about it. Each block owns a try/catch and logs.
//
// Two rules hold throughout:
//   * Bells carry RELATIVE links and never a token link — the notifications
//     table is readable by every '*' admin, so a /support/t/<token> there would
//     be a bearer secret in a shared table.
//   * A confidential concern's bells and team emails carry no content: no
//     subject, no body, no name — only that one exists and where to open it.
// ---------------------------------------------------------------------------

/**
 * The team inbox: the contact address an admin set in site settings, falling
 * back to the env default — never a placeholder. Null when there's nowhere
 * real to send.
 */
export async function supportInboxAddress(): Promise<string | null> {
  let address: string | null = null;
  try {
    address = (await getPublicSiteConfig()).settings.contactEmail?.trim() || null;
  } catch (err) {
    console.error("[support] site config unavailable for the team inbox", err);
  }
  address = address || env.contactEmail;
  return isMailable(address) ? address : null;
}

export type AnnounceNewTicketResult = {
  /** The requester's receipt actually went out. Say "we emailed you" only when true. */
  requesterEmailed: boolean;
  teamEmailed: boolean;
};

/**
 * Everything that should happen when a ticket is filed or logged: the
 * requester's receipt, the team's email, and the bell.
 *
 * `notifyRequester: false` is for a staff-logged ticket where the team chose
 * not to send the confirmation. The receipt is never sent to a placeholder
 * address. Bells go to support.manage holders (and '*') — for a confidential
 * concern, only those who also hold support.sensitive — and never to the
 * requester themselves or to the staff member who logged it.
 */
export async function announceNewTicket(
  ticket: SupportTicket,
  opts: { notifyRequester?: boolean } = {},
): Promise<AnnounceNewTicketResult> {
  const result: AnnounceNewTicketResult = { requesterEmailed: false, teamEmailed: false };
  const categoryLabel = CATEGORY_LABELS[ticket.category];
  const receivedAt = formatReceivedAt(ticket.receivedAt);
  const staffLogged = !!ticket.createdBy;

  // 1. The requester's receipt. The most important email in the feature.
  if (opts.notifyRequester !== false && isMailable(ticket.requesterEmail)) {
    try {
      const fullName = requesterNameOf(ticket);
      const input: SupportReceivedEmail = {
        name: firstNameOf(fullName),
        reference: ticket.reference,
        category: ticket.category,
        categoryLabel,
        channel: ticket.channel,
        staffLogged,
        subject: ticket.subject,
        body: ticket.body,
        receivedAt,
        threadUrl: ticketUrl(ticket.token),
      };
      const sent = await sendTemplated(SUPPORT_RECEIVED_TEMPLATE, {
        to: ticket.requesterEmail,
        toName: fullName,
        userId: ticket.userId,
        vars: supportReceivedVars(input),
        fallback: () => Templates.supportTicketReceived(input),
      });
      result.requesterEmailed = sent.ok;
      if (!sent.ok) console.error("[support] requester receipt not sent", ticket.reference, sent.reason);
    } catch (err) {
      console.error("[support] requester receipt failed", err);
    }
  }

  // 2. The team's inbox. No replyTo the requester: answering from the inbox
  // would take the conversation off the thread, and the thread is the record.
  try {
    const inbox = await supportInboxAddress();
    if (inbox) {
      const adminUrl = adminTicketUrl(ticket.id);
      let sent: Awaited<ReturnType<typeof sendTemplated>>;
      if (ticket.sensitive) {
        const input = { reference: ticket.reference, adminUrl };
        sent = await sendTemplated(SUPPORT_CONCERN_INTERNAL_TEMPLATE, {
          to: inbox,
          toName: "batch0 team",
          userId: null,
          vars: supportConcernInternalVars(input),
          fallback: () => Templates.supportConcernInternal(input),
        });
      } else {
        const input: SupportInternalEmail = {
          reference: ticket.reference,
          category: ticket.category,
          categoryLabel,
          priorityLabel: PRIORITY_LABELS[ticket.priority],
          subject: ticket.subject,
          requesterLabel: requesterLabel(ticket),
          receivedAt,
          adminUrl,
          channel: ticket.channel,
          staffLogged,
          loggedBy: ticket.createdByName,
        };
        sent = await sendTemplated(SUPPORT_INTERNAL_TEMPLATE, {
          to: inbox,
          toName: "batch0 team",
          userId: null,
          vars: supportInternalVars(input),
          fallback: () => Templates.supportTicketInternal(input),
        });
      }
      result.teamEmailed = sent.ok;
      if (!sent.ok) console.error("[support] team email not sent", ticket.reference, sent.reason);
    }
  } catch (err) {
    console.error("[support] team email failed", err);
  }

  // 3. The bell, for everyone who can work it. The title is all most people
  // read in a notification list, so it says what kind of request it is.
  try {
    const recipients = (await listSupportTeamIds({ sensitive: ticket.sensitive })).filter(
      (uid) => uid !== ticket.userId && uid !== ticket.createdBy,
    );
    const title = ticket.sensitive
      ? `Confidential concern — ${ticket.reference}`
      : ticket.priority === "urgent"
        ? `Urgent: ${categoryLabel} — ${ticket.reference}`
        : `${categoryLabel} — ${ticket.reference}`;
    await notifyMany(
      recipients.map((uid) => ({
        userId: uid,
        type: "support_ticket",
        title,
        body: ticket.sensitive ? null : ticket.subject.slice(0, 200),
        link: adminTicketPath(ticket.id),
        dedupeKey: `support:new:${ticket.id}`,
      })),
    );
  } catch (err) {
    console.error("[support] team bell failed", err);
  }

  return result;
}

/**
 * The requester posted a follow-up: bell whoever owns the ticket — the
 * assignee if there is one who can still work it, else the team. No email to
 * the team on a follow-up: the queue and the bell are the working surface, and
 * a second mail per message would train people to filter the first one.
 */
export async function announceRequesterReply(
  ticket: Pick<SupportTicket, "id" | "reference" | "userId" | "assignedTo" | "sensitive">,
  reply: { id: string; body: string },
): Promise<void> {
  try {
    const team = await listSupportTeamIds({ sensitive: ticket.sensitive });
    const recipients = (
      ticket.assignedTo && team.includes(ticket.assignedTo) ? [ticket.assignedTo] : team
    ).filter((uid) => uid !== ticket.userId);
    await notifyMany(
      recipients.map((uid) => ({
        userId: uid,
        type: "support_reply",
        title: ticket.sensitive
          ? `Follow-up on a confidential concern — ${ticket.reference}`
          : `Follow-up on ${ticket.reference}`,
        body: ticket.sensitive ? null : excerpt(reply.body, 200),
        link: adminTicketPath(ticket.id),
        // Keyed on the reply: every follow-up is worth a bell, and a retried
        // action still produces exactly one per message.
        dedupeKey: `support:reply:${reply.id}`,
      })),
    );
  } catch (err) {
    console.error("[support] requester reply bell failed", err);
  }
}

/**
 * The team replied publicly: email the requester (claimed first, released if
 * the send fails so a retry can deliver it) and bell them if they have an
 * account. `resolved` for a "Send & resolve" — the one email says both
 * things, so don't also call announceResolved for it.
 */
export async function announceStaffReply(args: {
  ticket: SupportTicket;
  replyId: string;
  body: string;
  replierName: string;
  resolved?: boolean;
}): Promise<{ emailed: boolean }> {
  const t = args.ticket;
  let emailed = false;
  if (isMailable(t.requesterEmail)) {
    try {
      if (await claimReplyNotification(args.replyId)) {
        const fullName = requesterNameOf(t);
        const input = {
          name: firstNameOf(fullName),
          reference: t.reference,
          subject: t.subject,
          replierName: args.replierName,
          reply: args.body,
          threadUrl: ticketUrl(t.token),
          resolved: !!args.resolved,
        };
        const sent = await sendTemplated(SUPPORT_REPLIED_TEMPLATE, {
          to: t.requesterEmail,
          toName: fullName,
          userId: t.userId,
          vars: supportRepliedVars(input),
          fallback: () => Templates.supportTicketReplied(input),
        });
        emailed = sent.ok;
        if (!sent.ok) {
          console.error("[support] staff reply email not sent", t.reference, sent.reason);
          await releaseReplyNotification(args.replyId);
        }
      }
    } catch (err) {
      console.error("[support] staff reply email failed", err);
      await releaseReplyNotification(args.replyId);
    }
  }

  if (t.userId) {
    try {
      await notifyMany([
        {
          userId: t.userId,
          type: "support_staff_reply",
          title: args.resolved
            ? `The batch0 team replied and resolved ${t.reference}`
            : `The batch0 team replied — ${t.reference}`,
          body: t.sensitive ? "Open your request to read it." : excerpt(args.body),
          link: requesterThreadPath(t.reference),
          dedupeKey: `support:staff_reply:${args.replyId}`,
        },
      ]);
    } catch (err) {
      console.error("[support] staff reply bell failed", err);
    }
  }
  return { emailed };
}

/**
 * Marked resolved without a reply — by the team (with an optional note) or by
 * the housekeeping cron (`auto`). Tells the requester, and how to reopen.
 * Pass the ticket as it is AFTER the change (setTicketStatus and
 * transitionTickets return it): the bell is keyed on its resolution time, so a
 * ticket resolved, reopened and resolved again announces twice, and a retried
 * action once.
 */
export async function announceResolved(
  ticket: SupportTicket,
  opts: { note?: string | null; auto?: boolean } = {},
): Promise<{ emailed: boolean }> {
  let emailed = false;
  const note = opts.note?.trim() || null;
  if (isMailable(ticket.requesterEmail)) {
    try {
      const fullName = requesterNameOf(ticket);
      const input = {
        name: firstNameOf(fullName),
        reference: ticket.reference,
        subject: ticket.subject,
        threadUrl: ticketUrl(ticket.token),
        note,
        auto: !!opts.auto,
      };
      const sent = await sendTemplated(SUPPORT_RESOLVED_TEMPLATE, {
        to: ticket.requesterEmail,
        toName: fullName,
        userId: ticket.userId,
        vars: supportResolvedVars(input),
        fallback: () => Templates.supportTicketResolved(input),
      });
      emailed = sent.ok;
      if (!sent.ok) console.error("[support] resolved email not sent", ticket.reference, sent.reason);
    } catch (err) {
      console.error("[support] resolved email failed", err);
    }
  }

  if (ticket.userId) {
    try {
      await notifyMany([
        {
          userId: ticket.userId,
          type: "support_resolved",
          title: `Your request ${ticket.reference} was resolved`,
          body: opts.auto
            ? AUTO_RESOLVE_NOTE
            : note && !ticket.sensitive
              ? excerpt(note)
              : "Reply on the thread if it isn't sorted — that reopens it.",
          link: requesterThreadPath(ticket.reference),
          dedupeKey: `support:resolved:${ticket.id}:${ticket.resolvedAt ?? ticket.statusChangedAt}`,
        },
      ]);
    } catch (err) {
      console.error("[support] resolved bell failed", err);
    }
  }
  return { emailed };
}

/**
 * Someone was given a ticket: bell them, unless they assigned it to
 * themselves. One bell per ticket per assignee, however often it bounces.
 */
export async function announceAssigned(args: {
  ticket: Pick<SupportTicket, "id" | "reference" | "subject" | "sensitive">;
  assigneeId: string | null;
  actorId: string;
}): Promise<void> {
  const { ticket, assigneeId } = args;
  if (!assigneeId || assigneeId === args.actorId) return;
  try {
    const bell: NotifyArgs = {
      userId: assigneeId,
      type: "support_assigned",
      title: ticket.sensitive
        ? `A confidential concern was assigned to you — ${ticket.reference}`
        : `Assigned to you — ${ticket.reference}`,
      body: ticket.sensitive ? null : ticket.subject.slice(0, 200),
      link: adminTicketPath(ticket.id),
      dedupeKey: `support:assigned:${ticket.id}:${assigneeId}`,
    };
    await notifyMany([bell]);
  } catch (err) {
    console.error("[support] assignment bell failed", err);
  }
}

/**
 * The daily digest of tickets past their reply target (listOverdueTickets),
 * to the team inbox. Sends nothing for an empty list. Confidential concerns
 * appear as their reference and wait only.
 */
export async function announceOverdueDigest(
  tickets: SupportTicketSummary[],
  now: number = Date.now(),
): Promise<{ sent: boolean; count: number }> {
  if (tickets.length === 0) return { sent: false, count: 0 };
  try {
    const inbox = await supportInboxAddress();
    if (!inbox) return { sent: false, count: tickets.length };
    const items: SupportDigestItem[] = tickets.map((t) => {
      const due = Date.parse(slaDueAt(t) ?? t.requesterActivityAt);
      return {
        reference: t.reference,
        sensitive: t.sensitive,
        priorityLabel: PRIORITY_LABELS[t.priority],
        categoryLabel: CATEGORY_LABELS[t.category],
        subject: t.subject,
        waitingFor: formatElapsed(now - Date.parse(t.requesterActivityAt)),
        overdueBy: formatElapsed(now - due),
        adminUrl: adminTicketUrl(t.id),
      };
    });
    const input = {
      items,
      asOf: formatReceivedAt(new Date(now).toISOString()),
      queueUrl: `${env.siteUrl}/admin/support`,
    };
    const sent = await sendTemplated(SUPPORT_OVERDUE_DIGEST_TEMPLATE, {
      to: inbox,
      toName: "batch0 team",
      userId: null,
      vars: supportDigestVars(input),
      fallback: () => Templates.supportOverdueDigest(input),
    });
    if (!sent.ok) console.error("[support] overdue digest not sent", sent.reason);
    return { sent: sent.ok, count: tickets.length };
  } catch (err) {
    console.error("[support] overdue digest failed", err);
    return { sent: false, count: tickets.length };
  }
}
