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

  // The completed-lesson column only needs a number per student, so it rides
  // the enrollments query as a filtered count embed instead of a second
  // round trip shipping every lesson_progress row for every listed user.
  // The .not() filter scopes the embedded rows (not the enrollments), so the
  // count is completions only.
  let enrollmentsQuery = admin
    .from("enrollments")
    .select(
      "id, enrolled_at, cohort_id, cohort:cohorts(name), profile:profiles(id, email, full_name, lesson_progress(count))",
    )
    .not("profile.lesson_progress.completed_at", "is", null)
    .order("enrolled_at", { ascending: false });
  if (cohortFilter !== "all") {
    enrollmentsQuery = enrollmentsQuery.eq("cohort_id", cohortFilter);
  }

  const [{ data: cohorts }, { data: enrollments }] = await Promise.all([
    admin.from("cohorts").select("id, name").order("starts_on"),
    enrollmentsQuery,
  ]);

  const rows = (enrollments ?? []) as any[];

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
        {rows.length === 0 ? (
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
              {rows.map((e: any) => (
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
                    {e.profile?.lesson_progress?.[0]?.count ?? 0}
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
