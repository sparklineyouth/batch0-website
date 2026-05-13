import Link from "next/link";
import { createAdminClient } from "@/lib/supabase/admin";
import { Card, StatusBadge } from "@/components/ui/card";
import { LocalTime } from "@/components/ui/local-time";
import { ChargeManager } from "./charge-manager";

export const metadata = { title: "Fees & fines · Admin" };

const STATUSES = [
  "all",
  "pending",
  "paid",
  "waived",
  "cancelled",
  "refunded",
] as const;

function fmt(cents: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(cents / 100);
}

export default async function AdminChargesPage({
  searchParams,
}: {
  searchParams: { status?: string; user?: string };
}) {
  const admin = createAdminClient();
  const status = searchParams.status ?? "pending";
  const userId = searchParams.user ?? null;

  let q = admin
    .from("user_charges")
    .select("*, profile:profiles!user_charges_user_id_fkey(email, full_name)")
    .order("created_at", { ascending: false });
  if (status !== "all") q = q.eq("status", status);
  if (userId) q = q.eq("user_id", userId);
  const { data: charges } = await q;

  const { data: profiles } = await admin
    .from("profiles")
    .select("id, email, full_name")
    .order("created_at", { ascending: false });

  return (
    <div className="mx-auto max-w-6xl">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Fees &amp; fines</h1>
          <p className="mt-1 text-sm text-white/55">
            Issue an admin-driven fee (soft prompt) or fine (hard block until
            paid). Both can be paid via Stripe or waived.
          </p>
        </div>
        <a
          href="/api/admin/export/charges"
          className="inline-flex items-center gap-1.5 rounded-lg border border-white/15 bg-white/5 px-3 py-1.5 text-xs font-medium text-white/80 hover:bg-white/10"
        >
          Export CSV
        </a>
      </div>

      <Card className="mt-6">
        <h2 className="mb-4 text-sm font-semibold uppercase tracking-wider text-white/55">
          Issue a charge
        </h2>
        <ChargeManager profiles={(profiles ?? []) as any} />
      </Card>

      <div className="mt-8 flex flex-wrap items-center gap-2">
        <span className="text-xs uppercase tracking-wider text-white/40">
          Status
        </span>
        {STATUSES.map((s) => {
          const active = status === s;
          const params = new URLSearchParams();
          if (s !== "all") params.set("status", s);
          if (userId) params.set("user", userId);
          const href = `/admin/charges${params.toString() ? `?${params}` : ""}`;
          return (
            <Link
              key={s}
              href={href}
              className={`rounded-full border px-3 py-1 text-xs uppercase tracking-wider transition ${
                active
                  ? "border-spark bg-spark/10 text-spark"
                  : "border-white/15 text-white/60 hover:border-white/30 hover:text-white"
              }`}
            >
              {s}
            </Link>
          );
        })}
      </div>

      <Card className="mt-4 !p-0 overflow-hidden">
        {(charges?.length ?? 0) === 0 ? (
          <p className="p-6 text-sm text-white/55">No charges match.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-white/10 text-left text-xs uppercase tracking-wider text-white/40">
                <th className="px-5 py-3">Issued</th>
                <th className="px-5 py-3">Student</th>
                <th className="px-5 py-3">Type</th>
                <th className="px-5 py-3">Amount</th>
                <th className="px-5 py-3">Description</th>
                <th className="px-5 py-3">Status</th>
                <th className="px-5 py-3"></th>
              </tr>
            </thead>
            <tbody>
              {(charges ?? []).map((c: any) => {
                const p = Array.isArray(c.profile) ? c.profile[0] : c.profile;
                return (
                  <tr
                    key={c.id}
                    className="border-b border-white/5 last:border-0 hover:bg-white/[0.02]"
                  >
                    <td className="px-5 py-3 text-white/60">
                      <LocalTime value={c.created_at} />
                    </td>
                    <td className="px-5 py-3">
                      <div className="text-white">
                        {p?.full_name ?? "—"}
                      </div>
                      <div className="text-xs text-white/40">{p?.email}</div>
                    </td>
                    <td className="px-5 py-3">
                      <span
                        className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${
                          c.kind === "fine"
                            ? "bg-red-400/10 text-red-300"
                            : "bg-amber-300/10 text-amber-200"
                        }`}
                      >
                        {c.kind}
                      </span>
                    </td>
                    <td className="px-5 py-3 text-white/80">
                      {fmt(c.amount_cents)}
                    </td>
                    <td className="px-5 py-3 text-white/60 max-w-xs truncate">
                      {c.description}
                    </td>
                    <td className="px-5 py-3">
                      <StatusBadge status={c.status} />
                    </td>
                    <td className="px-5 py-3 text-right">
                      {(c.status === "pending" || c.status === "paid") && (
                        <ChargeRowActions chargeId={c.id} status={c.status} />
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}

import { ChargeRowActions } from "./row-actions";
