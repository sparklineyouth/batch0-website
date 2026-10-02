import Link from "next/link";
import { notFound } from "next/navigation";
import { AlertTriangle, ArrowLeft, CheckCircle2, ExternalLink } from "lucide-react";
import { requirePermission } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { Card } from "@/components/ui/card";
import { LocalTime } from "@/components/ui/local-time";
import {
  forRequester,
  formatReceivedAt,
  getRequesterContext,
  getTicketForStaff,
  getTicketHistory,
  listAssignableStaff,
  listTicketReplies,
  resolveTicketPayments,
  type SupportHistoryEntry,
} from "@/lib/support";
import { listAttachments } from "@/lib/support-attachments";
import {
  CATEGORY_LABELS,
  CHANNEL_LABELS,
  OUTCOME_LABELS,
  PRIORITY_LABELS,
  STAFF_STATUS_LABELS,
  canStaffManageTicket,
  canStaffSeeTicket,
  parseCategory,
  refundWindow,
  supportScopeFor,
  toOutcome,
  toPriority,
  toStatus,
} from "@/lib/support-access";
import { ConfidentialBadge, PriorityBadge } from "../badges";
import { StaffThread } from "./staff-thread";
import { TicketControls } from "./ticket-controls";

export const metadata = { title: "Request · Admin" };
export const dynamic = "force-dynamic";

function money(cents: number, currency: string): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currency.toUpperCase(),
  }).format(cents / 100);
}

/**
 * The line shown after "Log a request" redirects here (`?logged=`): what
 * became of the confirmation the logger asked for. "unsent" is the one that
 * needs doing something about — the requester has no thread link yet, and a
 * reply is how they get one (its email carries it).
 */
function loggedNote(flag: string | undefined, email: string) {
  switch (flag) {
    case "sent":
      return { warn: false, text: `Logged. ${email} has a confirmation with the reference, the recorded time and their thread link.` };
    case "unsent":
      return { warn: true, text: "Logged — but the confirmation email didn't go out. Reply on this thread: the reply's email carries their thread link." };
    case "off":
      return { warn: false, text: "Logged without a confirmation. Your first reply emails them their thread link." };
    default:
      return null;
  }
}

/** The colour of a refund-window verdict: green inside, red outside, quiet when it can't say. */
const WINDOW_TONE = {
  inside: "text-emerald-700 dark:text-emerald-300",
  outside: "text-red-700 dark:text-red-300",
  before_payment: "text-ink-soft",
  unknown: "text-ink-faint",
} as const;

/**
 * One line of the ticket's history, in words. The audit actions are the
 * vocabulary app/admin/support/actions.ts, app/support/actions.ts and the
 * housekeeping cron write; anything this doesn't know reads as its own name,
 * so a new action shows up rather than vanishing.
 */
function describeHistory(
  entry: SupportHistoryEntry,
  staffNames: Map<string, string>,
): string {
  const p = entry.payload ?? {};
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  const status = (v: unknown) => {
    const s = toStatus(v);
    return s ? STAFF_STATUS_LABELS[s].toLowerCase() : str(v);
  };
  switch (entry.action) {
    case "support_ticket.created":
      return "Filed the request";
    case "support_ticket.logged":
      return `Logged it from ${str(p.channel) || "an outside"} request`;
    case "support_ticket.replied": {
      const outcome = toOutcome(p.outcome);
      return p.resolve
        ? `Replied and resolved it${outcome ? ` (${OUTCOME_LABELS[outcome].toLowerCase()})` : ""}`
        : "Replied";
    }
    case "support_ticket.noted":
      return "Added an internal note";
    case "support_ticket.resolved_by_requester":
      return "Marked it solved themselves";
    case "support_ticket.auto_resolved":
      return "Resolved automatically after a week without a reply";
    case "support_ticket.auto_closed":
      return "Closed automatically two weeks after it was resolved";
    case "support_ticket.assigned": {
      const who = staffNames.get(str(p.assignee_id));
      return who ? `Assigned it to ${who}` : "Assigned it";
    }
    case "support_ticket.unassigned":
      return "Unassigned it";
    case "support_ticket.priority_changed": {
      const from = toPriority(p.from);
      const to = toPriority(p.to);
      return from && to
        ? `Priority ${PRIORITY_LABELS[from].toLowerCase()} → ${PRIORITY_LABELS[to].toLowerCase()}`
        : "Changed the priority";
    }
    case "support_ticket.category_changed": {
      const from = parseCategory(p.from);
      const to = parseCategory(p.to);
      return from && to ? `Moved from ${CATEGORY_LABELS[from]} to ${CATEGORY_LABELS[to]}` : "Changed the kind";
    }
    case "support_ticket.marked_confidential":
      return "Marked it confidential";
    case "support_ticket.unmarked_confidential":
      return "Took confidentiality off";
    case "support_ticket.payment_linked":
      return "Linked the charge";
    case "support_ticket.payment_unlinked":
      return "Unlinked the charge";
    default: {
      // support_ticket.<status> from changeTicketStatus.
      const to = toStatus(entry.action.replace(/^support_ticket\./, ""));
      if (to) return `Status ${status(p.from)} → ${STAFF_STATUS_LABELS[to].toLowerCase()}`;
      return entry.action.replace(/^support_ticket\./, "").replace(/_/g, " ");
    }
  }
}

