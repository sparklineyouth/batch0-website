import Link from "next/link";
import {
  CheckCircle,
  Clock,
  ExternalLink,
  TriangleAlert,
  XCircle,
} from "lucide-react";
import type { FulfillmentResult } from "@/lib/stripe-fulfillment";
import { AutoRefresh } from "./auto-refresh";

function fmtMoney(cents: number, currency = "usd") {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currency.toUpperCase(),
  }).format(cents / 100);
}

/**
 * The banner a student sees the instant they land back from Stripe
 * Checkout. It states what happened to their money in plain words — the
 * one thing every payment flow owes the person paying.
 *
 * Renders nothing when there's no session to report on.
 */
export function PaymentResult({
  result,
}: {
  result: FulfillmentResult | null;
}) {
  if (!result) return null;

  const amount =
    result.amountCents != null ? fmtMoney(result.amountCents) : null;
  const line = [amount, result.description].filter(Boolean).join(" · ");

  if (result.state === "paid") {
    return (
      <Banner
        tone="ok"
        icon={CheckCircle}
        title="Payment confirmed"
        body={
          <>
            {line && <span className="font-medium text-ink">{line}</span>}
            {line && " — "}
            {result.kind === "enrollment"
              ? "your seat is locked in and everything it unlocks is open below."
              : "this is settled; nothing else is owed on it."}
          </>
        }
      >
        {result.receiptUrl && (
          <a
            href={result.receiptUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-3 inline-flex items-center gap-1.5 text-xs font-medium text-emerald-700 hover:underline dark:text-emerald-300"
          >
            View Stripe receipt <ExternalLink className="h-3 w-3" />
          </a>
        )}
      </Banner>
    );
  }

  if (result.state === "processing") {
    return (
      <Banner
        tone="wait"
        icon={Clock}
        title="Payment processing"
        body={
          <>
            {line && <span className="font-medium text-ink">{line}</span>}
            {line && " — "}
            Your bank hasn't finished confirming this one. Nothing is
            unlocked until it clears, usually within a minute. This page
            updates itself — you don't need to reload or pay again.
          </>
        }
      >
        <AutoRefresh />
      </Banner>
    );
  }

  if (result.state === "failed") {
    return (
      <Banner
        tone="bad"
        icon={XCircle}
        title="Payment didn't go through"
        body="Your card was declined and no money was taken. Try again below, or use a different card."
      />
    );
  }

  if (result.state === "expired") {
    return (
      <Banner
        tone="warn"
        icon={TriangleAlert}
        title="Checkout expired"
        body="That checkout session timed out before it was paid. Nothing was charged — start a new one whenever you're ready."
      />
    );
  }

  // Unknown: don't guess. Say so and point at the record of truth.
  return (
    <Banner
      tone="warn"
      icon={TriangleAlert}
      title="We couldn't confirm that payment"
      body={
        <>
          Nothing here is proof it failed — check{" "}
          <Link
            href="/dashboard/billing"
            className="font-medium underline underline-offset-2"
          >
            your billing page
          </Link>{" "}
          for the current state, and email us if something looks wrong.
        </>
      }
    />
  );
}

const TONES = {
  ok: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  wait: "border-phosphor/30 bg-phosphor/[0.08] text-phosphor-ink",
  warn: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
  bad: "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300",
} as const;

function Banner({
  tone,
  icon: Icon,
  title,
  body,
  children,
}: {
  tone: keyof typeof TONES;
  icon: any;
  title: string;
  body: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <div
      role="status"
      aria-live="polite"
      className={`mt-5 flex items-start gap-3 rounded-lg border p-4 ${TONES[tone]}`}
    >
      <Icon className="mt-0.5 h-5 w-5 shrink-0" />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold">{title}</p>
        <p className="mt-1 text-sm text-ink-soft">{body}</p>
        {children}
      </div>
    </div>
  );
}
