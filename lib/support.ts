import "server-only";
import { randomBytes } from "node:crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import { getAllRoles } from "@/lib/roles";
import { env } from "@/lib/env";
import { sendTemplated } from "@/lib/email/dispatch";
import { Templates } from "@/lib/email/templates";
import { notifyMany } from "@/lib/notifications";
import { getPublicSiteConfig } from "@/lib/site-config";
import {
  CATEGORY_LABELS,
  REFERENCE_ALPHABET,
  REQUESTER_NAME_MAX,
  formatReceivedAt,
  isTicketToken,
  needsReplyFor,
  statusAfterRequesterReply,
  statusAfterStaffReply,
  type TicketCategory,
  type TicketStatus,
} from "@/lib/support-access";

/**
 * Reads and writes for support tickets (migration 0090).
 *
 * Service-role throughout, with explicit filters on every read — the same
 * shape as lib/discussions.ts and lib/interview-requests.ts. RLS is the
 * backstop and never the thing that saves us, and here it *can't* be: the
 * requester's own thread page authorizes on a bearer token, so there is no
 * auth.uid() for a policy to key off at all. Every function below either takes
 * the token or takes a userId, and filters on it.
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

// ---------------------------------------------------------------------------
// Template keys
//
// Exported as named constants rather than written inline at the call site, so
// the string the seed inserts and the string the sender looks up cannot drift.
// Precedent: SCHOLARSHIP_RECEIVED_TEMPLATE in lib/scholarships.ts.
// ---------------------------------------------------------------------------

// Re-exported so the pages that render a ticket have one import path for
// everything about it. The definition lives in lib/support-access.ts because
// that module has no imports and is therefore the only one a test can reach.
export { formatReceivedAt };

export const SUPPORT_RECEIVED_TEMPLATE = "support.ticket_received";
export const SUPPORT_REPLIED_TEMPLATE = "support.ticket_replied";
export const SUPPORT_RESOLVED_TEMPLATE = "support.ticket_resolved";
export const SUPPORT_INTERNAL_TEMPLATE = "support.ticket_received_internal";

// ---------------------------------------------------------------------------
// Row types
// ---------------------------------------------------------------------------

export type SupportTicket = {
  id: string;
  reference: string;
  /** The bearer capability for /support/t/<token>. Never render it in a title. */
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
  receiptRef: string | null;
  paymentId: string | null;
  assignedTo: string | null;
  assignedName: string | null;
  replyCount: number;
  lastActivityAt: string;
  resolvedAt: string | null;
  createdAt: string;
};