/**
 * One support request, for the team.
 *
 * The layout has already required support.view for this path, and this page
 * requires it again rather than trusting the route map — a page that reads
 * someone's request must say what it needs where it reads it. The viewer's
 * support scope then decides everything else: a confidential concern is the
 * same 404 as a missing ticket for anyone without support.sensitive (nothing
 * here may confirm one exists), and the write affordances need support.manage.
 *
 * Note what this page does NOT have: a refund button. Issuing a refund forks
 * hard on full-versus-partial — a full refund tears down the enrolment and
 * rolls the application back to "accepted" via apply_enrollment_refund, and a
 * partial one doesn't — and that consequence belongs on /admin/payments where
 * it is the visible point of the page, not behind a button on a support
 * thread. This links out instead, with the ticket reference in hand.
 */
export default async function AdminSupportTicketPage(props: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ logged?: string }>;
}) {
  const [params, searchParams, { profile, caps }] = await Promise.all([
    props.params,
    props.searchParams,
    requirePermission("support.view"),
  ]);
  const scope = supportScopeFor(profile.id, caps);
  const ticket = await getTicketForStaff(params.id, scope);
  // getTicketForStaff already answers null for a confidential ticket this
  // scope can't see; checking the rule again costs nothing and keeps it true
  // even if that read changes.
  if (!ticket || !canStaffSeeTicket(scope, ticket)) notFound();

  const canManage = canStaffManageTicket(scope, ticket);

  const [replies, attachments, staff, payments, context, history] = await Promise.all([
    // The call sites that pass true. Internal notes and their files are
    // staff-only, and both readers default to false so forgetting is the safe
    // answer. The ticket was authorized for this scope just above.
    listTicketReplies(ticket.id, { includeInternal: true }),
    listAttachments(ticket.id, { includeInternal: true }),
    canManage ? listAssignableStaff({ sensitive: ticket.sensitive }) : Promise.resolve([]),
    resolveTicketPayments(ticket),
    // Who they are and what else they've asked, so the answer doesn't need
    // five other tabs. Best-effort inside: a part that fails comes back empty.
    getRequesterContext(ticket, scope),
    getTicketHistory(ticket.id),
  ]);

  const scrubbed = forRequester(ticket);
  const linked = payments.matched;
  // What the charge picker offers: the account's recent payments, plus the
  // linked one if it's older than those — so it can always be changed or
  // unlinked, never shown as a value the list doesn't contain.
  const payable =
    linked && ticket.paymentId === linked.id && !payments.candidates.some((p) => p.id === linked.id)
      ? [linked, ...payments.candidates]
      : payments.candidates;
  const requesterName =
    ticket.requesterName?.trim() || ticket.accountName?.trim() || ticket.requesterEmail;
  const logged = loggedNote(searchParams.logged, ticket.requesterEmail);

  // A fee, fine or Demo Day ticket picked on the form lives in the context
  // (only tuition is a payments row); find it among this person's charges.
  const otherCharge =
    (ticket.context.chargeId &&
      context.charges.find((c) => c.id === ticket.context.chargeId)) ||
    null;
  const demoDayTicket =
    (ticket.context.demoDayTicketId &&
      context.demoDayTickets.find((t) => t.id === ticket.context.demoDayTicketId)) ||
    null;
  // The refund-window verdict, from the receipt time and the linked tuition
  // payment's paid time — the two facts the refund policy measures between.
  // Only for refund requests: it's the question a refund ticket opens with.
  const refundCheck =
    ticket.category === "refund" && linked ? refundWindow(ticket.receivedAt, linked.paidAt) : null;
  const application = context.applications[0] ?? null;
  const staffNames = new Map(staff.map((s) => [s.id, s.name]));
  const filedFrom = [
    ticket.context.page && `on ${ticket.context.page}`,
    ticket.context.source && `via ${ticket.context.source.replace(/_/g, " ")}`,
  ].filter(Boolean);

  return (
    <div className="mx-auto max-w-3xl pb-16">
      <Link
        href="/admin/support"
        prefetch={false}
        className="inline-flex items-center gap-1.5 text-sm text-ink-soft hover:text-ink"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        Support queue
      </Link>

      {logged && (
        <div
          role="status"
          className={`mt-4 flex items-start gap-2 rounded-lg border px-4 py-3 text-sm ${
            logged.warn
              ? "border-amber-500/30 bg-amber-500/10 text-amber-800 dark:text-amber-200"
              : "border-line bg-wash text-ink-soft"
          }`}
        >
          {logged.warn ? (
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          ) : (
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-phosphor-ink" aria-hidden />
          )}
          <p className="min-w-0 break-words">{logged.text}</p>
        </div>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <PriorityBadge priority={ticket.priority} />
        {ticket.sensitive && <ConfidentialBadge />}
        <span className="text-[11px] text-ink-faint">
          via {CHANNEL_LABELS[ticket.channel]}
          {ticket.createdByName && ` · logged by ${ticket.createdByName}`}
        </span>
      </div>

      {/* The admin-only identity strip. Everything the requester-facing
          component is typed not to receive is rendered here instead, on the
          page whose permission gate authorized reading it. */}
      <Card className="mt-3">
        <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
          <div>
            <dt className="font-mono text-[11px] uppercase tracking-wider text-ink-faint">
              From
            </dt>
            <dd className="mt-0.5 text-ink">
              {/* "Open person" only for people.view — the profile page is
                  gated on it, and a dead link is worse than plain text. */}
              {ticket.userId && can(caps, "people.view") ? (
                <Link
                  href={`/admin/students/${ticket.userId}`}
                  prefetch={false}
                  className="hover:underline"
                >
                  {requesterName}
                </Link>
              ) : (
                requesterName
              )}
              {!ticket.userId && (
                <span className="ml-1.5 text-xs text-ink-faint">
                  {ticket.createdBy ? "(no account)" : "(account deleted)"}
                </span>
              )}
              <span className="mt-0.5 block break-all text-xs text-ink-soft">
                <a href={`mailto:${ticket.requesterEmail}`} className="hover:underline">
                  {ticket.requesterEmail}
                </a>
              </span>
            </dd>
          </div>
          <div>
            <dt className="font-mono text-[11px] uppercase tracking-wider text-ink-faint">
              Recorded
            </dt>
            <dd className="mt-0.5 text-ink">
              {formatReceivedAt(ticket.receivedAt)}
              {ticket.category === "refund" && !refundCheck && (
                <span className="mt-0.5 block text-xs text-amber-700 dark:text-amber-300">
                  The 48-hour refund window runs from the payment to this. Link
                  the charge below to check it.
                </span>
              )}
            </dd>
          </div>
          <div>
            <dt className="font-mono text-[11px] uppercase tracking-wider text-ink-faint">
              Kind
            </dt>
            <dd className="mt-0.5 text-ink">{CATEGORY_LABELS[ticket.category]}</dd>
          </div>
          <div>
            <dt className="font-mono text-[11px] uppercase tracking-wider text-ink-faint">
              Last activity
            </dt>
            <dd className="mt-0.5 text-ink">
              <LocalTime value={ticket.lastActivityAt} mode="datetime-short" />
              {ticket.resolvedAt && (
                <span className="mt-0.5 block text-xs text-ink-faint">
                  Resolved{" "}
                  <LocalTime value={ticket.resolvedAt} mode="datetime-short" />
                </span>
              )}
            </dd>
          </div>
          {context.profile && (
            <div className="sm:col-span-2">
              <dt className="font-mono text-[11px] uppercase tracking-wider text-ink-faint">
                On batch0
              </dt>
              <dd className="mt-0.5 text-ink">
                {context.profile.roleLabel}
                <span className="text-ink-faint">
                  {" · account since "}
                  <LocalTime value={context.profile.createdAt} mode="date" />
                </span>
                {application && (
                  <span className="mt-0.5 block text-xs text-ink-soft">
                    Application {application.status.replace(/_/g, " ")}
                    {application.cohortName && ` · ${application.cohortName}`}
                  </span>
                )}
                {context.enrollment && (
                  <span className="mt-0.5 block text-xs text-ink-soft">
                    Enrolled in {context.enrollment.cohortName ?? "a cohort"}
                    {" since "}
                    <LocalTime value={context.enrollment.enrolledAt} mode="date" />
                  </span>
                )}
              </dd>
            </div>
          )}
          {(filedFrom.length > 0 || ticket.context.digest || ticket.context.userAgent) && (
            // What the form knew about where they were — the page, the link
            // they followed, an error's digest (searchable in the logs), the
            // browser. Most useful on a tech-help request.
            <div className="sm:col-span-2">
              <dt className="font-mono text-[11px] uppercase tracking-wider text-ink-faint">
                Filed from
              </dt>
              <dd className="mt-0.5 space-y-0.5 text-xs text-ink-soft">
                {filedFrom.length > 0 && <span className="block break-all">{filedFrom.join(" · ")}</span>}
                {ticket.context.digest && (
                  <span className="block font-mono">error digest {ticket.context.digest}</span>
                )}
                {ticket.context.userAgent && (
                  <span className="block break-all text-ink-faint">{ticket.context.userAgent}</span>
                )}
              </dd>
            </div>
          )}
          {ticket.receiptRef && (
            <div className="sm:col-span-2">
              <dt className="font-mono text-[11px] uppercase tracking-wider text-ink-faint">
                Receipt reference they gave
              </dt>
              <dd className="mt-0.5 break-all font-mono text-xs text-ink">
                {ticket.receiptRef}
                {!linked && (
                  <span className="ml-2 font-sans text-xs text-ink-faint">
                    — no charge on this account matches it. It may be a PayPal
                    id, which this system doesn&rsquo;t hold.
                  </span>
                )}
              </dd>
            </div>
          )}
        </dl>
      </Card>

      {/* The charge, when we could find it. Read-only on purpose — see the
          header comment about where refunds belong. */}
      {(linked || payments.candidates.length > 0 || otherCharge || demoDayTicket) && (
        <Card className="mt-4">
          {refundCheck && (
            <p className={`mb-3 text-sm font-medium ${WINDOW_TONE[refundCheck.state]}`}>
              {refundCheck.label}
            </p>
          )}
          {(otherCharge || demoDayTicket) && (
            <div className="mb-4">
              <h2 className="font-mono text-[11px] uppercase tracking-wider text-ink-faint">
                The charge they picked
              </h2>
              <p className="mt-2 text-sm text-ink">
                {otherCharge
                  ? `${otherCharge.description || (otherCharge.kind === "fine" ? "Fine" : "Fee")} · ${money(otherCharge.amountCents, "usd")}`
                  : `Demo Day ticket · ${money(demoDayTicket!.amountCents, "usd")}`}
                <span className="ml-2 font-mono text-[10px] uppercase tracking-wider text-ink-faint">
                  {(otherCharge ?? demoDayTicket)!.status}
                </span>
                {(otherCharge ?? demoDayTicket)!.paidAt && (
                  <span className="ml-2 text-xs text-ink-faint">
                    paid{" "}
                    <LocalTime value={(otherCharge ?? demoDayTicket)!.paidAt} mode="datetime-short" />
                  </span>
                )}
              </p>
              {demoDayTicket && (
                <p className="mt-1 text-xs text-ink-faint">
                  Demo Day tickets are final sale unless batch0 cancels Demo Day.
                </p>
              )}
            </div>
          )}
          {(linked || payments.candidates.length > 0) && (
            <>
              <h2 className="font-mono text-[11px] uppercase tracking-wider text-ink-faint">
                {linked ? "The charge this is about" : "This account's payments"}
              </h2>
              <ul className="mt-3 space-y-2 text-sm">
                {(linked ? [linked] : payments.candidates).map((p) => (
                  <li
                    key={p.id}
                    className="flex flex-wrap items-baseline justify-between gap-2 border-b border-line pb-2 last:border-0 last:pb-0"
                  >
                    <span className="text-ink">
                      {money(p.amountCents, p.currency)}
                      {p.amountRefundedCents > 0 && (
                        <span className="ml-1.5 text-xs text-ink-soft">
                          ({money(p.amountRefundedCents, p.currency)} refunded)
                        </span>
                      )}
                      <span className="ml-2 font-mono text-[10px] uppercase tracking-wider text-ink-faint">
                        {p.status}
                      </span>
                    </span>
                    <span className="text-xs text-ink-faint">
                      <LocalTime
                        value={p.paidAt ?? p.createdAt}
                        mode="datetime-short"
                      />
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}
          {/* The links that act on money follow the money permission, not the
              support one: /admin/payments is gated on it. */}
          {can(caps, "payments.manage") && (
            <Link
              // Straight to the linked payment's row when there is one; the
              // whole ledger otherwise.
              href={linked ? `/admin/payments?payment=${linked.id}` : "/admin/payments"}
              prefetch={false}
              className="mt-4 inline-flex items-center gap-1.5 text-sm text-ink-soft hover:text-ink"
            >
              Issue a refund on /admin/payments
              <ExternalLink className="h-3.5 w-3.5" />
            </Link>
          )}
          {can(caps, "payments.manage") && (
            <p className="mt-1.5 text-xs text-ink-faint">
              Refunds live there, not here: a full refund also tears down the
              enrolment and rolls the application back, and that belongs on the
              page where it&rsquo;s the point. Quote {ticket.reference} in the
              reason.
            </p>
          )}
        </Card>
      )}

      <div className="mt-8">
        <StaffThread
          ticketId={ticket.id}
          canManage={canManage}
          attachments={attachments}
          ticket={{
            id: scrubbed.id,
            reference: scrubbed.reference,
            subject: scrubbed.subject,
            body: scrubbed.body,
            category: scrubbed.category,
            status: scrubbed.status,
            createdAt: scrubbed.createdAt,
            receivedAtLabel: formatReceivedAt(scrubbed.receivedAt),
            requesterName: scrubbed.requesterName,
            accountName: scrubbed.accountName,
          }}
          replies={replies.map((r) => {
            const s = forRequester(r);
            return {
              id: s.id,
              authorName:
                s.authorName ??
                (ticket.requesterName?.trim() || ticket.accountName?.trim() || "Requester"),
              body: s.body,
              isStaff: s.isStaff,
              isInternal: s.isInternal,
              createdAt: s.createdAt,
            };
          })}
          controls={
            <TicketControls
              ticketId={ticket.id}
              status={ticket.status}
              assignedTo={ticket.assignedTo}
              priority={ticket.priority}
              category={ticket.category}
              sensitive={ticket.sensitive}
              staff={staff}
              canManage={canManage}
              canSeeSensitive={scope.canSeeSensitive}
              viewerId={profile.id}
              linkedPaymentId={ticket.paymentId}
              payments={payable.map((p) => ({
                id: p.id,
                label: `${money(p.amountCents, p.currency)} · ${p.status} · ${
                  (p.paidAt ?? p.createdAt).slice(0, 10)
                }`,
              }))}
            />
          }
        />
      </div>

      {context.otherTickets.length > 0 && (
        // Their other requests — already filtered by this viewer's scope, so a
        // confidential concern by the same person isn't even counted for
        // someone who couldn't open it.
        <Card className="mt-10">
          <h2 className="font-mono text-[11px] uppercase tracking-wider text-ink-faint">
            Their other requests
          </h2>
          <ul className="mt-3 space-y-2 text-sm">
            {context.otherTickets.slice(0, 8).map((t) => (
              <li key={t.id} className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
                <Link
                  href={`/admin/support/${t.id}`}
                  prefetch={false}
                  className="min-w-0 truncate text-ink hover:underline"
                >
                  {t.subject}
                </Link>
                <span className="shrink-0 text-xs text-ink-faint">
                  <span className="font-mono uppercase tracking-wider">{t.reference}</span>
                  {" · "}
                  {STAFF_STATUS_LABELS[t.status].toLowerCase()}
                  {" · "}
                  <LocalTime value={t.receivedAt} mode="date" />
                </span>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {history.length > 0 && (
        // The audit trail for this ticket, oldest first. Folded away: it's for
        // "who changed this, and when", not for answering.
        <details className="mt-6 rounded-lg border border-line bg-wash p-4">
          <summary className="cursor-pointer select-none text-sm font-semibold text-ink">
            History
            <span className="ml-2 text-xs font-normal text-ink-faint">
              {history.length} {history.length === 1 ? "change" : "changes"}
            </span>
          </summary>
          <ol className="mt-3 space-y-1.5 text-xs">
            {history.map((h) => (
              <li key={h.id} className="flex flex-wrap gap-x-2">
                <span className="shrink-0 text-ink-faint">
                  <LocalTime value={h.createdAt} mode="datetime-short" />
                </span>
                <span className="text-ink-soft">
                  <span className="font-medium text-ink">
                    {h.actorName ??
                      (h.actorId
                        ? "Someone"
                        : h.action === "support_ticket.resolved_by_requester"
                          ? "The requester"
                          : "batch0")}
                  </span>{" "}
                  {describeHistory(h, staffNames).replace(/^./, (c) => c.toLowerCase())}
                </span>
              </li>
            ))}
          </ol>
        </details>
      )}

      <p className="mt-10 border-t border-line pt-5 text-xs text-ink-faint">
        Signed in as {profile.full_name?.trim() || profile.email}. Replies go
        out under &ldquo;the batch0 team&rdquo; unless your profile has a name
        on it.
      </p>
    </div>
  );
}
