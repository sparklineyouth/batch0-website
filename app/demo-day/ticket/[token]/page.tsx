import Link from "next/link";
import { notFound } from "next/navigation";
import {
  CheckCircle,
  Clock,
  ExternalLink,
  Ticket,
  TriangleAlert,
  XCircle,
} from "lucide-react";
import { Card } from "@/components/ui/card";
import { AutoRefresh } from "@/components/auto-refresh";
import { env } from "@/lib/env";
import { getTicketByToken, getDemoDayDetails } from "@/lib/demo-day-tickets";
import { formatTicketAmount } from "@/lib/demo-day-ticket-input";
import type { DemoDayTicket } from "@/lib/types";
import { TicketPayButton } from "./pay-button";

/**
 * The public face of a Demo Day ticket — the page the invite email's button
 * opens. Reached only by its secret token; no account, no sign-in.
 *
 * One page, four states of the ticket underneath: still payable (the pay
 * button), paid (the confirmation, with the day's details), cancelled and
 * refunded (a dead end that says why). On the way back from Stripe Checkout
 * the session id rides along and the page settles it against Stripe first,
 * so someone who paid ten seconds ago sees "confirmed" rather than the pay
 * button — same pattern as /dashboard/billing.
 */

export const metadata = {
  title: "Demo Day ticket · batch0",
  // A private link. Never indexed.
  robots: { index: false, follow: false },
};

// The token is a secret and the state is live money; nothing here caches.
export const dynamic = "force-dynamic";

export default async function DemoDayTicketPage(props: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ session_id?: string; canceled?: string }>;
}) {
  const [params, searchParams] = await Promise.all([
    props.params,
    props.searchParams,
  ]);
  let ticket = await getTicketByToken(params.token);
  if (!ticket) notFound();

  // Back from Checkout: settle, then re-read so the page reflects it. The
  // sync verifies the session names THIS ticket before writing anything.
  let settled: "paid" | "processing" | "failed" | "expired" | "unknown" | null =
    null;
  if (searchParams.session_id) {
    const { syncDemoDayTicketSession } = await import("@/lib/stripe-fulfillment");
    const result = await syncDemoDayTicketSession(
      searchParams.session_id,
      ticket.id,
    );
    settled = result.state;
    ticket = (await getTicketByToken(params.token)) ?? ticket;
  }

  const details = await getDemoDayDetails(ticket.cohort_id);
  const amount = formatTicketAmount(ticket.amount_cents);

  return (
    <main
      id="main-content"
      tabIndex={-1}
      className="mx-auto max-w-lg px-5 py-16 md:py-24"
    >
      <div className="text-center">
        <Link
          href="/"
          className="font-mono text-xs uppercase tracking-[0.25em] text-ink-faint hover:text-ink"
        >
          batch0
        </Link>
        <div className="mx-auto mt-6 flex h-12 w-12 items-center justify-center rounded-2xl bg-phosphor/15 text-phosphor-ink">
          <Ticket className="h-6 w-6" />
        </div>
        <p className="mt-4 font-mono text-[10px] font-semibold uppercase tracking-[0.25em] text-phosphor-ink">
          Demo Day ticket
        </p>
        <h1 className="mt-3 font-display text-3xl leading-tight text-ink md:text-4xl">
          {ticket.status === "paid" ? "You're confirmed" : "You're invited to Demo Day"}
        </h1>
        {details.cohortName && (
          <p className="mt-2 text-sm text-ink-soft">{details.cohortName}</p>
        )}
      </div>

      {/* Return-from-Checkout banners. "paid" needs none — the card below
          says it. */}
      {settled === "processing" && (
        <Banner tone="wait" icon={Clock} title="Payment processing">
          Your bank hasn&rsquo;t finished confirming this one. Usually a
          minute or less. This page updates itself — you don&rsquo;t need to
          reload or pay again.
          <AutoRefresh />
        </Banner>
      )}
      {settled === "failed" && (
        <Banner tone="bad" icon={XCircle} title="Payment didn't go through">
          Your card was declined and no money was taken. Try again below, or
          use a different card.
        </Banner>
      )}
      {settled === "expired" && (
        <Banner tone="warn" icon={TriangleAlert} title="Checkout expired">
          That checkout timed out before it was paid. Nothing was charged —
          start again whenever you&rsquo;re ready.
        </Banner>
      )}
      {settled === "unknown" && ticket.status !== "paid" && (
        <Banner tone="warn" icon={TriangleAlert} title="We couldn't confirm that payment">
          Nothing here is proof it failed. If your card was charged, email{" "}
          <a href={`mailto:${env.contactEmail}`} className="underline">
            {env.contactEmail}
          </a>{" "}
          before paying again.
        </Banner>
      )}
      {searchParams.canceled && !settled && ticket.status === "sent" && (
        <Banner tone="warn" icon={TriangleAlert} title="Checkout canceled">
          Nothing was charged. Your ticket is still here whenever you&rsquo;re
          ready.
        </Banner>
      )}

      <Card className="mt-8">
        <TicketBody ticket={ticket} details={details} amount={amount} />
      </Card>

      <p className="mt-8 text-center text-xs text-ink-faint">
        This ticket is for Demo Day only — not enrollment in the batch0
        cohort. Questions?{" "}
        <a href={`mailto:${env.contactEmail}`} className="underline">
          {env.contactEmail}
        </a>
      </p>
    </main>
  );
}

