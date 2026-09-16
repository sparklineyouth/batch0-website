import Link from "next/link";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireMentor, getCapabilities } from "@/lib/auth";
import { canAccessAdmin } from "@/lib/permissions";
import { Card, StatusBadge } from "@/components/ui/card";
import { LocalTime } from "@/components/ui/local-time";

export const metadata = { title: "Students · Mentor" };

export default async function MentorStudentsPage(
  props: {
    searchParams: Promise<{ cohort?: string }>;
  }
) {
  const searchParams = await props.searchParams;
  const mentor = await requireMentor();
  // Request-cached alongside the guard above, so this is not a second read.
  const caps = await getCapabilities();
  const admin = createAdminClient();
  const cohortFilter = searchParams.cohort ?? "all";

  // "Students enrolled in your cohorts" below has to be true: unscoped, this
  // table listed every enrolled student in the program and handed out a link
  // to each one's detail page. The scope mirrors lib/mentor-scope.ts, which is
  // what that page enforces — the cohorts the viewer holds a mentor_assignments
  // row in, plus any student assigned to them directly (an assignment may
  // carry no cohort). Admin-area viewers keep the program-wide list.
  const scope = canAccessAdmin(caps)
    ? null
    : await mentorScope(admin, mentor.id);

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
  // Both halves of the scope sit on `enrollments`, so they apply as one OR on
  // top of whatever the cohort pill asked for. Either half can be empty and
  // PostgREST rejects an empty `in.()`, so only the halves with ids go in.
  const scopeFilter = scope
    ? [
        scope.cohortIds.length
          ? `cohort_id.in.(${scope.cohortIds.join(",")})`
          : null,
        scope.studentIds.length
          ? `user_id.in.(${scope.studentIds.join(",")})`
          : null,
      ]
        .filter(Boolean)
        .join(",")
    : null;
  if (scopeFilter) enrollmentsQuery = enrollmentsQuery.or(scopeFilter);

  const [{ data: cohorts }, enrolled] = await Promise.all([
    admin.from("cohorts").select("id, name").order("starts_on"),
    // A mentor with no assignments at all is in scope for nobody, so skip the
    // read rather than run it wide.
    scope && !scopeFilter ? null : enrollmentsQuery,
  ]);

  const rows = (enrolled?.data ?? []) as any[];
  // The pills must not advertise cohorts the table won't list anyone from.
  const visibleCohorts = (cohorts ?? []).filter(
    (c: any) => !scope || scope.cohortIds.includes(c.id),
  );

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
        {visibleCohorts.map((c: any) => (
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

/**
 * Which cohorts and which individual students one mentor may list. Read once
 * per render and applied to both the table and the cohort pills.
 */
async function mentorScope(
  admin: ReturnType<typeof createAdminClient>,
  mentorId: string,
): Promise<{ cohortIds: string[]; studentIds: string[] }> {
  const { data: assignments } = await admin
    .from("mentor_assignments")
    .select("student_id, cohort_id")
    .eq("mentor_id", mentorId);
  const rows = (assignments ?? []) as any[];
  return {
    cohortIds: [
      ...new Set(
        rows.map((a) => a.cohort_id as string | null).filter((id): id is string => !!id),
      ),
    ],
    studentIds: [...new Set(rows.map((a) => a.student_id as string))],
  };
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
