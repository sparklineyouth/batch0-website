/** Captured money, refunds and people are different measures. Amounts in cents. */
export type RevenueRow = {
  amount_cents: number;
  amount_refunded_cents?: number | null;
  status: string;
  currency?: string | null;
  user_id?: string | null;
  application_id?: string | null;
  paid_at?: string | null;
};
export function refundCents(row: RevenueRow): number {
  return Math.min(row.amount_cents, Math.max(0, row.status === "refunded" ? row.amount_cents : row.amount_refunded_cents ?? 0));
}
export function retainedCents(row: RevenueRow): number {
  return ["succeeded", "paid", "refunded"].includes(row.status)
    ? Math.max(0, row.amount_cents - refundCents(row)) : 0;
}
export function revenueSummary(rows: RevenueRow[], currency = "usd") {
  const captured = rows.filter(r => ["succeeded", "paid", "refunded"].includes(r.status) && (r.currency ?? "usd").toLowerCase() === currency);
  const grossCents = captured.reduce((n,r) => n + r.amount_cents,0);
  const refundedCents = captured.reduce((n,r) => n + refundCents(r),0);
  return {
    grossCents, refundedCents, netCents: grossCents - refundedCents,
    payingUsers: new Set(captured.filter(r => retainedCents(r) > 0 && r.user_id).map(r => r.user_id!)),
    paidApplications: new Set(captured.filter(r => retainedCents(r) > 0 && r.application_id).map(r => r.application_id!)),
    unknownPaidDates: captured.filter(r => !r.paid_at).length,
    otherCurrencyCount: rows.filter(r => r.currency && r.currency.toLowerCase() !== currency).length,
  };
}
/** Auxiliary tables keep their quoted amount separate from verified capture. */
export function auxiliaryRevenueRow(row: any): RevenueRow {
  return { ...row, amount_cents: row.captured_amount_cents ?? row.amount_cents,
    currency: row.captured_currency ?? row.currency ?? "usd" };
}