export type SupportReply = {
  id: string;
  ticketId: string;
  authorId: string | null;
  authorName: string;
  /** Admin surfaces only — see forRequester(). */
  authorEmail: string;
  body: string;
  isStaff: boolean;
  isInternal: boolean;
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

const TICKET_SELECT = `
  id, reference, token, user_id, requester_email, requester_name, category,
  subject, body, status, needs_reply, receipt_ref, payment_id, assigned_to,
  reply_count, last_activity_at, resolved_at, created_at,
  account:profiles!support_tickets_user_id_fkey(full_name),
  assignee:profiles!support_tickets_assigned_to_fkey(full_name)
`;

const REPLY_SELECT = `
  id, ticket_id, author_id, body, is_staff, is_internal, created_at,
  author:profiles!support_ticket_replies_author_id_fkey(full_name, email)
`;

function one<T>(v: T | T[] | null | undefined): T | null {
  return Array.isArray(v) ? (v[0] ?? null) : (v ?? null);
}

/**
 * A name to show on a reply. "The batch0 team" rather than a person's name is
 * the fallback for staff, because an unnamed reply from support should read as
 * institutional, not anonymous.
 */
function replyName(p: { full_name?: string | null } | null, isStaff: boolean): string {
  const named = p?.full_name?.trim();
  if (named) return named;
  return isStaff ? "The batch0 team" : "You";
}

function toTicket(row: any): SupportTicket {
  const account = one<any>(row.account);
  const assignee = one<any>(row.assignee);
  return {
    id: row.id,
    reference: row.reference,
    token: row.token,
    userId: row.user_id,
    requesterEmail: row.requester_email ?? "",
    requesterName: row.requester_name ?? null,
    accountName: account?.full_name ?? null,
    category: row.category,
    subject: row.subject,
    body: row.body,
    status: row.status,
    needsReply: !!row.needs_reply,
    receiptRef: row.receipt_ref ?? null,
    paymentId: row.payment_id ?? null,
    assignedTo: row.assigned_to ?? null,
    assignedName: assignee?.full_name ?? null,
    replyCount: row.reply_count ?? 0,
    lastActivityAt: row.last_activity_at,
    resolvedAt: row.resolved_at ?? null,
    createdAt: row.created_at,
  };
}

function toReply(row: any): SupportReply {
  const author = one<any>(row.author);
  const isStaff = !!row.is_staff;
  return {
    id: row.id,
    ticketId: row.ticket_id,
    authorId: row.author_id ?? null,
    authorName: replyName(author, isStaff),
    authorEmail: author?.email ?? "",
    body: row.body,
    isStaff,
    isInternal: !!row.is_internal,
    createdAt: row.created_at,
  };
}

/**
 * Strips everything a requester must not receive, at the type level.
 *
 * `token` is in here as well as the email addresses: the thread page already
 * has the token in its URL, and putting it into a component's props is how it
 * ends up in a server-rendered payload, a client-side router cache, or an
 * error report. The Omit is what makes forgetting impossible — a component
 * typed on the scrubbed shape cannot read the fields at all.
 */
export function forRequester<
  T extends { requesterEmail?: string; authorEmail?: string; token?: string },
>(x: T): Omit<T, "requesterEmail" | "authorEmail" | "token"> {
  const {
    requesterEmail: _e,
    authorEmail: _a,
    token: _t,
    ...rest
  } = x;
  return rest;
}

/**
 * The shapes the requester-facing components are typed on. Spelled out rather
 * than derived through an instantiation expression so the omitted keys are
 * readable at a glance — these two lines are the privacy contract.
 */
export type RequesterTicket = Omit<SupportTicket, "requesterEmail" | "token">;
export type RequesterReply = Omit<SupportReply, "authorEmail">;

// ---------------------------------------------------------------------------
// Identifiers
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

/** The requester-facing thread URL. Absolute, because it goes in email. */
export function ticketUrl(token: string): string {
  return `${env.siteUrl}/support/t/${token}`;
}

/** The staff-facing URL. Also absolute — it goes in the team's notification. */
export function adminTicketUrl(id: string): string {
  return `${env.siteUrl}/admin/support/${id}`;
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/**
 * The `resolved_at` half of a status change, as a partial update.
 *
 * Returns an empty object when the transition doesn't cross the resolved
 * boundary, so the column is left alone rather than rewritten — see the call
 * site in appendReply for why that matters.
 */
function resolvedAtPatch(
  from: TicketStatus,
  to: TicketStatus,
): { resolved_at?: string | null } {
  const was = from === "resolved";
  const is = to === "resolved";
  if (was === is) return {};
  return { resolved_at: is ? new Date().toISOString() : null };
}

export type NewTicket = {
  userId: string | null;
  email: string;
  name: string | null;
  category: TicketCategory;
  subject: string;
  body: string;
  receiptRef: string | null;
};

/**
 * Files a ticket and returns it. Throws with a human sentence on failure, so
 * the calling action's runAction() wrapper surfaces it.
 *
 * Retries on a unique-constraint collision (Postgres 23505). Both `reference`
 * and `token` are random and unique, and while a token collision is not going
 * to happen, the reference is only 8 symbols from a 30-symbol alphabet — about
 * 6.6e11 values. That is ample for the volume here, but it is a birthday
 * problem rather than an impossibility, and the cost of handling it is this
 * loop. Retrying with fresh values is correct for either column.
 */
export async function createTicket(input: NewTicket): Promise<SupportTicket> {
  const admin = createAdminClient();
  const email = input.email.trim().toLowerCase();

  for (let attempt = 0; attempt < 5; attempt++) {
    const { data, error } = await admin
      .from("support_tickets")
      .insert({
        reference: mintReference(),
        token: mintToken(),
        user_id: input.userId,
        requester_email: email,
        // Truncated, not passed through: the column is capped at 120 and a
        // profile's full_name has no such limit, so an over-long name would
        // fail the insert with a Postgres error rather than a form message —
        // and would do it on every attempt, locking that account out of the
        // form entirely.
        requester_name: input.name?.slice(0, REQUESTER_NAME_MAX) ?? null,
        category: input.category,
        subject: input.subject,
        body: input.body,
        receipt_ref: input.receiptRef,
        // A brand-new ticket is by definition waiting on us. Stated rather
        // than left to the column default so the intent is visible here too.
        needs_reply: true,
      })
      .select(TICKET_SELECT)
      .single();

    if (!error && data) return toTicket(data);
    if (error?.code !== "23505") {
      throw new Error(
        error?.message ?? "The request could not be filed. Try again.",
      );
    }
  }
  throw new Error("The request could not be filed. Try again.");
}

/**
 * Appends a message and moves the ticket's bookkeeping in one place.
 *
 * `isStaff` and `isInternal` are arguments rather than anything read off a
 * request, and both callers derive them from the credential that was actually
 * presented — a support.manage assertion, or possession of the token. The
 * token path hard-codes both to false.
 *
 * The status transition is the pure function from lib/support-access.ts, so
 * "a follow-up reopens a resolved ticket" is stated once and testable.
 */
export async function appendReply(args: {
  ticket: Pick<SupportTicket, "id" | "status">;
  body: string;
  isStaff: boolean;
  isInternal?: boolean;
  authorId: string | null;
  /** Staff may set the resulting status explicitly instead of the default. */
  status?: TicketStatus;
}): Promise<SupportReply> {
  const admin = createAdminClient();
  const isInternal = args.isInternal === true;

  const { data, error } = await admin
    .from("support_ticket_replies")
    .insert({
      ticket_id: args.ticket.id,
      author_id: args.authorId,
      is_staff: args.isStaff,
      is_internal: isInternal,
      body: args.body,
    })
    .select(REPLY_SELECT)
    .single();
  if (error || !data) {
    throw new Error(error?.message ?? "The reply could not be saved.");
  }

  // An internal note is not a message to anyone — it must not clear the queue
  // flag, must not change the status, and must not look like an answer. The
  // trigger still bumps last_activity_at, which is right: someone did work.
  if (!isInternal) {
    const status =
      args.status ??
      (args.isStaff
        ? statusAfterStaffReply(args.ticket)
        : statusAfterRequesterReply(args.ticket));
    await admin
      .from("support_tickets")
      .update({
        // The team's reply clears the flag; the requester's follow-up raises
        // it again. This is the whole queue state machine.
        needs_reply: needsReplyFor(args.isStaff),
        status,
        // Only written when the resolved-ness actually changes. Stamping it on
        // every reply would move the resolution date forward each time someone
        // adds a note to a finished ticket, and that date is the answer to
        // "how long did this take" — the one number a support queue is judged
        // on. Left untouched when a resolved ticket stays resolved.
        ...resolvedAtPatch(args.ticket.status, status),
      })
      .eq("id", args.ticket.id);
  }

  return toReply(data);
}

/**
 * Claims the notification for a reply, returning true exactly once.
 *
 * `.is("notified_at", null)` is the lock, not decoration: a retried server
 * action or a double-clicked Send would otherwise mail the same reply twice,
 * and `dedupeKey` on the direct sendTemplated() path is inert — only the
 * queued path honours the outbox's unique index. Claim first, then send; a
 * send that fails after this returns true is a lost email rather than a
 * duplicate, which is the better failure of the two.
 */
export async function claimReplyNotification(replyId: string): Promise<boolean> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("support_ticket_replies")
    .update({ notified_at: new Date().toISOString() })
    .eq("id", replyId)
    .is("notified_at", null)
    .select("id");
  return (data ?? []).length > 0;
}

/**
 * Sets status directly (the admin's status control), without posting a reply.
 *
 * Takes the status it expects to be replacing and uses it as an optimistic
 * lock: another admin may have resolved this between the page render and the
 * click, and silently overwriting them is worse than saying so.
 */
export async function setTicketStatus(args: {
  ticketId: string;
  from: TicketStatus;
  to: TicketStatus;
}): Promise<boolean> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("support_tickets")
    .update({
      status: args.to,
      ...resolvedAtPatch(args.from, args.to),
      // Resolving or closing takes it out of the queue. Reopening puts it
      // back, because an open ticket nobody owes an answer to is invisible.
      needs_reply: args.to === "open",
    })
    .eq("id", args.ticketId)
    .eq("status", args.from)
    .select("id");
  return (data ?? []).length > 0;
}

