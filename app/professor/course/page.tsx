import Link from "next/link";
import { createAdminClient } from "@/lib/supabase/admin";
import { Card } from "@/components/ui/card";

export const metadata = { title: "Course · Professor" };

export default async function ProfessorCoursePage({
  searchParams,
}: {
  searchParams: { cohort?: string };
}) {
  const admin = createAdminClient();
  const cohortFilter = searchParams.cohort;

  const { data: cohorts } = await admin
    .from("cohorts")
    .select("id, name")
    .order("starts_on", { ascending: true });

  const selectedCohortId =
    cohortFilter ?? cohorts?.[0]?.id ?? null;

  let modules: any[] = [];
  if (selectedCohortId) {
    const { data } = await admin
      .from("modules")
      .select("*, lessons:lessons(*)")
      .eq("cohort_id", selectedCohortId)
      .order("position", { ascending: true });
    modules = data ?? [];
  }

  return (
    <div className="mx-auto max-w-4xl">
      <h1 className="text-3xl font-bold tracking-tight">Course</h1>
      <p className="mt-1 text-sm text-white/50">
        Read-only view of cohort curriculum. Editing lives in the admin
        panel.
      </p>

      <div className="mt-6 flex flex-wrap items-center gap-2">
        <span className="text-xs uppercase tracking-wider text-white/40">
          Cohort
        </span>
        {(cohorts ?? []).map((c: any) => {
          const active = selectedCohortId === c.id;
          return (
            <Link
              key={c.id}
              href={`/professor/course?cohort=${c.id}`}
              className={`rounded-full border px-3 py-1 text-xs uppercase tracking-wider transition ${
                active
                  ? "border-spark bg-spark/10 text-spark"
                  : "border-white/15 text-white/60 hover:border-white/30 hover:text-white"
              }`}
            >
              {c.name}
            </Link>
          );
        })}
      </div>

      <div className="mt-8 space-y-6">
        {modules.length === 0 && (
          <Card>
            <p className="text-sm text-white/50">
              No modules in this cohort yet.
            </p>
          </Card>
        )}
        {modules.map((m) => {
          const sortedLessons = [...(m.lessons ?? [])].sort(
            (a, b) => a.position - b.position,
          );
          return (
            <Card key={m.id} className="!p-0 overflow-hidden">
              <div className="border-b border-white/10 bg-black/30 px-6 py-4">
                <p className="text-xs font-medium uppercase tracking-wider text-spark">
                  Week {m.week}
                </p>
                <h3 className="mt-1 text-lg font-semibold">{m.title}</h3>
                {m.summary && (
                  <p className="mt-1 text-sm text-white/50">{m.summary}</p>
                )}
              </div>
              <ul className="divide-y divide-white/5">
                {sortedLessons.length === 0 ? (
                  <li className="px-6 py-4 text-sm text-white/40">
                    No lessons yet.
                  </li>
                ) : (
                  sortedLessons.map((l: any) => (
                    <li
                      key={l.id}
                      className="flex items-center justify-between gap-3 px-6 py-3"
                    >
                      <div>
                        <div className="text-sm text-white">{l.title}</div>
                        {l.description && (
                          <div className="text-xs text-white/50">
                            {l.description}
                          </div>
                        )}
                      </div>
                      {l.duration_seconds ? (
                        <span className="text-xs text-white/40">
                          {Math.round(l.duration_seconds / 60)} min
                        </span>
                      ) : null}
                    </li>
                  ))
                )}
              </ul>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
