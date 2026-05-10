import Link from "next/link";
import { createAdminClient } from "@/lib/supabase/admin";
import { Card, StatusBadge } from "@/components/ui/card";

export const metadata = { title: "Applications · Admin" };

export default async function AdminApplicationsPage({
  searchParams,
}: {
  searchParams: { status?: string };
}) {
  const admin = createAdminClient();
  const status = searchParams.status;

  let q = admin
    .from("applications")
    .select(
      "id, full_name, age, status, created_at, submitted_at, why_join, profile:profiles(email)",
    )
    .order("created_at", { ascending: false });
  if (status && status !== "all") q = q.eq("status", status);
  const { data: apps } = await q;

  const filters = ["all", "submitted", "accepted", "rejected", "paid", "draft"];

  return (
    <div className="mx-auto max-w-6xl">
      <h1 className="text-3xl font-bold tracking-tight">Applications</h1>
      <p className="mt-1 text-sm text-white/50">
        Review and decide on applications.
      </p>

      <div className="mt-6 flex flex-wrap gap-2">
        {filters.map((f) => {
          const active = (status ?? "all") === f;
          return (
            <Link
              key={f}
              href={f === "all" ? "/admin/applications" : `/admin/applications?status=${f}`}
              className={`rounded-full border px-3 py-1 text-xs uppercase tracking-wider transition ${
                active
                  ? "border-spark bg-spark/10 text-spark"
                  : "border-white/15 text-white/60 hover:border-white/30 hover:text-white"
              }`}
            >
              {f}
            </Link>
          );
        })}
      </div>

      <Card className="mt-6 !p-0 overflow-hidden">
        {(apps?.length ?? 0) === 0 ? (
          <p className="p-6 text-sm text-white/50">No applications.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-white/10 text-left text-xs uppercase tracking-wider text-white/40">
                <th className="px-5 py-3">Applicant</th>
                <th className="px-5 py-3">Email</th>
                <th className="px-5 py-3">Age</th>
                <th className="px-5 py-3">Status</th>
                <th className="px-5 py-3">Submitted</th>
              </tr>
            </thead>
            <tbody>
              {apps!.map((a: any) => (
                <tr
                  key={a.id}
                  className="border-b border-white/5 last:border-0 hover:bg-white/[0.02]"
                >
                  <td className="px-5 py-3">
                    <Link
                      href={`/admin/applications/${a.id}`}
                      className="text-white hover:text-spark"
                    >
                      {a.full_name || "—"}
                    </Link>
                  </td>
                  <td className="px-5 py-3 text-white/60">
                    {a.profile?.email ?? "—"}
                  </td>
                  <td className="px-5 py-3 text-white/60">{a.age ?? "—"}</td>
                  <td className="px-5 py-3">
                    <StatusBadge status={a.status} />
                  </td>
                  <td className="px-5 py-3 text-white/50">
                    {a.submitted_at
                      ? new Date(a.submitted_at).toLocaleDateString()
                      : "—"}
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
