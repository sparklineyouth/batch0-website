import Link from "next/link";
import { createAdminClient } from "@/lib/supabase/admin";
import { Card, StatusBadge } from "@/components/ui/card";

export const metadata = { title: "Students · Mentor" };

export default async function MentorStudentsPage({
  searchParams,
}: {
  searchParams: { cohort?: string };
}) {
  const admin = createAdminClient();
  const cohortFilter = searchParams.cohort ?? "all";

  const [{ data: cohorts }, { data: enrollments }] = await Promise.all([
    admin.from("cohorts").select("id, name").order("starts_on"),
    admin
      .from("enrollments")
      .select(
        "id, enrolled_at, cohort_id, cohort:cohorts(name), profile:profiles(id, email, full_name)",
      )
      .order("enrolled_at", { ascending: false }),
  ]);

  const filtered = (enrollments ?? []).filter((e: any) =>
    cohortFilter === "all" ? true : e.cohort_id === cohortFilter,
  );

  // Pull lesson_progress to compute completed count per student.
  const userIds = filtered.map((e: any) => e.profile?.id).filter(Boolean);
  const { data: progress } = userIds.length
    ? await admin
        .from("lesson_progress")
        .select("user_id, completed_at")
        .in("user_id", userIds)
    : { data: [] };
  const completedByUser = new Map<string, number>();
  for (const p of (progress ?? []) as any[]) {
    if (!p.completed_at) continue;
    completedByUser.set(p.user_id, (completedByUser.get(p.user_id) ?? 0) + 1);
  }

  return (
    <div className="mx-auto max-w-6xl">
      <h1 className="text-3xl font-bold tracking-tight">Students</h1>
      <p className="mt-1 text-sm text-white/50">
        Students enrolled in your cohorts.
      </p>

      <div className="mt-6 flex flex-wrap items-center gap-2">
        <span className="text-xs uppercase tracking-wider text-white/40">
          Cohort
        </span>
        <Filter href="/mentor/students" label="All" active={cohortFilter === "all"} />
        {(cohorts ?? []).map((c: any) => (
          <Filter
            key={c.id}
            href={`/mentor/students?cohort=${c.id}`}
            label={c.name}
            active={cohortFilter === c.id}
          />
        ))}
      </div>

      <Card className="mt-6 !p-0 overflow-hidden">
        {filtered.length === 0 ? (
          <p className="p-6 text-sm text-white/50">No enrolled students.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-white/10 text-left text-xs uppercase tracking-wider text-white/40">
                <th className="px-5 py-3">Name</th>
                <th className="px-5 py-3">Email</th>
                <th className="px-5 py-3">Cohort</th>
                <th className="px-5 py-3">Enrolled</th>
                <th className="px-5 py-3">Lessons completed</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((e: any) => (
                <tr
                  key={e.id}
                  className="border-b border-white/5 last:border-0 hover:bg-white/[0.02]"
                >
                  <td className="px-5 py-3 text-white">
                    {e.profile?.full_name || "—"}
                  </td>
                  <td className="px-5 py-3 text-white/70">
                    {e.profile?.email}
                  </td>
                  <td className="px-5 py-3 text-white/70">
                    {e.cohort?.name ?? "—"}
                  </td>
                  <td className="px-5 py-3 text-white/50">
                    {new Date(e.enrolled_at).toLocaleDateString()}
                  </td>
                  <td className="px-5 py-3 text-white/80">
                    {completedByUser.get(e.profile?.id) ?? 0}
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

function Filter({
  href,
  label,
  active,
}: {
  href: string;
  label: string;
  active: boolean;
}) {
  return (
    <Link
      href={href}
      className={`rounded-full border px-3 py-1 text-xs uppercase tracking-wider transition ${
        active
          ? "border-spark bg-spark/10 text-spark"
          : "border-white/15 text-white/60 hover:border-white/30 hover:text-white"
      }`}
    >
      {label}
    </Link>
  );
}
