import Link from "next/link";
import { createAdminClient } from "@/lib/supabase/admin";
import { Card, StatusBadge } from "@/components/ui/card";
import { LocalTime } from "@/components/ui/local-time";

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
      <h1 className="font-display text-3xl font-bold tracking-[-0.02em] text-ink">Students</h1>
      <p className="mt-1 text-sm text-ink-faint">
        Students enrolled in your cohorts.
      </p>

      <div className="mt-6 flex flex-wrap items-center gap-2">
        <span className="font-mono text-xs uppercase tracking-wider text-ink-faint">
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
          <p className="p-6 text-sm text-ink-faint">No enrolled students.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line text-left font-mono text-xs uppercase tracking-wider text-ink-faint">
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
                  className="border-b border-line last:border-0 hover:bg-wash"
                >
                  <td className="px-5 py-3 text-ink">
                    <Link
                      href={`/mentor/students/${e.profile?.id}`}
                      className="hover:text-phosphor-ink"
                    >
                      {e.profile?.full_name || "—"}
                    </Link>
                  </td>
                  <td className="px-5 py-3 text-ink-soft">
                    {e.profile?.email}
                  </td>
                  <td className="px-5 py-3 text-ink-soft">
                    {e.cohort?.name ?? "—"}
                  </td>
                  <td className="px-5 py-3 text-ink-faint tabular-nums">
                    <LocalTime value={e.enrolled_at} mode="date" />
                  </td>
                  <td className="px-5 py-3 text-ink-soft tabular-nums">
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
      className={`rounded-full border px-3 py-1 font-mono text-xs uppercase tracking-wider transition ${
        active
          ? "border-phosphor bg-phosphor/10 text-phosphor-ink"
          : "border-line text-ink-soft hover:border-ink/30 hover:text-ink"
      }`}
    >
      {label}
    </Link>
  );
}
