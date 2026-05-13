import { createClient } from "@/lib/supabase/server";
import { requireUser } from "@/lib/auth";
import { Card, StatusBadge } from "@/components/ui/card";
import { LocalTime } from "@/components/ui/local-time";
import { PortalButton } from "./portal-button";
import { ChargePayButton } from "@/components/charge-pay-button";

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

  const [{ data: payments }, { data: profile }, { data: charges }] =
    await Promise.all([
      supabase
        .from("payments")
        .select("*")
        .eq("user_id", user.id)
        .order("created_at", { ascending: false }),
      supabase
        .from("profiles")
        .select("stripe_customer_id")
        .eq("id", user.id)
        .maybeSingle(),
      supabase
        .from("user_charges")
        .select("*")
        .eq("user_id", user.id)
        .order("created_at", { ascending: false }),
    ]);

  const hasStripeCustomer = Boolean(profile?.stripe_customer_id);
  const pending = (charges ?? []).filter((c: any) => c.status === "pending");
  const history = (charges ?? []).filter((c: any) => c.status !== "pending");

  return (
    <div className="mx-auto max-w-3xl">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Billing</h1>
          <p className="mt-1 text-sm text-white/55">
            Your payment history and any fees or fines on your account.
          </p>
        </div>
        {hasStripeCustomer && <PortalButton />}
      </div>

      {pending.length > 0 && (
        <Card className="mt-6 border-amber-300/30 bg-amber-300/5">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-amber-200">
            Outstanding charges
          </h2>
          <ul className="space-y-3">
            {pending.map((c: any) => (
              <li
                key={c.id}
                className="flex flex-wrap items-start justify-between gap-3 border-t border-white/5 pt-3 first:border-t-0 first:pt-0"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span
                      className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${
                        c.kind === "fine"
                          ? "bg-red-400/10 text-red-300"
                          : "bg-amber-300/10 text-amber-200"
                      }`}
                    >
                      {c.kind}
                    </span>
                    <span className="text-sm font-medium text-white">
                      {c.description}
                    </span>
                  </div>
                  <p className="mt-0.5 text-xs text-white/45">
                    Issued <LocalTime value={c.created_at} />
                  </p>
                </div>
                <div className="flex items-center gap-3">
                  <span className="text-base font-bold text-spark">
                    {fmtMoney(c.amount_cents)}
                  </span>
                  <ChargePayButton chargeId={c.id} />
                </div>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Card className="mt-6">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-white/55">
          Payment history
        </h2>
        {(payments?.length ?? 0) === 0 && history.length === 0 ? (
          <p className="text-sm text-white/55">No payments yet.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-white/10 text-left text-xs uppercase tracking-wider text-white/40">
                <th className="pb-3">Date</th>
                <th className="pb-3">Description</th>
                <th className="pb-3">Amount</th>
                <th className="pb-3">Status</th>
              </tr>
            </thead>
            <tbody>
              {(payments ?? []).map((p) => (
                <tr key={p.id} className="border-b border-white/5">
                  <td className="py-3 text-white/80">
                    <LocalTime value={p.created_at} />
                  </td>
                  <td className="py-3 text-white/70">Cohort enrollment</td>
                  <td className="py-3 text-white/80">
                    {fmtMoney(p.amount_cents, p.currency)}
                  </td>
                  <td className="py-3">
                    <StatusBadge status={p.status} />
                  </td>
                </tr>
              ))}
              {history.map((c: any) => (
                <tr key={c.id} className="border-b border-white/5 last:border-0">
                  <td className="py-3 text-white/80">
                    <LocalTime value={c.created_at} />
                  </td>
                  <td className="py-3 text-white/70">
                    {c.kind === "fine" ? "Fine" : "Fee"}: {c.description}
                  </td>
                  <td className="py-3 text-white/80">
                    {fmtMoney(c.amount_cents)}
                  </td>
                  <td className="py-3">
                    <StatusBadge status={c.status} />
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
