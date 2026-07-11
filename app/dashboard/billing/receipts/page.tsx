import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { requireUser } from "@/lib/auth";
import { Card, StatusBadge } from "@/components/ui/card";
import { LocalTime } from "@/components/ui/local-time";
import { ArrowLeft, Download, FileText, Receipt } from "lucide-react";

export const metadata = { title: "Receipts · Sparkline Youth" };

function fmtMoney(cents: number, currency = "usd") {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currency.toUpperCase(),
  }).format(cents / 100);
}

// Unified row type — payments and user_charges live in different tables
// and have different lifecycles, but for the receipts inbox the user
// just wants to see "what was charged, when, and how much" in one place.
type Row = {
  id: string;
  date: string;
  source: "payment" | "fee" | "fine";
  description: string;
  amountCents: number;
  currency: string;
  status: string;
  receiptUrl: string | null;
  // Refunds reduce a row's effective amount but we keep the original
  // figure so totals match what the user actually saw on their card.
  refunded: boolean;
};

export default async function ReceiptsPage({
  searchParams,
}: {
  searchParams: { year?: string };
}) {
  const user = await requireUser();
  const supabase = createClient();

  const [{ data: payments }, { data: charges }] = await Promise.all([
    supabase
      .from("payments")
      .select(
        "id, created_at, amount_cents, currency, status, stripe_receipt_url",
      )
      .eq("user_id", user.id)
      .order("created_at", { ascending: false }),
    supabase
      .from("user_charges")
      .select(
        "id, created_at, paid_at, refunded_at, amount_cents, kind, description, status, stripe_receipt_url",
      )
      .eq("user_id", user.id)
      .order("created_at", { ascending: false }),
  ]);

  const rows: Row[] = [
    ...(payments ?? []).map((p: any) => ({
      id: `p:${p.id}`,
      date: p.created_at,
      source: "payment" as const,
      description: "Cohort enrollment",
      amountCents: p.amount_cents,
      currency: p.currency ?? "usd",
      status: p.status,
      receiptUrl: p.stripe_receipt_url ?? null,
      refunded: p.status === "refunded",
    })),
    ...(charges ?? []).map((c: any) => ({
      id: `c:${c.id}`,
      date: c.paid_at ?? c.refunded_at ?? c.created_at,
      source: (c.kind === "fine" ? "fine" : "fee") as "fee" | "fine",
      description: c.description ?? (c.kind === "fine" ? "Fine" : "Fee"),
      amountCents: c.amount_cents,
      currency: "usd",
      status: c.status,
      receiptUrl: c.stripe_receipt_url ?? null,
      refunded: c.status === "refunded",
    })),
  ].sort((a, b) => (a.date < b.date ? 1 : -1));

  // Year filter — derived from data, not hardcoded, so it auto-updates.
  const years = Array.from(
    new Set(rows.map((r) => new Date(r.date).getUTCFullYear())),
  ).sort((a, b) => b - a);
  const selectedYear = searchParams.year ? Number(searchParams.year) : null;
  const filteredRows = selectedYear
    ? rows.filter((r) => new Date(r.date).getUTCFullYear() === selectedYear)
    : rows;

  // Totals (paid only, refunds subtracted). Refunded rows count zero
  // since the money came back. Pending and failed rows don't count.
  const totals = filteredRows.reduce(
    (acc, r) => {
      const cents = r.amountCents;
      if (r.status === "succeeded" || r.status === "paid") {
        acc.paid += cents;
      }
      if (r.status === "refunded") acc.refunded += cents;
      return acc;
    },
    { paid: 0, refunded: 0 },
  );
  const netPaid = totals.paid - totals.refunded;

  return (
    <div className="mx-auto max-w-3xl">
      <Link
        href="/dashboard/billing"
        className="inline-flex items-center gap-1.5 text-sm text-white/55 hover:text-white"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        Back to billing
      </Link>
      <div className="mt-3 flex items-baseline justify-between gap-3">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Receipts</h1>
          <p className="mt-1 text-sm text-white/55">
            Every charge, payment, and refund on your account. Download a
            Stripe receipt for tax records.
          </p>
        </div>
      </div>

      <section className="mt-6 grid gap-3 md:grid-cols-3">
        <Tile
          icon={Receipt}
          label={selectedYear ? `${selectedYear} paid` : "Total paid"}
          value={fmtMoney(netPaid)}
          hint={
            totals.refunded > 0
              ? `${fmtMoney(totals.paid)} charged · ${fmtMoney(totals.refunded)} refunded`
              : undefined
          }
        />
        <Tile
          icon={FileText}
          label="Receipts available"
          value={String(
            filteredRows.filter((r) => Boolean(r.receiptUrl)).length,
          )}
          hint={`${filteredRows.length} total rows`}
        />
        <Tile
          icon={Download}
          label="Refunded"
          value={fmtMoney(totals.refunded)}
        />
      </section>

      {years.length > 1 && (
        <div className="mt-6 flex flex-wrap items-center gap-2">
          <span className="text-xs uppercase tracking-wider text-white/40">
            Year
          </span>
          <Link
            href="/dashboard/billing/receipts"
            className={`rounded-full border px-3 py-1 text-xs uppercase tracking-wider transition ${
              !selectedYear
                ? "border-spark bg-spark/10 text-spark"
                : "border-white/15 text-white/60 hover:border-white/30 hover:text-white"
            }`}
          >
            All
          </Link>
          {years.map((y) => (
            <Link
              key={y}
              href={`/dashboard/billing/receipts?year=${y}`}
              className={`rounded-full border px-3 py-1 text-xs uppercase tracking-wider transition ${
                selectedYear === y
                  ? "border-spark bg-spark/10 text-spark"
                  : "border-white/15 text-white/60 hover:border-white/30 hover:text-white"
              }`}
            >
              {y}
            </Link>
          ))}
        </div>
      )}

      <Card className="mt-6 !p-0 overflow-hidden">
        {filteredRows.length === 0 ? (
          <p className="p-6 text-sm text-white/55">
            {selectedYear
              ? `No charges in ${selectedYear}.`
              : "No charges yet. Receipts will appear here after your first payment."}
          </p>
        ) : (
          <ul className="divide-y divide-white/10">
            {filteredRows.map((r) => (
              <li
                key={r.id}
                className="flex flex-wrap items-center gap-3 px-5 py-4"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <SourceBadge source={r.source} />
                    <span className="text-sm font-medium text-white">
                      {r.description}
                    </span>
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-white/45">
                    <LocalTime value={r.date} />
                  </div>
                </div>
                <div className="text-right">
                  <div
                    className={`text-base font-semibold tabular-nums ${
                      r.refunded ? "text-white/40 line-through" : "text-white"
                    }`}
                  >
                    {fmtMoney(r.amountCents, r.currency)}
                  </div>
                  <div className="mt-0.5">
                    <StatusBadge status={r.status} />
                  </div>
                </div>
                <div className="shrink-0">
                  {r.receiptUrl ? (
                    <a
                      href={r.receiptUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1.5 rounded-lg border border-white/15 bg-white/5 px-3 py-1.5 text-xs font-medium text-white/80 hover:bg-white/10"
                    >
                      <Download className="h-3.5 w-3.5" />
                      Receipt
                    </a>
                  ) : (
                    <span className="text-[11px] text-white/30">
                      {r.status === "pending" || r.status === "failed"
                        ? "—"
                        : "Older charge"}
                    </span>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <p className="mt-4 text-[11px] text-white/35">
        Receipts are hosted by Stripe. Older charges from before the receipt
        archive was rolled out may not have a downloadable link — request one
        from{" "}
        <a href="mailto:hello@sparklineyouth.org" className="text-spark hover:underline">
          hello@sparklineyouth.org
        </a>{" "}
        if you need it for taxes.
      </p>
    </div>
  );
}

function SourceBadge({ source }: { source: "payment" | "fee" | "fine" }) {
  const config = {
    payment: { label: "Enrollment", cls: "bg-spark/15 text-spark" },
    fee: { label: "Fee", cls: "bg-amber-300/15 text-amber-200" },
    fine: { label: "Fine", cls: "bg-red-400/15 text-red-300" },
  } as const;
  const { label, cls } = config[source];
  return (
    <span
      className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${cls}`}
    >
      {label}
    </span>
  );
}

function Tile({
  icon: Icon,
  label,
  value,
  hint,
}: {
  icon: any;
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.02] px-4 py-4">
      <div className="flex items-center gap-2 text-[10px] font-medium uppercase tracking-[0.2em] text-white/45">
        <Icon className="h-3.5 w-3.5" />
        {label}
      </div>
      <div className="mt-2 text-2xl font-semibold tracking-tight text-white tabular-nums">
        {value}
      </div>
      {hint && <div className="mt-1 text-[11px] text-white/45">{hint}</div>}
    </div>
  );
}
