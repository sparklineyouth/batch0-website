import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { requireUser } from "@/lib/auth";
import { Card } from "@/components/ui/card";
import { CheckCircle2, PlayCircle, Lock } from "lucide-react";

export const metadata = { title: "Course · batch0" };

export default async function CoursePage() {
  const user = await requireUser();
  const supabase = createClient();

  const { data: enrollment } = await supabase
    .from("enrollments")
    .select("*, cohort:cohorts(*)")
    .eq("user_id", user.id)
    .maybeSingle();

  if (!enrollment) {
    return (
      <div className="mx-auto max-w-3xl">
        <h1 className="text-3xl font-bold tracking-tight">Course</h1>
        <Card className="mt-6">
          <div className="flex items-center gap-3">
            <Lock className="h-5 w-5 text-ink-faint" />
            <p className="text-ink-soft">
              Course access unlocks once you're enrolled. Submit and pay for your application to get in.
            </p>
          </div>
          <Link
            href="/dashboard/application"
            className="mt-4 inline-block text-sm text-phosphor-ink hover:underline"
          >
            View application →
          </Link>
        </Card>
      </div>
    );
  }

  const { data: modules } = await supabase
    .from("modules")
    .select("*, lessons:lessons(*)")
    .eq("cohort_id", enrollment.cohort_id)
    .order("position", { ascending: true });

  const { data: progress } = await supabase
    .from("lesson_progress")
    .select("lesson_id, completed_at")
    .eq("user_id", user.id);

  const completed = new Set(
    (progress ?? []).filter((p) => p.completed_at).map((p) => p.lesson_id),
  );

  const allLessons = (modules ?? []).flatMap((m: any) =>
    (m.lessons ?? []).sort((a: any, b: any) => a.position - b.position),
  );
  const totalLessons = allLessons.length;
  const completedCount = allLessons.filter((l: any) => completed.has(l.id)).length;
  const pct = totalLessons === 0 ? 0 : Math.round((completedCount / totalLessons) * 100);

  return (
    <div className="mx-auto max-w-4xl">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">
            {enrollment.cohort?.name ?? "Course"}
          </h1>
          <p className="mt-1 text-sm text-ink-faint">
            {totalLessons} lessons · {completedCount} completed
          </p>
        </div>
        <div className="text-right">
          <div className="text-sm text-ink-faint">Progress</div>
          <div className="text-2xl font-semibold text-phosphor-ink">{pct}%</div>
        </div>
      </div>

      <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-wash">
        <div className="h-full bg-phosphor-fill transition-all" style={{ width: `${pct}%` }} />
      </div>

      <div className="mt-10 space-y-6">
        {(modules ?? []).map((m: any) => {
          const sortedLessons = [...(m.lessons ?? [])].sort(
            (a, b) => a.position - b.position,
          );
          return (
            <Card key={m.id} className="!p-0 overflow-hidden">
              <div className="border-b border-line bg-paper px-6 py-4">
                <p className="text-xs font-medium uppercase tracking-wider text-phosphor-ink">
                  Week {m.week}
                </p>
                <h3 className="mt-1 text-lg font-semibold">{m.title}</h3>
                {m.summary && (
                  <p className="mt-1 text-sm text-ink-faint">{m.summary}</p>
                )}
              </div>
              <ul className="divide-y divide-line">
                {sortedLessons.length === 0 && (
                  <li className="px-6 py-4 text-sm text-ink-faint">
                    No lessons yet.
                  </li>
                )}
                {sortedLessons.map((l: any) => (
                  <li key={l.id}>
                    <Link
                      href={`/dashboard/course/${l.id}`}
                      className="flex items-center gap-3 px-6 py-3.5 transition hover:bg-wash"
                    >
                      {completed.has(l.id) ? (
                        <CheckCircle2 className="h-5 w-5 shrink-0 text-emerald-600 dark:text-emerald-400" />
                      ) : (
                        <PlayCircle className="h-5 w-5 shrink-0 text-ink-faint" />
                      )}
                      <span className="flex-1 text-sm">{l.title}</span>
                      {l.duration_seconds && (
                        <span className="text-xs text-ink-faint">
                          {Math.round(l.duration_seconds / 60)} min
                        </span>
                      )}
                    </Link>
                  </li>
                ))}
              </ul>
            </Card>
          );
        })}
        {(modules?.length ?? 0) === 0 && (
          <Card>
            <p className="text-ink-soft">
              The instructors haven't published any modules yet. Check back soon.
            </p>
          </Card>
        )}
      </div>
    </div>
  );
}
