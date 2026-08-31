import Link from "next/link";
import { CheckCircle2, Circle, Lock, PlayCircle } from "lucide-react";
import { requireViewer } from "@/lib/auth";
import { getStudentAccess } from "@/lib/access";
import { createAdminClient } from "@/lib/supabase/admin";
import { cohortWeek } from "@/lib/cohort-week";
import { fmtDateOnly } from "@/lib/pre-cohort";
import { AppHeader, AppBody, Empty, Alert } from "@/components/app/frame";
import type { Role } from "@/lib/types";

export const metadata = { title: "Course · batch0" };
export const dynamic = "force-dynamic";

/**
 * The course, as a phone shows it: where am I, what have I finished, what's
 * next.
 *
 * Lessons link out to /dashboard/course/[id] rather than being reimplemented
 * here. That page is a video player with materials, comments and a progress
 * recorder — none of which gets better by being rebuilt at 390px, and all of
 * which would then need maintaining twice. What this screen owns is the map:
 * every week, how much of it is done, and one tap into any lesson.
 *
 * The current week is expanded and the rest collapse to a single row with a
 * count. Nine weeks of fully-expanded lesson lists is exactly the "overwhelming"
 * failure this surface exists to avoid.
 */
export default async function StudentAppCourse() {
  const { profile } = await requireViewer();
  const access = await getStudentAccess(profile.role as Role);
  const admin = createAdminClient();

  if (!access.enrolled) {
    return (
      <>
        <AppHeader title="Course" eyebrow="Locked" />
        <AppBody>
          <Alert tone="info" title="The course unlocks at enrollment.">
            Once your seat is paid for, every week's lessons and deliverables
            show up here.
          </Alert>
        </AppBody>
      </>
    );
  }
  if (access.preCohort) {
    const startLabel = fmtDateOnly(access.cohortStartsOn);
    return (
      <>
        <AppHeader
          title="Course"
          eyebrow={startLabel ? `Opens ${startLabel}` : "Opens soon"}
        />
        <AppBody>
          <Alert tone="info" title="Not open yet.">
            Week one goes live when the cohort starts
            {startLabel ? ` on ${startLabel}` : ""}. Kickoff and the pre-cohort
            resources are open in the meantime.
          </Alert>
        </AppBody>
      </>
    );
  }

  // ---- Wave 1: both keyed on the user alone ----
  // Progress used to wait behind the module list so it could be filtered to
  // those lessons. Fetching the student's whole completed set unfiltered is one
  // small table read and removes a serial round trip; the intersection is done
  // in memory below.
  const [{ data: enrollment }, { data: progress }] = await Promise.all([
    admin
      .from("enrollments")
      .select("cohort_id, cohort:cohorts(name, starts_on)")
      .eq("user_id", profile.id)
      .maybeSingle(),
    admin
      .from("lesson_progress")
      .select("lesson_id")
      .eq("user_id", profile.id)
      .not("completed_at", "is", null),
  ]);

  const cohortId = (enrollment?.cohort_id as string | null) ?? access.cohortId;
  const cohort = normalizeEmbed<{ name: string | null; starts_on: string | null }>(
    enrollment?.cohort,
  );

  if (!cohortId) {
    return (
      <>
        <AppHeader title="Course" />
        <AppBody>
          <Empty>No cohort assigned yet.</Empty>
        </AppBody>
      </>
    );
  }

  // ---- Wave 2: the whole syllabus in one query ----
  // Lessons ride along as a nested embed rather than a second `in("module_id",
  // …)` query that could only be issued once the module ids were known. Same
  // rows, one round trip instead of two.
  const { data: modules } = await admin
    .from("modules")
    .select(
      "id, week, title, summary, position, lessons(id, title, duration_seconds, position)",
    )
    .eq("cohort_id", cohortId)
    .order("week", { ascending: true })
    .order("position", { ascending: true })
    .order("position", { ascending: true, referencedTable: "lessons" });

  const doneIds = new Set((progress ?? []).map((p) => p.lesson_id as string));
  type LessonRow = {
    id: string;
    title: string;
    duration_seconds: number | null;
  };
  const byModule = new Map<string, LessonRow[]>();
  let totalLessons = 0;
  let doneLessons = 0;
  for (const m of modules ?? []) {
    const items = ((m.lessons ?? []) as LessonRow[]) ?? [];
    byModule.set(m.id as string, items);
    totalLessons += items.length;
    doneLessons += items.filter((l) => doneIds.has(l.id)).length;
  }

  const week = cohortWeek(cohort?.starts_on);

  return (
    <>
      <AppHeader
        title="Course"
        eyebrow={
          totalLessons > 0
            ? `${doneLessons}/${totalLessons} lessons done`
            : (cohort?.name ?? "batch0")
        }
      />
      <AppBody>
        {(modules ?? []).length === 0 ? (
          <Empty>No modules published yet. They appear as each week opens.</Empty>
        ) : (
          <div className="space-y-2.5">
            {(modules ?? []).map((m) => {
              const items = byModule.get(m.id as string) ?? [];
              const done = items.filter((l) => doneIds.has(l.id)).length;
              const current = week !== null && m.week === week;
              // A module for a week that hasn't arrived is shown, but marked —
              // students plan around what's coming, and hiding it entirely makes
              // the course look shorter than it is.
              const ahead = week !== null && m.week > week;
              return (
                <details
                  key={m.id as string}
                  open={current}
                  className="group overflow-hidden rounded-2xl border border-line bg-wash open:bg-paper"
                >
                  <summary className="press flex cursor-pointer list-none items-center gap-3 px-4 py-3.5 active:bg-wash [&::-webkit-details-marker]:hidden">
                    <div className="min-w-0 flex-1">
                      <p
                        className={`font-mono text-[10px] font-medium uppercase tracking-[0.2em] ${
                          current ? "text-phosphor-ink" : "text-ink-faint"
                        }`}
                      >
                        Week {m.week}
                        {current && " · this week"}
                      </p>
                      <p className="mt-1 truncate text-[15px] leading-tight text-ink">
                        {m.title}
                      </p>
                    </div>
                    <span className="shrink-0 font-mono text-[11px] tabular-nums text-ink-faint">
                      {ahead && items.length === 0 ? (
                        <Lock className="h-3.5 w-3.5" />
                      ) : (
                        `${done}/${items.length}`
                      )}
                    </span>
                  </summary>

                  <div className="border-t border-line px-4">
                    {items.length === 0 ? (
                      <p className="py-4 text-[13px] text-ink-faint">
                        Lessons for this week aren&apos;t published yet.
                      </p>
                    ) : (
                      items.map((l) => {
                        const complete = doneIds.has(l.id as string);
                        return (
                          <Link
                            key={l.id as string}
                            href={`/dashboard/course/${l.id}`}
                            prefetch={false}
                            className="press -mx-2 flex min-h-[52px] items-center gap-3 border-b border-line px-2 last:border-0 active:bg-wash"
                          >
                            {complete ? (
                              <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
                            ) : (
                              <Circle className="h-4 w-4 shrink-0 text-ink-faint" />
                            )}
                            <span
                              className={`min-w-0 flex-1 truncate text-[14px] ${
                                complete ? "text-ink-soft" : "text-ink"
                              }`}
                            >
                              {l.title}
                            </span>
                            {!!l.duration_seconds && (
                              <span className="shrink-0 font-mono text-[11px] tabular-nums text-ink-faint">
                                {Math.round((l.duration_seconds as number) / 60)}m
                              </span>
                            )}
                            <PlayCircle className="h-4 w-4 shrink-0 text-ink-faint" />
                          </Link>
                        );
                      })
                    )}
                  </div>
                </details>
              );
            })}
          </div>
        )}

        <p className="mt-6 text-center text-[12px] text-ink-faint">
          Assignments, comments and materials live in the{" "}
          <Link
            href="/dashboard/course"
            prefetch={false}
            className="text-phosphor-ink underline"
          >
            full course
          </Link>
          .
        </p>
      </AppBody>
    </>
  );
}

function normalizeEmbed<T>(value: unknown): T | null {
  if (!value) return null;
  return (Array.isArray(value) ? (value[0] ?? null) : value) as T | null;
}
