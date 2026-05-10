import Link from "next/link";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireMentor } from "@/lib/auth";
import { Card } from "@/components/ui/card";

export const metadata = { title: "Mentor · SparkLine" };

export default async function MentorOverview() {
  const profile = await requireMentor();
  const admin = createAdminClient();

  const { data: assignments } = await admin
    .from("mentor_assignments")
    .select(
      "id, notes, student:profiles!mentor_assignments_student_id_fkey(id, email, full_name), cohort:cohorts(name)",
    )
    .eq("mentor_id", profile.id);

  const count = assignments?.length ?? 0;

  return (
    <div className="mx-auto max-w-5xl">
      <h1 className="text-3xl font-bold tracking-tight">Mentor overview</h1>
      <p className="mt-1 text-sm text-white/50">
        Your assigned students and quick links.
      </p>

      <div className="mt-8 grid gap-4 sm:grid-cols-3">
        <Stat label="Students" value={count.toString()} />
        <Stat
          label="Active cohorts"
          value={(
            new Set(
              (assignments ?? [])
                .map((a: any) =>
                  Array.isArray(a.cohort) ? a.cohort[0]?.name : a.cohort?.name,
                )
                .filter(Boolean),
            ).size
          ).toString()}
        />
        <Stat
          label="Notes written"
          value={(
            (assignments ?? []).filter((a: any) => a.notes && a.notes.length > 0)
              .length
          ).toString()}
        />
      </div>

      <Card className="mt-10">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold">My students</h2>
          <Link
            href="/mentor/students"
            className="text-sm text-spark hover:underline"
          >
            View all →
          </Link>
        </div>
        {count === 0 ? (
          <p className="text-sm text-white/50">
            No students assigned yet. An admin will assign students to you.
          </p>
        ) : (
          <ul className="divide-y divide-white/5">
            {(assignments ?? []).slice(0, 8).map((a: any) => {
              const student = Array.isArray(a.student)
                ? a.student[0]
                : a.student;
              const cohort = Array.isArray(a.cohort) ? a.cohort[0] : a.cohort;
              return (
                <li
                  key={a.id}
                  className="flex items-center justify-between py-3"
                >
                  <div>
                    <div className="text-sm font-medium text-white">
                      {student?.full_name || "—"}
                    </div>
                    <div className="text-xs text-white/40">
                      {student?.email}
                    </div>
                  </div>
                  <div className="text-xs text-white/60">
                    {cohort?.name ?? ""}
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

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <Card>
      <div className="text-xs uppercase tracking-wider text-white/40">
        {label}
      </div>
      <div className="mt-2 text-3xl font-bold tracking-tight text-white">
        {value}
      </div>
    </Card>
  );
}