function TicketBody({
  ticket,
  details,
  amount,
}: {
  ticket: DemoDayTicket;
  details: Awaited<ReturnType<typeof getDemoDayDetails>>;
  amount: string;
}) {
  const who = ticket.name ?? ticket.email;

  if (ticket.status === "cancelled") {
    return (
      <Dead
        icon={XCircle}
        title="This ticket link is no longer active"
        body="The batch0 team has withdrawn this invitation. If you think that's a mistake, reply to the email you received."
      />
    );
  }

  if (ticket.status === "refunded") {
    return (
      <Dead
        icon={XCircle}
        title="This ticket was refunded"
        body="The payment for this ticket has been returned to the card it was paid with. It no longer admits you to Demo Day."
      />
    );
  }

  return (
    <div>
      <Row label="Ticket for">{who}</Row>
      {details.when && <Row label="When">{details.when}</Row>}
      {ticket.status === "paid" && details.location && (
        <Row label="Where">{details.location}</Row>
      )}
      {ticket.status === "paid" && details.externalUrl && (
        <Row label="Join link">
          <a
            href={details.externalUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 text-phosphor-ink underline underline-offset-4"
          >
            {details.externalUrl} <ExternalLink className="h-3.5 w-3.5" />
          </a>
        </Row>
      )}
      <Row label={ticket.status === "paid" ? "Paid" : "Price"}>
        <span className="text-2xl font-bold tracking-tight text-phosphor-ink">
          {amount}
        </span>
      </Row>

      {ticket.status === "sent" && ticket.note && (
        <blockquote className="mt-5 border-l-2 border-phosphor/50 pl-4 text-sm text-ink-soft whitespace-pre-wrap">
          {ticket.note}
        </blockquote>
      )}

      {ticket.status === "sent" ? (
        <div className="mt-6">
          <TicketPayButton token={ticket.token} label={`Pay ${amount} & confirm`} />
          <p className="mt-3 text-center text-xs text-ink-faint">
            Secure checkout by Stripe. No batch0 account needed.
          </p>
        </div>
      ) : (
        <div className="mt-6 rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-4 text-sm text-emerald-700 dark:text-emerald-300">
          <div className="flex items-start gap-2">
            <CheckCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <div className="min-w-0 flex-1 text-ink-soft">
              <p className="font-semibold text-emerald-700 dark:text-emerald-300">
                You&rsquo;re on the list.
              </p>
              <p className="mt-1">
                {ticket.user_id
                  ? "This email is on a batch0 account, so the event also shows up under Events on your dashboard."
                  : details.externalUrl
                    ? "Keep this page — the join link above is your way in."
                    : details.hosted
                      ? "Demo Day is streamed on batch0. We'll email you how to join before the day."
                      : "We'll email you the joining details before the day."}
              </p>
              <div className="mt-3 flex flex-wrap gap-x-5 gap-y-2 text-xs">
                {ticket.user_id && (
                  <Link
                    href="/dashboard/events"
                    className="font-medium text-phosphor-ink underline underline-offset-4"
                  >
                    Open your dashboard →
                  </Link>
                )}
                {ticket.stripe_receipt_url && (
                  <a
                    href={ticket.stripe_receipt_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 underline underline-offset-4"
                  >
                    Stripe receipt <ExternalLink className="h-3 w-3" />
                  </a>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 border-t border-line py-3 first:border-t-0 first:pt-0">
      <span className="text-[10px] font-semibold uppercase tracking-[0.2em] text-ink-faint">
        {label}
      </span>
      <span className="min-w-0 text-right text-sm text-ink break-words">
        {children}
      </span>
    </div>
  );
}

function Dead({
  icon: Icon,
  title,
  body,
}: {
  icon: any;
  title: string;
  body: string;
}) {
  return (
    <div className="flex items-start gap-3">
      <Icon className="mt-0.5 h-5 w-5 shrink-0 text-ink-faint" />
      <div>
        <p className="text-sm font-semibold text-ink">{title}</p>
        <p className="mt-1 text-sm text-ink-soft">{body}</p>
      </div>
    </div>
  );
}

const TONES = {
  wait: "border-phosphor/30 bg-phosphor/[0.08] text-phosphor-ink",
  warn: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
  bad: "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300",
} as const;

function Banner({
  tone,
  icon: Icon,
  title,
  children,
}: {
  tone: keyof typeof TONES;
  icon: any;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div
      role="status"
      aria-live="polite"
      className={`mt-6 flex items-start gap-3 rounded-lg border p-4 ${TONES[tone]}`}
    >
      <Icon className="mt-0.5 h-5 w-5 shrink-0" />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold">{title}</p>
        <p className="mt-1 text-sm text-ink-soft">{children}</p>
      </div>
    </div>
  );
}
