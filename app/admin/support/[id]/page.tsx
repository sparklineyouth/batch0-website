import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, ExternalLink } from "lucide-react";
import { requirePermission } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { Card } from "@/components/ui/card";
import { LocalTime } from "@/components/ui/local-time";
import {
  forRequester,
  formatReceivedAt,
  getTicketForStaff,
  listAssignableStaff,
  listTicketReplies,
  resolveTicketPayments,
} from "@/lib/support";
import {
  CATEGORY_LABELS,
  CHANNEL_LABELS,
  canStaffManageTicket,
  canStaffSeeTicket,
  supportScopeFor,
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
}) {
  const [params, { profile, caps }] = await Promise.all([
    props.params,
    requirePermission("support.view"),
  ]);
  const scope = supportScopeFor(profile.id, caps);
  const ticket = await getTicketForStaff(params.id, scope);
  // getTicketForStaff already answers null for a confidential ticket this
  // scope can't see; checking the rule again costs nothing and keeps it true
  // even if that read changes.
  if (!ticket || !canStaffSeeTicket(scope, ticket)) notFound();

  const canManage = canStaffManageTicket(scope, ticket);

  const [replies, staff, payments] = await Promise.all([
    // The one call site that passes true. Internal notes are staff-only and
    // lib/support.ts defaults this to false so forgetting is the safe answer.
    listTicketReplies(ticket.id, { includeInternal: true }),
    canManage ? listAssignableStaff({ sensitive: ticket.sensitive }) : Promise.resolve([]),
    resolveTicketPayments(ticket),
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
              {ticket.category === "refund" && (
                <span className="mt-0.5 block text-xs text-amber-700 dark:text-amber-300">
                  The 48-hour refund window is measured from the payment, not
                  from this. Check it against the charge below.
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
      {(linked || payments.candidates.length > 0) && (
        <Card className="mt-4">
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
          {/* The links that act on money follow the money permission, not the
              support one: /admin/payments is gated on it. */}
          {can(caps, "payments.manage") && (
            <Link
              href="/admin/payments"
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

      <p className="mt-10 border-t border-line pt-5 text-xs text-ink-faint">
        Signed in as {profile.full_name?.trim() || profile.email}. Replies go
        out under &ldquo;the batch0 team&rdquo; unless your profile has a name
        on it.
      </p>
    </div>
  );
}
