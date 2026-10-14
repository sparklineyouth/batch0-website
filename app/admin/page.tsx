import Link from "next/link";
import { revenueSummary, auxiliaryRevenueRow } from "@/lib/revenue-ledger";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireAdminArea } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { countTicketsNeedingReply } from "@/lib/support";
import { ArrowRight, Inbox, CreditCard, LifeBuoy } from "lucide-react";
import type { LucideIcon } from "lucide-react";

export const metadata = { title: "Admin · batch0" };

function fmtMoney(cents: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  }).format(cents / 100);
}

type InboxItem = { icon: LucideIcon; label: string; count: number; href: string };

export default async function AdminOverview() {
  // Every admin-area role lands here, so each block is gated by the same
  // permission as the page it links to — an intern without `payments.view`
  // must not learn revenue from the overview.
  const { caps } = await requireAdminArea();
  const seeApplications = can(caps, "applications.view");
  const seeRevenue = can(caps, "payments.view");
  const seeSupport = can(caps, "support.view");

  const admin = createAdminClient();
  const noRows = { data: null, error: null };

  const [
    { count: pendingApps },
    { count: acceptedApps },
    payments,
    charges,
    tickets,
    openTickets,
  ] = await Promise.all([
    seeApplications
      ? admin
          .from("applications")
          .select("id", { count: "exact", head: true })
          .eq("status", "submitted")
      : { count: null },
    seeApplications
      ? admin
          .from("applications")
          .select("id", { count: "exact", head: true })
          .eq("status", "accepted")
      : { count: null },
    // Revenue sums rows in JS, capped explicitly — past ~10k rows this needs
    // a SQL aggregate instead.
    seeRevenue
      ? admin
          .from("payments")
          .select("amount_cents, amount_refunded_cents, currency, user_id, paid_at, status")
          .in("status", ["succeeded", "refunded"])
          .limit(10000)
      : noRows,
    seeRevenue
      ? admin
          .from("user_charges")
          .select("amount_cents, captured_amount_cents, captured_currency, amount_refunded_cents, status")
          .in("status", ["paid", "refunded"])
          .limit(10000)
      : noRows,
    seeRevenue
      ? admin
          .from("demo_day_tickets")
          .select("amount_cents, captured_amount_cents, captured_currency, amount_refunded_cents, status")
          .in("status", ["paid", "refunded"])
          .limit(10000)
      : noRows,
    seeSupport ? countTicketsNeedingReply() : Promise.resolve(0),
  ]);

  const inbox: InboxItem[] = [
    ...(seeApplications
      ? [
          {
            icon: Inbox,
            label: "Pending review",
            count: pendingApps ?? 0,
            href: "/admin/applications?status=submitted",
          },
          {
            icon: CreditCard,
            label: "Awaiting payment",
            count: acceptedApps ?? 0,
            href: "/admin/applications?status=accepted",
          },
        ]
      : []),
    ...(seeSupport
      ? [
          {
            icon: LifeBuoy,
            label: "Support awaiting reply",
            count: openTickets,
            href: "/admin/support",
          },
        ]
      : []),
  ];

  // One number: USD tuition + fees + Demo Day tickets, net of refunds
  // (lib/revenue-ledger). A failed read shows as unavailable, never as $0.
  const revenueError = payments.error || charges.error || tickets.error;
  const revenueCents = revenueError
    ? null
    : revenueSummary(payments.data ?? []).netCents +
      revenueSummary((charges.data ?? []).map(auxiliaryRevenueRow)).netCents +
      revenueSummary((tickets.data ?? []).map(auxiliaryRevenueRow)).netCents;

  return (
    <div className="mx-auto max-w-6xl">
      <h1 className="font-display text-4xl font-bold tracking-[-0.02em] text-ink">
        Overview
      </h1>

      {inbox.length > 0 && (
        <section className="mt-8 grid gap-3 sm:grid-cols-[repeat(auto-fit,minmax(14rem,1fr))]">
          {inbox.map((it) => {
            const hot = it.count > 0;
            return (
              <Link
                key={it.label}
                href={it.href}
                className="press group flex items-center gap-4 rounded-xl border border-line bg-wash px-5 py-4 hover:border-ink/30"
              >
                <it.icon
                  className={`h-5 w-5 shrink-0 ${hot ? "text-phosphor-ink" : "text-ink-faint"}`}
                />
                <div className="min-w-0 flex-1">
                  <p className="text-[10px] font-mono font-medium uppercase tracking-[0.2em] text-ink-faint">
                    {it.label}
                  </p>
                  <p
                    className={`mt-1 text-3xl font-semibold tracking-tight tabular-nums ${
                      hot ? "text-phosphor-ink" : "text-ink"
                    }`}
                  >
                    {it.count}
                  </p>
                </div>
                <ArrowRight className="h-4 w-4 shrink-0 text-ink-faint group-hover:text-ink" />
              </Link>
            );
          })}
        </section>
      )}

      {seeRevenue && (
        <Link
          href="/admin/payments"
          className="press group mt-8 flex items-center gap-4 border-y border-line py-6 hover:bg-wash"
        >
          <div className="min-w-0 flex-1">
            <p className="text-[10px] font-mono font-medium uppercase tracking-[0.22em] text-ink-faint">
              Revenue after refunds
            </p>
            <p className="mt-2 text-3xl lg:text-4xl font-semibold tracking-tight tabular-nums text-ink">
              {revenueCents === null ? "Unavailable" : fmtMoney(revenueCents)}
            </p>
            <p className="mt-1 text-[11px] text-ink-faint">USD · tuition, fees and tickets</p>
          </div>
          <ArrowRight className="h-4 w-4 shrink-0 text-ink-faint group-hover:text-ink" />
        </Link>
      )}

      {inbox.length === 0 && !seeRevenue && (
        <p className="mt-6 text-sm text-ink-soft">Your sections are in the sidebar.</p>
      )}
    </div>
  );
}
