import Link from "next/link";
import { createAdminClient } from "@/lib/supabase/admin";
import { Card } from "@/components/ui/card";

export const metadata = { title: "Admin · SparkLine" };

function fmtMoney(cents: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(cents / 100);
}

export default async function AdminOverview() {
  const admin = createAdminClient();

  const [
    { count: totalApps },
    { count: pendingApps },
    { count: acceptedApps },
    { count: enrolledCount },
    { data: paymentsData },
    { data: recentApps },
  ] = await Promise.all([
    admin.from("applications").select("id", { count: "exact", head: true }),
    admin
      .from("applications")
      .select("id", { count: "exact", head: true })
      .eq("status", "submitted"),
    admin
      .from("applications")
      .select("id", { count: "exact", head: true })
      .eq("status", "accepted"),
    admin.from("enrollments").select("id", { count: "exact", head: true }),
    admin.from("payments").select("amount_cents,status").eq("status", "succeeded"),
    admin
      .from("applications")
      .select("id, full_name, status, submitted_at, created_at")
      .order("created_at", { ascending: false })
      .limit(8),
  ]);

  const revenueCents = (paymentsData ?? []).reduce(
    (sum, p) => sum + (p.amount_cents ?? 0),
    0,
  );

  return (
    <div className="mx-auto max-w-6xl">
      <h1 className="text-3xl font-bold tracking-tight">Overview</h1>
      <p className="mt-1 text-sm text-white/50">
        Snapshot of applications, students, and revenue.
      </p>

      <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Total applications" value={totalApps ?? 0} />
        <Stat
          label="Pending review"
          value={pendingApps ?? 0}
          accent={(pendingApps ?? 0) > 0}
        />
        <Stat label="Accepted (awaiting pay)" value={acceptedApps ?? 0} />
        <Stat label="Enrolled" value={enrolledCount ?? 0} />
        <Stat label="Revenue" value={fmtMoney(revenueCents)} wide />
      </div>

      <Card className="mt-10">
        <div className="mb-5 flex items-center justify-between">
          <h2 className="text-lg font-semibold">Recent applications</h2>
          <Link
            href="/admin/applications"
            className="text-sm text-spark hover:underline"
          >
            View all →
          </Link>
        </div>
        {(recentApps?.length ?? 0) === 0 ? (
          <p className="text-sm text-white/50">No applications yet.</p>
        ) : (
          <ul className="divide-y divide-white/5">
            {recentApps!.map((a) => (
              <li key={a.id}>
                <Link
                  href={`/admin/applications/${a.id}`}
                  className="flex items-center justify-between px-1 py-3 hover:bg-white/[0.02]"
                >
                  <div>
                    <div className="text-sm text-white/90">
                      {a.full_name || "—"}
                    </div>
                    <div className="text-xs text-white/40">
                      {new Date(a.submitted_at || a.created_at).toLocaleString()}
                    </div>
                  </div>
                  <div className="text-xs uppercase tracking-wider text-white/60">
                    {a.status}
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

function Stat({
  label,
  value,
  accent,
  wide,
}: {
  label: string;
  value: string | number;
  accent?: boolean;
  wide?: boolean;
}) {
  return (
    <Card className={`${wide ? "sm:col-span-2 lg:col-span-1" : ""}`}>
      <div className="text-xs font-medium uppercase tracking-wider text-white/40">
        {label}
      </div>
      <div
        className={`mt-2 text-3xl font-bold tracking-tight ${
          accent ? "text-spark" : "text-white"
        }`}
      >
        {value}
      </div>
    </Card>
  );
}