export async function assignTicket(
  ticketId: string,
  assigneeId: string | null,
): Promise<void> {
  const admin = createAdminClient();
  const { error } = await admin
    .from("support_tickets")
    .update({ assigned_to: assigneeId })
    .eq("id", ticketId);
  if (error) throw new Error(error.message);
}

export async function linkTicketPayment(
  ticketId: string,
  paymentId: string | null,
): Promise<void> {
  const admin = createAdminClient();
  const { error } = await admin
    .from("support_tickets")
    .update({ payment_id: paymentId })
    .eq("id", ticketId);
  if (error) throw new Error(error.message);
}

// ---------------------------------------------------------------------------
// Reads — requester
// ---------------------------------------------------------------------------

/**
 * One ticket by its bearer token, or null.
 *
 * The token shape is checked before the round trip so a malformed URL costs
 * nothing and tells a prober nothing. "No such ticket" and "not yours" are the
 * same answer by construction: there is no second credential to be wrong
 * about — holding the token IS the authorization, exactly as in
 * lib/demo-day-tickets.ts.
 */
export async function getTicketByToken(
  token: string,
): Promise<SupportTicket | null> {
  if (!isTicketToken(token)) return null;
  const admin = createAdminClient();
  const { data } = await admin
    .from("support_tickets")
    .select(TICKET_SELECT)
    .eq("token", token)
    .maybeSingle();
  return data ? toTicket(data) : null;
}

