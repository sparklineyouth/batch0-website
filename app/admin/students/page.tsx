import Link from "next/link";
import { createAdminClient } from "@/lib/supabase/admin";
import { Card, StatusBadge } from "@/components/ui/card";
import { RoleSelect } from "./role-select";
import type { Role } from "@/lib/types";

export const metadata = { title: "People · Admin" };

const FILTERS = ["all", "student", "mentor", "investor", "admin"] as const;
type RoleFilter = (typeof FILTERS)[number];

export default async function AdminStudentsPage({
  searchParams,
}: {
  searchParams: { role?: string };
}) {
  const admin = createAdminClient();
  const filter = (FILTERS.find((f) => f === searchParams.role) ??
    "all") as RoleFilter;

  let q = admin
    .from("profiles")
    .select(
      "id, email, full_name, role, created_at, applications!applications_user_id_fkey(status), enrollments!enrollments_user_id_fkey(cohort_id, cohort:cohorts(name))",
    )
    .order("created_at", { ascending: false });
  if (filter !== "all") q = q.eq("role", filter);

  const { data: profiles } = await q;

  const { data: counts } = await admin
    .from("profiles")
    .select("role", { count: "exact" });
  const roleCount = (role: Role) =>
    (counts ?? []).filter((r: any) => r.role === role).length;

  return (
    <div className="mx-auto max-w-6xl">
      <h1 className="text-3xl font-bold tracking-tight">People</h1>
      <p className="mt-1 text-sm text-white/50">
        Everyone with an account. Change a role inline to grant or revoke
        access.
      </p>

      {/* Role tabs with counts */}
      <div className="mt-6 flex flex-wrap gap-2">
        {FILTERS.map((f) => {
          const active = filter === f;
          const count =
            f === "all"
              ? counts?.length ?? 0
              : roleCount(f as Role);
          return (
            <Link
              key={f}
              href={f === "all" ? "/admin/students" : `/admin/students?role=${f}`}
              className={`rounded-full border px-3 py-1 text-xs uppercase tracking-wider transition ${
                active
                  ? "border-spark bg-spark/10 text-spark"
                  : "border-white/15 text-white/60 hover:border-white/30 hover:text-white"
              }`}
            >
              {f === "all" ? "All" : f + "s"} · {count}
            </Link>
          );
        })}
      </div>

      <Card className="mt-6 !p-0 overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-white/10 text-left text-xs uppercase tracking-wider text-white/40">
              <th className="px-5 py-3">Name</th>
              <th className="px-5 py-3">Email</th>
              <th className="px-5 py-3">Role</th>
              <th className="px-5 py-3">Application</th>
              <th className="px-5 py-3">Cohort</th>
              <th className="px-5 py-3">Joined</th>
              <th className="px-5 py-3"></th>
            </tr>
          </thead>
          <tbody>
            {(profiles ?? []).map((p: any) => {
              const latestApp = (p.applications ?? [])[0];
              const enrollment = (p.enrollments ?? [])[0];
              return (
                <tr
                  key={p.id}
                  className="border-b border-white/5 last:border-0 hover:bg-white/[0.02]"
                >
                  <td className="px-5 py-3 text-white">{p.full_name || "—"}</td>
                  <td className="px-5 py-3 text-white/70">{p.email}</td>
                  <td className="px-5 py-3">
                    <RoleSelect userId={p.id} role={p.role as Role} />
                  </td>
                  <td className="px-5 py-3">
                    {latestApp ? (
                      <StatusBadge status={latestApp.status} />
                    ) : (
                      <span className="text-white/30">—</span>
                    )}
                  </td>
                  <td className="px-5 py-3 text-white/70">
                    {enrollment?.cohort?.name ?? (
                      <span className="text-white/30">—</span>
                    )}
                  </td>
                  <td className="px-5 py-3 text-white/50">
                    {new Date(p.created_at).toLocaleDateString()}
                  </td>
                  <td className="px-5 py-3 text-right">
                    <Link
                      href={`/admin/students/${p.id}`}
                      className="text-xs text-spark hover:underline"
                    >
                      Manage →
                    </Link>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {(profiles?.length ?? 0) === 0 && (
          <p className="p-6 text-sm text-white/50">No matching people.</p>
        )}
      </Card>
    </div>
  );
}
