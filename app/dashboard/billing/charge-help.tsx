import Link from "next/link";
import { REFUND_WINDOW_HOURS } from "@/lib/support-access";

/**
 * The billing pages' doors into Support: /dashboard/billing and its receipts
 * page both list the viewer's charges, and both offer the same help on each
 * one. Shared from here because a page.tsx may only export what Next expects
 * of a page.
 *
 * Server-safe: plain links and arithmetic, nothing from lib/support.ts (which
 * runs on the service role and has no business in a page's render path).
 */

/**
 * A link into the dashboard's request form, preset for a money question.
 *
 * `payment` is the row's own id — a tuition payment, a fee or fine, or a Demo
 * Day ticket, each read by the page for this viewer — so the form can
 * preselect "which charge is this about?" instead of asking someone to copy a
 * Stripe id off a receipt. The form re-verifies that it's theirs; an id in a
 * URL grants nothing. No `from`: `source` already says billing, and the id
 * says which charge.
 */
export function billingSupportHref(
  topic: "billing" | "refund",
  paymentId?: string,
): string {
  const q = new URLSearchParams({ topic });
  if (paymentId) q.set("payment", paymentId);
  q.set("source", "billing");
  return `/dashboard/support/new?${q.toString()}`;
}

/** The columns of a `payments` row that inRefundWindow reads. */
export type RefundablePayment = {
  status: string;
  amount_cents: number;
  amount_refunded_cents?: number | null;
  paid_at?: string | null;
};

/**
 * Is a refund request for this tuition payment still inside the refund
 * policy's window — would one filed right now arrive within 48 hours of
 * paying? Decided on the server's clock, never the browser's. Same boundary
 * as refundWindow() in lib/support-access.ts (48:00:00 is inside), measured
 * from `paid_at` — when the processor confirmed the charge, which is what the
 * policy counts from — and never from `created_at`, which is when checkout
 * started. No recorded paid time, no link: "Problem with this charge?" still
 * reaches the same people, and a guess could show the link on the wrong side
 * of the deadline.
 *
 * Tuition only, which is why it takes a `payments` row. The policy's 48-hour
 * right is tuition's alone and Demo Day tickets are final sale
 * (app/(legal)/refund-policy), so "Request a refund" on any other row would
 * invite a request the policy then refuses.
 */
export function inRefundWindow(p: RefundablePayment, nowMs: number): boolean {
  if (p.status !== "succeeded") return false;
  if ((p.amount_refunded_cents ?? 0) >= p.amount_cents) return false;
  const paidMs = p.paid_at ? Date.parse(p.paid_at) : NaN;
  return Number.isFinite(paidMs) && nowMs - paidMs <= REFUND_WINDOW_HOURS * 3_600_000;
}

/** Quiet, but still recognisably a link: these are help, not calls to action. */
export const HELP_LINK =
  "text-ink-soft underline decoration-line underline-offset-2 hover:text-ink hover:decoration-phosphor";

/**
 * The help line under one charge. `refund` adds "Request a refund" — pass
 * inRefundWindow() for a tuition payment, nothing for anything else.
 * prefetch={false}: these are authed routes, and a list of charges would
 * otherwise prefetch the form once per row.
 */
export function ChargeHelp({
  id,
  refund = false,
  className = "",
}: {
  id: string;
  refund?: boolean;
  className?: string;
}) {
  return (
    <div className={`flex flex-wrap gap-x-3 gap-y-0.5 text-xs ${className}`}>
      {refund && (
        <Link href={billingSupportHref("refund", id)} prefetch={false} className={HELP_LINK}>
          Request a refund
        </Link>
      )}
      <Link href={billingSupportHref("billing", id)} prefetch={false} className={HELP_LINK}>
        Problem with this charge?
      </Link>
    </div>
  );
}