/** "My requests" at /dashboard/support. Scoped on the signed-in user. */
export async function listTicketsForUser(
  userId: string,
): Promise<SupportTicket[]> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("support_tickets")
    .select(TICKET_SELECT)
    .eq("user_id", userId)
    .order("last_activity_at", { ascending: false })
    .limit(100);
  return (data ?? []).map(toTicket);
}

// ---------------------------------------------------------------------------
// Reads — staff
// ---------------------------------------------------------------------------

/** One ticket for an admin. Callers hold support.view. */
export async function getTicketForStaff(
  id: string,
): Promise<SupportTicket | null> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("support_tickets")
    .select(TICKET_SELECT)
    .eq("id", id)
    .maybeSingle();
  return data ? toTicket(data) : null;
}

/**
 * Messages in posting order.
 *
 * `includeInternal` defaults to false so the safe answer is the one you get by
 * forgetting the argument. Only the admin detail page passes true.
 */
export async function listTicketReplies(
  ticketId: string,
  opts: { includeInternal?: boolean } = {},
): Promise<SupportReply[]> {
  const admin = createAdminClient();
  let q = admin
    .from("support_ticket_replies")
    .select(REPLY_SELECT)
    .eq("ticket_id", ticketId);
  if (opts.includeInternal !== true) q = q.eq("is_internal", false);
  const { data } = await q.order("created_at", { ascending: true }).limit(500);
  return (data ?? []).map(toReply);
}

export const SUPPORT_PAGE_LIMIT = 200;

export type StaffTicketFilter = {
  /** null = the default queue view (anything still waiting on us). */
  status?: TicketStatus | null;
  needsReply?: boolean;
  category?: TicketCategory | null;
  limit?: number;
};

export async function listTicketsForStaff(
  f: StaffTicketFilter = {},
): Promise<{ tickets: SupportTicket[]; error: { message: string; code?: string } | null }> {
  const admin = createAdminClient();
  let q = admin.from("support_tickets").select(TICKET_SELECT);
  if (f.status) q = q.eq("status", f.status);
  if (f.needsReply != null) q = q.eq("needs_reply", f.needsReply);
  if (f.category) q = q.eq("category", f.category);

  // Oldest activity first when we owe someone an answer: the person who has
  // been waiting longest belongs at the top of a work queue. Every other view
  // is a browse, so it reads newest-first like the rest of the admin panel.
  const oldestFirst = f.needsReply === true;
  const { data, error } = await q
    .order("last_activity_at", { ascending: oldestFirst })
    .limit(f.limit ?? SUPPORT_PAGE_LIMIT);

  return {
    tickets: (data ?? []).map(toTicket),
    error: error ? { message: error.message, code: (error as any).code } : null,
  };
}

