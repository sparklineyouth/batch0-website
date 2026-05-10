import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { requireUser } from "@/lib/auth";
import { Card, StatusBadge } from "@/components/ui/card";
import { ClipboardList, Lock } from "lucide-react";

export const metadata = { title: "Assignments · SparkLine" };

function fmtDue(s: string | null) {
  if (!s) return null;
  const d = new Date(s);
  return d.toLocaleString();
}

function dueState(due: string | null): "upcoming" | "soon" | "overdue" | "none" {
  if (!due) return "none";
  const ms = new Date(due).getTime() - Date.now();
  if (ms < 0) return "overdue";
  if (ms < 1000 * 60 * 60 * 48) return "soon";
  return "upcoming";
}

export default async function StudentAssignmentsPage() {
  const user = await requireUser();
  const supabase = createClient();

  const { data: enrollmentRaw } = await supabase
    .from("enrollments")
    .select("cohort_id, cohort:cohorts(name)")
    .eq("user_id", user.id)
    .maybeSingle();
  const enrollment = enrollmentRaw as
    | { cohort_id: string; cohort: { name: string } | null }
    | null;

  if (!enrollment) {
    return (
      <div className="mx-auto max-w-3xl">
        <h1 className="text-3xl font-bold tracking-tight">Assignments</h1>
        <Card className="mt-6">
          <div className="flex items-start gap-3">
            <Lock className="h-5 w-5 text-white/40" />
            <p className="text-sm text-white/70">
              Assignments unlock once you're enrolled in a cohort. Apply and
              pay to get in.
            </p>
          </div>
          <Link
            href="/dashboard/application"
            className="mt-4 inline-block text-sm text-spark hover:underline"
          >
            View application →
          </Link>
        </Card>
      </div>
    );
  }

  const [{ data: assignments }, { data: subs }] = await Promise.all([
    supabase
      .from("assignments")
      .select("*, lesson:lessons(title)")
      .eq("cohort_id", enrollment.cohort_id)
      .order("due_at", { ascending: true, nullsFirst: false }),
    supabase
      .from("assignment_submissions")
      .select("assignment_id, status, grade")
      .eq("user_id", user.id),
  ]);

  const subByAssignment = new Map<string, any>();
  for (const s of (subs ?? []) as any[]) subByAssignment.set(s.assignment_id, s);

  return (
    <div className="mx-auto max-w-4xl">
      <h1 className="text-3xl font-bold tracking-tight">Assignments</h1>
      <p className="mt-1 text-sm text-white/50">
        Homework for {enrollment.cohort?.name}.
      </p>

      <div className="mt-8 space-y-3">
        {(assignments?.length ?? 0) === 0 && (
          <Card>
            <p className="text-sm text-white/60">
              No assignments published yet.
            </p>
          </Card>
        )}
        {(assignments ?? []).map((a: any) => {
          const sub = subByAssignment.get(a.id);
          const status = sub?.status ?? "not_started";
          const due = dueState(a.due_at);
          return (
            <Link
              key={a.id}
              href={`/dashboard/assignments/${a.id}`}
              className="block"
            >
              <Card className="!p-0 hover:border-spark/40 transition-colors">
                <div className="flex items-start gap-4 p-5">
                  <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-spark/10 text-spark">
                    <ClipboardList className="h-4 w-4" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <h3 className="text-base font-semibold text-white">
                        {a.title}
                      </h3>
                      {sub?.grade && (
                        <span className="rounded-full bg-spark/10 px-2 py-0.5 text-xs font-semibold text-spark">
                          Grade: {sub.grade}
                        </span>
                      )}
                    </div>
                    {a.lesson?.title && (
                      <p className="text-xs text-white/40">
                        Lesson: {a.lesson.title}
                      </p>
                    )}
                    {a.description && (
                      <p className="mt-1.5 line-clamp-2 text-sm text-white/60">
                        {a.description}
                      </p>
                    )}
                    <div className="mt-3 flex flex-wrap items-center gap-3 text-xs">
                      {status === "not_started" ? (
                        <span className="text-white/40">Not started</span>
                      ) : (
                        <StatusBadge status={status} />
                      )}
                      {a.due_at && (
                        <span
                          className={
                            due === "overdue"
                              ? "text-red-300"
                              : due === "soon"
                                ? "text-amber-300"
                                : "text-white/50"
                          }
                        >
                          {due === "overdue" ? "Overdue · " : "Due "}
                          {fmtDue(a.due_at)}
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              </Card>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
