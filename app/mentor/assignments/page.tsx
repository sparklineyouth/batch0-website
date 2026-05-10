import Link from "next/link";
import { createAdminClient } from "@/lib/supabase/admin";
import { Card } from "@/components/ui/card";
import { Plus } from "lucide-react";

export const metadata = { title: "Assignments · Mentor" };

function fmtDate(s: string | null) {
  return s ? new Date(s).toLocaleString() : "—";
}

export default async function MentorAssignmentsPage({
  searchParams,
}: {
  searchParams: { cohort?: string };
}) {
  const admin = createAdminClient();
  const cohortFilter = searchParams.cohort ?? "all";

  const [{ data: cohorts }, { data: assignments }, { data: subs }] =
    await Promise.all([
      admin.from("cohorts").select("id, name").order("starts_on"),
      admin
        .from("assignments")
        .select("*, cohort:cohorts(id, name), lesson:lessons(title)")
        .order("created_at", { ascending: false }),
      admin
        .from("assignment_submissions")
        .select("assignment_id, status"),
    ]);

  const filtered =
    cohortFilter === "all"
      ? assignments ?? []
      : (assignments ?? []).filter(
          (a: any) => a.cohort_id === cohortFilter,
        );

  const subCounts = new Map<string, { submitted: number; graded: number }>();
  for (const s of (subs ?? []) as any[]) {
    const cur = subCounts.get(s.assignment_id) ?? { submitted: 0, graded: 0 };
    if (s.status === "submitted" || s.status === "graded") cur.submitted++;
    if (s.status === "graded") cur.graded++;
    subCounts.set(s.assignment_id, cur);
  }

  return (
    <div className="mx-auto max-w-5xl">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Assignments</h1>
          <p className="mt-1 text-sm text-white/50">
            Homework you've published. Students see them under their dashboard
            once enrolled in the matching cohort.
          </p>
        </div>
        <Link
          href="/mentor/assignments/new"
          className="inline-flex h-10 items-center gap-2 rounded-lg bg-spark px-4 text-sm font-semibold text-black hover:bg-spark-200"
        >
          <Plus className="h-4 w-4" /> New assignment
        </Link>
      </div>

      <div className="mt-6 flex flex-wrap items-center gap-2">
        <span className="text-xs uppercase tracking-wider text-white/40">
          Cohort
        </span>
        <Filter
          href="/mentor/assignments"
          label="All"
          active={cohortFilter === "all"}
        />
        {(cohorts ?? []).map((c: any) => (
          <Filter
            key={c.id}
            href={`/mentor/assignments?cohort=${c.id}`}
            label={c.name}
            active={cohortFilter === c.id}
          />
        ))}
      </div>

      <Card className="mt-6 !p-0 overflow-hidden">
        {filtered.length === 0 ? (
          <p className="p-6 text-sm text-white/50">No assignments yet.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-white/10 text-left text-xs uppercase tracking-wider text-white/40">
                <th className="px-5 py-3">Title</th>
                <th className="px-5 py-3">Cohort</th>
                <th className="px-5 py-3">Lesson</th>
                <th className="px-5 py-3">Due</th>
                <th className="px-5 py-3">Submissions</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((a: any) => {
                const counts = subCounts.get(a.id) ?? {
                  submitted: 0,
                  graded: 0,
                };
                return (
                  <tr
                    key={a.id}
                    className="border-b border-white/5 last:border-0 hover:bg-white/[0.02]"
                  >
                    <td className="px-5 py-3">
                      <Link
                        href={`/mentor/assignments/${a.id}`}
                        className="text-white hover:text-spark"
                      >
                        {a.title}
                      </Link>
                    </td>
                    <td className="px-5 py-3 text-white/70">
                      {a.cohort?.name ?? "—"}
                    </td>
                    <td className="px-5 py-3 text-white/70">
                      {a.lesson?.title ?? (
                        <span className="text-white/30">Standalone</span>
                      )}
                    </td>
                    <td className="px-5 py-3 text-white/60">
                      {fmtDate(a.due_at)}
                    </td>
                    <td className="px-5 py-3 text-white/80">
                      {counts.graded} graded · {counts.submitted - counts.graded}{" "}
                      pending
                    </td>
                  </tr>
                );
              })}
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