/** Status counts for the filter chips. Its own skinny scan, never derived
 *  from the visible page — a filtered 200-row list would report the filter
 *  back to itself. */
export async function countTicketsByStatus(): Promise<
  Record<TicketStatus | "needs_reply", number>
> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("support_tickets")
    .select("status, needs_reply")
    .limit(5000);
  const out: Record<string, number> = {
    open: 0,
    waiting_on_requester: 0,
    resolved: 0,
    closed: 0,
    needs_reply: 0,
  };
  for (const row of (data ?? []) as any[]) {
    if (row.status in out) out[row.status] += 1;
    if (row.needs_reply) out.needs_reply += 1;
  }
  return out as Record<TicketStatus | "needs_reply", number>;
}

/** The admin overview tile and the sidebar badge. Head-only — no rows. */
export async function countTicketsNeedingReply(): Promise<number> {
  const admin = createAdminClient();
  const { count } = await admin
    .from("support_tickets")
    .select("id", { count: "exact", head: true })
    .eq("needs_reply", true);
  return count ?? 0;
}

/**
 * Everyone who should hear about a new ticket: holders of support.manage,
 * plus every '*' role.
 *
 * Derived from the role table rather than a hard-coded `role = 'admin'` list,
 * because roles are rows (migration 0048) and a custom "support" role granted
 * the key at /admin/roles must start receiving these without a deploy.
 * Mirrors listDiscussionTeamIds().
 */
export async function listSupportTeamIds(): Promise<string[]> {
  const roles = await getAllRoles();
  const slugs = roles
    .filter(
      (r) => r.permissions.includes("*") || r.permissions.includes("support.manage"),
    )
    .map((r) => r.slug);
  if (slugs.length === 0) return [];

  const admin = createAdminClient();
  const { data } = await admin
    .from("profiles")
    .select("id")
    .in("role", slugs)
    .limit(500);
  return (data ?? []).map((p: any) => p.id as string);
}

/** Staff who can be assigned a ticket — same set, with names to show. */
export async function listAssignableStaff(): Promise<
  { id: string; name: string }[]
> {
  const roles = await getAllRoles();
  const slugs = roles
    .filter(
      (r) => r.permissions.includes("*") || r.permissions.includes("support.manage"),
    )
    .map((r) => r.slug);
  if (slugs.length === 0) return [];

  const admin = createAdminClient();
  const { data } = await admin
    .from("profiles")
    .select("id, full_name, email")
    .in("role", slugs)
    .limit(200);
  return (data ?? []).map((p: any) => ({
    id: p.id as string,
    name: (p.full_name as string | null)?.trim() || (p.email as string) || "Unnamed",
  }));
}

// ---------------------------------------------------------------------------
// Notifications
//
// Both write surfaces (the requester's action and the admin's) call into here,
// so "who hears about what" is decided once. Everything in this section is
// best-effort: a mail or bell failure must never fail the write it reports on,
// because the ticket existing matters more than the email about it. Each block
// therefore owns a try/catch and logs.
// ---------------------------------------------------------------------------

/** How a ticket's requester is described to the team. */
function requesterLabel(t: SupportTicket): string {
  const name = t.requesterName?.trim() || t.accountName?.trim();
  return name ? `${name} <${t.requesterEmail}>` : t.requesterEmail;
}

/**
 * Fans out everything that should happen when a ticket is filed: the
 * requester's receipt, the team's email, and the in-app bell.
 */
