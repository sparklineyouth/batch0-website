import { createClient } from "@/lib/supabase/server";
import { requireUser } from "@/lib/auth";
import { Card, StatusBadge } from "@/components/ui/card";

export const metadata = { title: "Billing · SparkLine" };

function fmtMoney(cents: number, currency = "usd") {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currency.toUpperCase(),
  }).format(cents / 100);
}

export default async function BillingPage() {
  const user = await requireUser();
  const supabase = createClient();

  const { data: payments } = await supabase
    .from("payments")
    .select("*")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false });

  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="text-3xl font-bold tracking-tight">Billing</h1>
      <p className="mt-1 text-sm text-white/50">
        Your payment history. SparkLine charges a single $97 enrollment fee — no subscriptions.
      </p>

      <Card className="mt-8">
        {(payments?.length ?? 0) === 0 ? (
          <p className="text-sm text-white/50">No payments yet.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-white/10 text-left text-xs uppercase tracking-wider text-white/40">
                <th className="pb-3">Date</th>
                <th className="pb-3">Amount</th>
                <th className="pb-3">Status</th>
              </tr>
            </thead>
            <tbody>
              {payments!.map((p) => (
                <tr key={p.id} className="border-b border-white/5 last:border-0">
                  <td className="py-3 text-white/80">
                    {new Date(p.created_at).toLocaleString()}
                  </td>
                  <td className="py-3 text-white/80">
                    {fmtMoney(p.amount_cents, p.currency)}
                  </td>
                  <td className="py-3">
                    <StatusBadge status={p.status} />
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
