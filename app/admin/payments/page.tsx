import { createAdminClient } from "@/lib/supabase/admin";
import { Card, StatusBadge } from "@/components/ui/card";

export const metadata = { title: "Payments · Admin" };

function fmtMoney(cents: number, currency = "usd") {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currency.toUpperCase(),
  }).format(cents / 100);
}

export default async function AdminPaymentsPage() {
  const admin = createAdminClient();
  const { data: payments } = await admin
    .from("payments")
    .select("*, profile:profiles(email, full_name)")
    .order("created_at", { ascending: false });

  const succeededTotal = (payments ?? [])
    .filter((p) => p.status === "succeeded")
    .reduce((s, p) => s + (p.amount_cents ?? 0), 0);

  return (
    <div className="mx-auto max-w-6xl">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Payments</h1>
          <p className="mt-1 text-sm text-white/50">All Stripe activity.</p>
        </div>
        <div className="text-right">
          <div className="text-xs uppercase tracking-wider text-white/40">
            Succeeded total
          </div>
          <div className="text-2xl font-bold text-spark">
            {fmtMoney(succeededTotal)}
          </div>
        </div>
      </div>

      <Card className="mt-6 !p-0 overflow-hidden">
        {(payments?.length ?? 0) === 0 ? (
          <p className="p-6 text-sm text-white/50">No payments yet.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-white/10 text-left text-xs uppercase tracking-wider text-white/40">
                <th className="px-5 py-3">Date</th>
                <th className="px-5 py-3">Student</th>
                <th className="px-5 py-3">Amount</th>
                <th className="px-5 py-3">Status</th>
                <th className="px-5 py-3">Stripe</th>
              </tr>
            </thead>
            <tbody>
              {(payments ?? []).map((p: any) => (
                <tr
                  key={p.id}
                  className="border-b border-white/5 last:border-0"
                >
                  <td className="px-5 py-3 text-white/70">
                    {new Date(p.created_at).toLocaleString()}
                  </td>
                  <td className="px-5 py-3">
                    <div className="text-white">
                      {p.profile?.full_name || "—"}
                    </div>
                    <div className="text-xs text-white/40">
                      {p.profile?.email}
                    </div>
                  </td>
                  <td className="px-5 py-3 text-white/80">
                    {fmtMoney(p.amount_cents, p.currency)}
                  </td>
                  <td className="px-5 py-3">
                    <StatusBadge status={p.status} />
                  </td>
                  <td className="px-5 py-3 font-mono text-[11px] text-white/50">
                    {p.stripe_payment_intent_id ?? p.stripe_session_id ?? "—"}
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