export async function announceNewTicket(ticket: SupportTicket): Promise<void> {
  const categoryLabel = CATEGORY_LABELS[ticket.category];
  const isRefund = ticket.category === "refund";
  const receivedAt = formatReceivedAt(ticket.createdAt);
  const url = ticketUrl(ticket.token);
  const firstName = (ticket.requesterName ?? ticket.accountName ?? "").trim();
  // The database copy of the receipt email has no conditionals, so the
  // refund-window sentence is passed as a variable and is empty for every
  // other category. The compiled fallback renders it from `isRefund` instead.
  const refundNote = isRefund
    ? "Because this is a refund request, the time above is the one that counts — our refund policy gives you 48 hours from payment to ask, and the clock stopped when this request was recorded. Keep this email."
    : "";

  // 1. The requester's receipt. The most important email in the feature.
  try {
    await sendTemplated(SUPPORT_RECEIVED_TEMPLATE, {
      to: ticket.requesterEmail,
      toName: firstName || null,
      userId: ticket.userId,
      vars: {
        reference: ticket.reference,
        ticket_url: url,
        received_at: receivedAt,
        category_label: categoryLabel,
        subject_line: ticket.subject,
        request_body: ticket.body,
        refund_note: refundNote,
      },
      fallback: () =>
        Templates.supportTicketReceived({
          name: firstName || null,
          reference: ticket.reference,
          categoryLabel,
          subject: ticket.subject,
          body: ticket.body,
          receivedAt,
          threadUrl: url,
          isRefund,
        }),
    });
  } catch (err) {
    console.error("[support] requester receipt failed", err);
  }

  // 2. The team's inbox. Address comes from site settings, not the env, so an
  // admin changing the contact address at /admin/settings moves this too.
  try {
    const config = await getPublicSiteConfig();
    const teamAddress = config.settings.contactEmail;
    if (teamAddress) {
      await sendTemplated(SUPPORT_INTERNAL_TEMPLATE, {
        to: teamAddress,
        toName: "batch0 team",
        userId: null,
        // So a reply from the shared inbox reaches the person rather than
        // landing back in the shared inbox.
        replyTo: ticket.requesterEmail,
        vars: {
          reference: ticket.reference,
          admin_url: adminTicketUrl(ticket.id),
          category_label: categoryLabel,
          subject_line: ticket.subject,
          requester_label: requesterLabel(ticket),
        },
        fallback: () =>
          Templates.supportTicketInternal({
            reference: ticket.reference,
            categoryLabel,
            subject: ticket.subject,
            requesterLabel: requesterLabel(ticket),
            adminUrl: adminTicketUrl(ticket.id),
            isRefund,
          }),
      });
    }
  } catch (err) {
    console.error("[support] team email failed", err);
  }

  // 3. The bell, for everyone who can work the queue. Refunds say so in the
  // title — it is the only category with a deadline, and the title is all
  // anyone reads in a notification list.
  try {
    const recipients = await listSupportTeamIds();
    const filtered = recipients.filter((uid) => uid !== ticket.userId);
    await notifyMany(
      filtered.map((uid) => ({
        userId: uid,
        type: "support_ticket",
        title: isRefund
          ? `Refund request — ${ticket.reference}`
          : `New ${categoryLabel.toLowerCase()} — ${ticket.reference}`,
        body: ticket.subject.slice(0, 200),
        link: `/admin/support/${ticket.id}`,
        dedupeKey: `support_ticket:${ticket.id}:${uid}`,
      })),
    );
  } catch (err) {
    console.error("[support] team bell failed", err);
  }
}

/**
 * The requester posted a follow-up: bell the team and raise the queue flag's
 * human equivalent. No email to the team on a follow-up — the queue and the
 * bell are the working surface, and a second mail per message would train
 * people to filter the first one.
 */
export async function announceRequesterReply(
  ticket: SupportTicket,
  body: string,
): Promise<void> {
  try {
    const recipients = await listSupportTeamIds();
    await notifyMany(
      recipients
        .filter((uid) => uid !== ticket.userId)
        .map((uid) => ({
          userId: uid,
          type: "support_reply",
          title: `Follow-up on ${ticket.reference}`,
          body: body.slice(0, 200),
          link: `/admin/support/${ticket.id}`,
          // Keyed on the reply, not the ticket: every follow-up is worth a
          // fresh bell, unlike the one-per-ticket arrival notice.
          dedupeKey: `support_reply:${ticket.id}:${ticket.replyCount}:${uid}`,
        })),
    );
  } catch (err) {
    console.error("[support] requester reply bell failed", err);
  }
}

/**
 * The team replied: email the requester. Guarded by claimReplyNotification so
 * a retried action can't send twice.
 */
