import Link from "next/link";
import { createAdminClient } from "@/lib/supabase/admin";
import { Card } from "@/components/ui/card";

export const metadata = { title: "Mentor · batch0" };

export default async function MentorOverview() {
  const admin = createAdminClient();

  const [
    { count: totalStudents },
    { count: enrolledCount },
    { data: cohorts },
    { data: progress },
  ] = await Promise.all([
    admin
      .from("profiles")
      .select("id", { count: "exact", head: true })
      .eq("role", "student"),
    admin.from("enrollments").select("id", { count: "exact", head: true }),
    admin
      .from("cohorts")
      .select("id, name, status, starts_on, ends_on, capacity, enrollments(count)")
      .order("starts_on", { ascending: true }),
    admin.from("lesson_progress").select("user_id, completed_at"),
  ]);

  const completions = (progress ?? []).filter((p: any) => p.completed_at).length;
  const activeStudents = new Set(
    (progress ?? [])
      .filter((p: any) => p.completed_at)
      .map((p: any) => p.user_id),
  ).size;

  return (
    <div className="mx-auto max-w-6xl">
      <h1 className="font-display text-3xl font-bold tracking-[-0.02em] text-ink">Mentor overview</h1>
      <p className="mt-1 text-sm text-ink-faint">
        Snapshot of cohorts, students, and learning activity.
      </p>

      <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Total students" value={(totalStudents ?? 0).toString()} />
        <Stat label="Enrolled" value={(enrolledCount ?? 0).toString()} />
        <Stat
          label="Active learners"
          value={activeStudents.toString()}
          sub="Completed at least one lesson"
        />
        <Stat
          label="Lesson completions"
          value={completions.toString()}
        />
      </div>

      <Card className="mt-10">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="font-display text-lg font-semibold tracking-[-0.02em] text-ink">Cohorts</h2>
          <Link
            href="/mentor/students"
            className="text-sm text-phosphor-ink hover:underline"
          >
            View students →
          </Link>
        </div>
        {(cohorts?.length ?? 0) === 0 ? (
          <p className="text-sm text-ink-faint">No cohorts yet.</p>
        ) : (
          <ul className="divide-y divide-line">
            {(cohorts ?? []).map((c: any) => {
              const enrolled = c.enrollments?.[0]?.count ?? 0;
              return (
                <li
                  key={c.id}
                  className="flex flex-wrap items-center justify-between gap-3 py-3"
                >
                  <div>
                    <div className="text-sm font-medium text-ink">
                      {c.name}
                    </div>
                    <div className="text-xs text-ink-faint">
                      {c.starts_on ?? "—"} → {c.ends_on ?? "—"} · {c.status}
                    </div>
                  </div>
                  <div className="text-sm text-ink-soft">
                    {enrolled} / {c.capacity} enrolled
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </div>
  );
}

function Stat({
  label,
  value,
  sub,
}: {
  label: string;
  value: string;
  sub?: string;
}) {
  return (
    <Card>
      <div className="font-mono text-xs font-medium uppercase tracking-wider text-ink-faint">
        {label}
      </div>
      <div className="mt-2 font-display text-3xl font-bold tracking-[-0.02em] tabular-nums text-ink">
        {value}
      </div>
      {sub && <div className="mt-1 text-xs text-ink-faint">{sub}</div>}
    </Card>
  );
}
