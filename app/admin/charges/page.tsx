import Link from "next/link";
import { createAdminClient } from "@/lib/supabase/admin";
import { Card } from "@/components/ui/card";
import { ChargeManager } from "./charge-manager";
import { ChargesBulkList } from "./bulk-list";

export const metadata = { title: "Fees & fines · Admin" };
export const dynamic = "force-dynamic";
export const revalidate = 0;

const STATUSES = [
  "all",
  "pending",
  "paid",
  "waived",
  "cancelled",
  "refunded",
] as const;

export default async function AdminChargesPage({
  searchParams,
}: {
  searchParams: { status?: string; user?: string };
}) {
  const admin = createAdminClient();
  // Empty string from `?status=` collapses to the "pending" landing
  // view; the "all" pill explicitly opts out of that with `?status=all`.
  const status = (searchParams.status ?? "pending") || "pending";
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
          <h1 className="font-display text-3xl font-bold tracking-[-0.02em] text-ink">Fees &amp; fines</h1>
          <p className="mt-1 text-sm text-ink-soft">
            Issue an admin-driven fee (soft prompt) or fine (hard block until
            paid). Both can be paid via Stripe or waived.
          </p>
        </div>
        <a
          href="/api/admin/export/charges"
          className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-wash px-3 py-1.5 text-xs font-medium text-ink-soft hover:border-ink/30 hover:bg-wash"
        >
          Export CSV
        </a>
      </div>

      <Card className="mt-6">
        <h2 className="mb-4 text-sm font-semibold uppercase tracking-wider text-ink-soft">
          Issue a charge
        </h2>
        <ChargeManager profiles={(profiles ?? []) as any} />
      </Card>

      <div className="mt-8 flex flex-wrap items-center gap-2">
        <span className="text-xs uppercase tracking-wider text-ink-faint">
          Status
        </span>
        {STATUSES.map((s) => {
          const active = status === s;
          const params = new URLSearchParams();
          // Always include the status param so clicking "all" overrides
          // the default "pending" landing — otherwise the pill would be
          // a no-op for anyone arriving with the default view.
          params.set("status", s);
          if (userId) params.set("user", userId);
          const href = `/admin/charges?${params.toString()}`;
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
      </div>

      <Card className="mt-4 !p-0 overflow-hidden">
        <ChargesBulkList
          charges={(charges ?? []).map((c: any) => {
            const p = Array.isArray(c.profile) ? c.profile[0] : c.profile;
            return {
              id: c.id,
              created_at: c.created_at,
              kind: c.kind,
              amount_cents: c.amount_cents,
              description: c.description,
              status: c.status,
              profile: p
                ? { email: p.email ?? null, full_name: p.full_name ?? null }
                : null,
            };
          })}
        />
      </Card>
    </div>
  );
}
