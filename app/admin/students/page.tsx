import Link from "next/link";
import { createAdminClient } from "@/lib/supabase/admin";
import { Card } from "@/components/ui/card";
import { StudentsBulkList } from "./bulk-list";
import type { Role } from "@/lib/types";

export const metadata = { title: "People · Admin" };
// Without this the router cache can serve a stale RSC payload when an
// admin navigates back to /admin/students after enrolling/disabling
// users — they'd see a partial list until a hard reload refreshed it.
export const dynamic = "force-dynamic";
export const revalidate = 0;

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
    .order("created_at", { ascending: false })
    // PostgREST defaults to ~1000 rows; bump explicitly so a growing
    // people directory doesn't silently truncate.
    .limit(5000);
  if (filter !== "all") q = q.eq("role", filter);

  const { data: profiles } = await q;

  const { data: counts } = await admin
    .from("profiles")
    .select("role")
    .limit(5000);
  const roleCount = (role: Role) =>
    (counts ?? []).filter((r: any) => r.role === role).length;

  return (
    <div className="mx-auto max-w-6xl">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-3xl font-bold tracking-[-0.02em] text-ink">People</h1>
          <p className="mt-1 text-sm text-ink-faint">
            Everyone with an account. Change a role inline to grant or revoke
            access.
          </p>
        </div>
        <a
          href="/api/admin/export/people"
          className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-wash px-3 py-1.5 text-xs font-medium text-ink hover:border-ink/30 hover:bg-wash"
        >
          Export CSV
        </a>
      </div>

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
                  ? "border-spark/30 bg-spark/10 text-spark-ink"
                  : "border-line text-ink-soft hover:border-ink/30 hover:text-ink"
              }`}
            >
              {f === "all" ? "All" : f + "s"} · {count}
            </Link>
          );
        })}
      </div>

      <Card className="mt-6 !p-0 overflow-hidden">
        <StudentsBulkList
          rows={(profiles ?? []).map((p: any) => {
            const latestApp = (p.applications ?? [])[0];
            const enrollment = (p.enrollments ?? [])[0];
            const cohort = Array.isArray(enrollment?.cohort)
              ? enrollment?.cohort[0]
              : enrollment?.cohort;
            return {
              id: p.id,
              email: p.email,
              full_name: p.full_name,
              role: p.role as Role,
              created_at: p.created_at,
              latest_app_status: latestApp?.status ?? null,
              cohort_name: cohort?.name ?? null,
            };
          })}
        />
      </Card>
    </div>
  );
}