export async function announceStaffReply(args: {
  ticket: SupportTicket;
  replyId: string;
  body: string;
  replierName: string;
}): Promise<void> {
  try {
    if (!(await claimReplyNotification(args.replyId))) return;
    const t = args.ticket;
    const firstName = (t.requesterName ?? t.accountName ?? "").trim();
    const url = ticketUrl(t.token);
    await sendTemplated(SUPPORT_REPLIED_TEMPLATE, {
      to: t.requesterEmail,
      toName: firstName || null,
      userId: t.userId,
      vars: {
        reference: t.reference,
        ticket_url: url,
        subject_line: t.subject,
        replier_name: args.replierName,
        reply_body: args.body,
      },
      fallback: () =>
        Templates.supportTicketReplied({
          name: firstName || null,
          reference: t.reference,
          subject: t.subject,
          replierName: args.replierName,
          reply: args.body,
          threadUrl: url,
        }),
    });
  } catch (err) {
    console.error("[support] staff reply email failed", err);
  }
}

/** Marked resolved without a reply — tell them, and tell them how to reopen. */
export async function announceResolved(ticket: SupportTicket): Promise<void> {
  try {
    const firstName = (ticket.requesterName ?? ticket.accountName ?? "").trim();
    const url = ticketUrl(ticket.token);
    await sendTemplated(SUPPORT_RESOLVED_TEMPLATE, {
      to: ticket.requesterEmail,
      toName: firstName || null,
      userId: ticket.userId,
      vars: {
        reference: ticket.reference,
        ticket_url: url,
        subject_line: ticket.subject,
      },
      fallback: () =>
        Templates.supportTicketResolved({
          name: firstName || null,
          reference: ticket.reference,
          subject: ticket.subject,
          threadUrl: url,
        }),
    });
  } catch (err) {
    console.error("[support] resolved email failed", err);
  }
}

// ---------------------------------------------------------------------------
// Payment resolution
// ---------------------------------------------------------------------------

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
 * Finds the charge a refund or billing ticket is about.
 *
 * Deliberately scoped to the ticket's own `user_id`. A pasted `cs_…` is
 * untrusted input, and resolving it globally would let anyone who files a
 * ticket and guesses — or simply mistypes — a session id read a stranger's
 * amount, currency, and receipt URL off the admin page as though it were
 * theirs. So: match the identifier only among that account's payments, and if
 * nothing matches, return the account's payments anyway and let a human look.
 * The raw string is always shown to the admin regardless; it may be a PayPal
 * transaction id, which this schema has no concept of.
 *
 * Returns { matched, candidates } rather than one row, because "we could not
 * resolve this, here is what they have paid" is the useful answer to an admin
 * working a refund.
 */
export async function resolveTicketPayments(
  ticket: Pick<SupportTicket, "userId" | "receiptRef" | "paymentId">,
): Promise<{ matched: TicketPayment | null; candidates: TicketPayment[] }> {
  const admin = createAdminClient();

  // An explicit link an admin already made wins over anything re-derived.
  if (ticket.paymentId) {
    const { data } = await admin
      .from("payments")
      .select(PAYMENT_SELECT)
      .eq("id", ticket.paymentId)
      .maybeSingle();
    if (data) return { matched: toPayment(data), candidates: [] };
  }

  if (!ticket.userId) return { matched: null, candidates: [] };

  const { data: own } = await admin
    .from("payments")
    .select(PAYMENT_SELECT)
    .eq("user_id", ticket.userId)
    .order("created_at", { ascending: false })
    .limit(20);
  const candidates = (own ?? []).map(toPayment);

  const ref = ticket.receiptRef?.trim() ?? "";
  if (!ref) return { matched: null, candidates };

  // Both identifiers can appear anywhere in what was pasted — people paste
  // whole receipt URLs. cs_ is checked first because it is the one with an
  // index predating this feature (0050) and the one Checkout puts in the URL.
  const session = /cs_(?:test_|live_)?[A-Za-z0-9_]{8,220}/.exec(ref)?.[0];
  const intent = /pi_[A-Za-z0-9_]{8,220}/.exec(ref)?.[0];

  const matched =
    (session && candidates.find((p) => p.stripeSessionId === session)) ||
    (intent && candidates.find((p) => p.stripePaymentIntentId === intent)) ||
    null;

  return { matched: matched ?? null, candidates };
}
