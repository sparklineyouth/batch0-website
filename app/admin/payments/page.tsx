import Link from "next/link";
import { createAdminClient } from "@/lib/supabase/admin";
import { Card, StatusBadge } from "@/components/ui/card";
import { LocalTime } from "@/components/ui/local-time";
import { RefundButton } from "./refund-button";

export const metadata = { title: "Payments · Admin" };

const STATUSES = ["all", "succeeded", "pending", "failed", "refunded"] as const;
type StatusFilter = (typeof STATUSES)[number];

function fmtMoney(cents: number, currency = "usd") {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currency.toUpperCase(),
  }).format(cents / 100);
}

export default async function AdminPaymentsPage({
  searchParams,
}: {
  searchParams: { status?: string; cohort?: string };
}) {
  const admin = createAdminClient();

  // Pull everything once; the dataset is small (one purchase per student).
  const [{ data: payments }, { data: cohorts }] = await Promise.all([
    admin
      .from("payments")
      .select("*, profile:profiles(email, full_name), cohort:cohorts(id, name)")
      .order("created_at", { ascending: false }),
    admin.from("cohorts").select("id, name").order("starts_on"),
  ]);

  const all = (payments ?? []) as any[];

  const statusFilter: StatusFilter = (STATUSES.find(
    (s) => s === searchParams.status,
  ) ?? "all") as StatusFilter;
  const cohortFilter = searchParams.cohort ?? "all";

  const filtered = all.filter((p) => {
    if (statusFilter !== "all" && p.status !== statusFilter) return false;
    if (cohortFilter !== "all" && (p.cohort_id ?? "") !== cohortFilter) {
      return false;
    }
    return true;
  });

  const succeededAll = all.filter((p) => p.status === "succeeded");
  const refundedAll = all.filter((p) => p.status === "refunded");
  const grossCents = succeededAll.reduce(
    (s, p) => s + (p.amount_cents ?? 0),
    0,
  );
  const refundedCents = refundedAll.reduce(
    (s, p) => s + (p.amount_cents ?? 0),
    0,
  );
  const netCents = grossCents - refundedCents;
  const payingStudents = new Set(succeededAll.map((p) => p.user_id)).size;
  const avgCents =
    succeededAll.length > 0 ? Math.round(grossCents / succeededAll.length) : 0;
  const pendingCount = all.filter((p) => p.status === "pending").length;
  const failedCount = all.filter((p) => p.status === "failed").length;

  // Per-cohort breakdown — only count succeeded.
  const byCohort = new Map<
    string,
    { name: string; gross: number; count: number }
  >();
  for (const p of succeededAll) {
    const id = p.cohort_id ?? "unassigned";
    const name = p.cohort?.name ?? "Unassigned";
    const cur = byCohort.get(id) ?? { name, gross: 0, count: 0 };
    cur.gross += p.amount_cents ?? 0;
    cur.count += 1;
    byCohort.set(id, cur);
  }
  const cohortRows = Array.from(byCohort.entries())
    .map(([id, v]) => ({ id, ...v }))
    .sort((a, b) => b.gross - a.gross);

  return (
    <div className="mx-auto max-w-6xl">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-3xl font-bold tracking-[-0.02em] text-ink">Payments</h1>
          <p className="mt-1 text-sm text-ink-faint">
            Stripe activity, revenue, and per-cohort breakdown.
          </p>
        </div>
        <a
          href="/api/admin/export/payments"
          className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-wash px-3 py-1.5 text-xs font-medium text-ink-soft hover:border-ink/30 hover:bg-wash"
        >
          Export CSV
        </a>
      </div>

      {/* Stat tiles */}
      <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          label="Net revenue"
          value={fmtMoney(netCents)}
          sub={`Gross ${fmtMoney(grossCents)} · Refunded ${fmtMoney(refundedCents)}`}
          accent
        />
        <Stat
          label="Paying students"
          value={payingStudents.toString()}
          sub={`${succeededAll.length} successful charges`}
        />
        <Stat
          label="Avg payment"
          value={fmtMoney(avgCents)}
          sub="Mean of succeeded charges"
        />
        <Stat
          label="Open"
          value={`${pendingCount} pending`}
          sub={`${failedCount} failed`}
          warn={pendingCount + failedCount > 0}
        />
      </div>

      {/* Cohort breakdown */}
      <Card className="mt-8">
        <div className="mb-4 flex items-baseline justify-between">
          <h2 className="text-lg font-semibold text-ink">Revenue by cohort</h2>
          <span className="text-xs text-ink-faint">Succeeded only</span>
        </div>
        {cohortRows.length === 0 ? (
          <p className="text-sm text-ink-faint">No revenue yet.</p>
        ) : (
          <ul className="space-y-3">
            {cohortRows.map((c) => {
              const pct = grossCents > 0 ? (c.gross / grossCents) * 100 : 0;
              return (
                <li key={c.id}>
                  <div className="mb-1 flex items-baseline justify-between text-sm">
                    <span className="text-ink">{c.name}</span>
                    <span className="text-ink-soft">
                      {fmtMoney(c.gross)} · {c.count} student
                      {c.count === 1 ? "" : "s"}
                    </span>
                  </div>
                  <div className="h-1.5 w-full overflow-hidden rounded-full bg-wash">
                    <div
                      className="h-full bg-spark"
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      {/* Filters */}
      <div className="mt-8 flex flex-wrap items-center gap-2">
        <span className="text-xs uppercase tracking-wider text-ink-faint">
          Status
        </span>
        {STATUSES.map((s) => {
          const active = statusFilter === s;
          const params = new URLSearchParams();
          if (s !== "all") params.set("status", s);
          if (cohortFilter !== "all") params.set("cohort", cohortFilter);
          const href = `/admin/payments${params.toString() ? `?${params}` : ""}`;
          return (
            <Link
              key={s}
              href={href}
              className={`rounded-full border px-3 py-1 text-xs uppercase tracking-wider transition ${
                active
                  ? "border-spark bg-spark/10 text-spark"
                  : "border-line text-ink-soft hover:border-ink/30 hover:text-ink"
              }`}
            >
              {s}
            </Link>
          );
        })}
        <span className="ml-4 text-xs uppercase tracking-wider text-ink-faint">
          Cohort
        </span>
        <CohortFilter
          cohorts={cohorts ?? []}
          selected={cohortFilter}
          status={statusFilter}
        />
      </div>

      {/* Transactions table */}
      <Card className="mt-4 !p-0 overflow-hidden">
        {filtered.length === 0 ? (
          <p className="p-6 text-sm text-ink-faint">No payments match.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line text-left text-xs uppercase tracking-wider text-ink-faint">
                <th className="px-5 py-3">Date</th>
                <th className="px-5 py-3">Student</th>
                <th className="px-5 py-3">Cohort</th>
                <th className="px-5 py-3">Amount</th>
                <th className="px-5 py-3">Status</th>
                <th className="px-5 py-3">Stripe ID</th>
                <th className="px-5 py-3"></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((p: any) => (
                <tr
                  key={p.id}
                  className="border-b border-line last:border-0 hover:bg-wash"
                >
                  <td className="px-5 py-3 text-ink-soft">
                    <LocalTime value={p.created_at} />
                  </td>
                  <td className="px-5 py-3">
                    <div className="text-ink">
                      {p.profile?.full_name || "—"}
                    </div>
                    <div className="text-xs text-ink-faint">
                      {p.profile?.email}
                    </div>
                  </td>
                  <td className="px-5 py-3 text-ink-soft">
                    {p.cohort?.name ?? <span className="text-ink-faint">—</span>}
                  </td>
                  <td className="px-5 py-3 text-ink-soft">
                    {fmtMoney(p.amount_cents, p.currency)}
                  </td>
                  <td className="px-5 py-3">
                    <StatusBadge status={p.status} />
                  </td>
                  <td className="px-5 py-3 font-mono text-[11px] text-ink-faint">
                    {p.stripe_payment_intent_id ?? p.stripe_session_id ?? "—"}
                  </td>
                  <td className="px-5 py-3 text-right">
                    {p.status === "succeeded" && (
                      <RefundButton
                        paymentId={p.id}
                        amountLabel={fmtMoney(p.amount_cents, p.currency)}
                      />
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}

function Stat({
  label,
  value,
  sub,
  accent,
  warn,
}: {
  label: string;
  value: string;
  sub?: string;
  accent?: boolean;
  warn?: boolean;
}) {
  return (
    <Card>
      <div className="text-xs font-medium uppercase tracking-wider text-ink-faint">
        {label}
      </div>
      <div
        className={`mt-2 text-3xl font-bold tracking-tight ${
          accent ? "text-spark-ink" : warn ? "text-amber-700 dark:text-amber-300" : "text-ink"
        }`}
      >
        {value}
      </div>
      {sub && <div className="mt-1 text-xs text-ink-faint">{sub}</div>}
    </Card>
  );
}

function CohortFilter({
  cohorts,
  selected,
  status,
}: {
  cohorts: { id: string; name: string }[];
  selected: string;
  status: string;
}) {
  function hrefFor(cohort: string) {
    const params = new URLSearchParams();
    if (status !== "all") params.set("status", status);
    if (cohort !== "all") params.set("cohort", cohort);
    return `/admin/payments${params.toString() ? `?${params}` : ""}`;
  }
  const opts = [{ id: "all", name: "All" }, ...cohorts];
  return (
    <div className="flex flex-wrap gap-2">
      {opts.map((c) => {
        const active = selected === c.id;
        return (
          <Link
            key={c.id}
            href={hrefFor(c.id)}
            className={`rounded-full border px-3 py-1 text-xs uppercase tracking-wider transition ${
              active
                ? "border-spark bg-spark/10 text-spark"
                : "border-line text-ink-soft hover:border-ink/30 hover:text-ink"
            }`}
          >
            {c.name}
          </Link>
        );
      })}
    </div>
  );
}
