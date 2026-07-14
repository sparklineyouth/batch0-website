import Link from "next/link";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireAdmin } from "@/lib/auth";
import { Card } from "@/components/ui/card";

export const metadata = { title: "Course analytics · Admin" };

const CONFUSED_WORDS = [
  "confused",
  "confusing",
  "lost",
  "unclear",
  "don't get",
  "dont get",
  "stuck",
  "huh",
  "wat",
  "doesn't make sense",
  "doesnt make sense",
];
const STUCK_WORDS = ["stuck", "blocked", "broken", "error", "doesn't work"];

function classify(body: string): {
  confused: boolean;
  stuck: boolean;
  question: boolean;
} {
  const t = body.toLowerCase();
  return {
    confused: CONFUSED_WORDS.some((w) => t.includes(w)),
    stuck: STUCK_WORDS.some((w) => t.includes(w)),
    question: t.includes("?"),
  };
}

export default async function CourseAnalyticsPage() {
  await requireAdmin();
  const admin = createAdminClient();

  const [
    { data: modules },
    { data: lessons },
    { data: comments },
    { data: feedback },
    { count: enrolledTotal },
  ] = await Promise.all([
    admin
      .from("modules")
      .select("id, week, title, cohort_id")
      .order("week", { ascending: true }),
    admin.from("lessons").select("id, module_id, title, position"),
    admin
      .from("lesson_comments")
      .select("lesson_id, body, created_at, user_id"),
    admin
      .from("file_feedback")
      .select("body, created_at, student_file_id, team_file_id"),
    admin
      .from("enrollments")
      .select("id", { count: "exact", head: true }),
  ]);

  const lessonsByModule = new Map<string, any[]>();
  for (const l of (lessons ?? []) as any[]) {
    const arr = lessonsByModule.get(l.module_id) ?? [];
    arr.push(l);
    lessonsByModule.set(l.module_id, arr);
  }

  const commentsByLesson = new Map<string, any[]>();
  for (const c of (comments ?? []) as any[]) {
    const arr = commentsByLesson.get(c.lesson_id) ?? [];
    arr.push(c);
    commentsByLesson.set(c.lesson_id, arr);
  }

  // Per-module aggregates.
  const moduleRows = (modules ?? []).map((m: any) => {
    const moduleLessons = lessonsByModule.get(m.id) ?? [];
    let comments = 0;
    let confused = 0;
    let stuck = 0;
    let questions = 0;
    const uniqueUsers = new Set<string>();
    const recent: { body: string; created_at: string; lessonTitle: string }[] =
      [];
    for (const l of moduleLessons) {
      const cs = commentsByLesson.get(l.id) ?? [];
      for (const c of cs) {
        comments += 1;
        const cls = classify(c.body);
        if (cls.confused) confused += 1;
        if (cls.stuck) stuck += 1;
        if (cls.question) questions += 1;
        uniqueUsers.add(c.user_id);
        if (cls.confused || cls.stuck) {
          recent.push({
            body: c.body,
            created_at: c.created_at,
            lessonTitle: l.title,
          });
        }
      }
    }
    recent.sort((a, b) => b.created_at.localeCompare(a.created_at));
    return {
      id: m.id,
      week: m.week,
      title: m.title,
      lessons: moduleLessons.length,
      comments,
      confused,
      stuck,
      questions,
      uniqueUsers: uniqueUsers.size,
      confusedRate: comments > 0 ? (confused / comments) * 100 : 0,
      recent: recent.slice(0, 5),
    };
  });

  // File feedback frequency
  const fileFbCount = feedback?.length ?? 0;

  return (
    <div className="mx-auto max-w-5xl">
      <Link
        href="/admin/course"
        className="text-sm text-ink-soft hover:text-ink"
      >
        ← Course
      </Link>
      <h1 className="mt-3 font-display text-3xl font-bold tracking-[-0.02em] text-ink">
        Course analytics
      </h1>
      <p className="mt-1 text-sm text-ink-soft">
        Heuristic signal pulled from lesson Q&amp;A and file feedback. Use it to
        spot weeks where confusion clusters — the topic likely needs a
        rewrite or extra office hours.
      </p>

      <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Enrolled" value={String(enrolledTotal ?? 0)} />
        <Stat
          label="Lesson comments"
          value={String(comments?.length ?? 0)}
        />
        <Stat label="File feedback" value={String(fileFbCount)} />
        <Stat
          label="Avg per module"
          value={
            moduleRows.length > 0
              ? Math.round(
                  moduleRows.reduce((s, r) => s + r.comments, 0) /
                    moduleRows.length,
                ).toString()
              : "—"
          }
        />
      </div>

      <Card className="mt-6 !p-0">
        <div className="grid grid-cols-12 border-b border-line px-4 py-2 text-[10px] font-semibold uppercase tracking-wider text-ink-faint">
          <div className="col-span-1">Wk</div>
          <div className="col-span-5">Module</div>
          <div className="col-span-2 text-right">Comments</div>
          <div className="col-span-2 text-right">Questions</div>
          <div className="col-span-2 text-right">Confused</div>
        </div>
        <ul className="divide-y divide-line">
          {moduleRows.length === 0 && (
            <li className="px-4 py-6 text-sm text-ink-faint">
              No modules yet.
            </li>
          )}
          {moduleRows.map((r) => (
            <li key={r.id} className="px-4 py-3">
              <div className="grid grid-cols-12 items-baseline gap-2">
                <div className="col-span-1 text-xs text-ink-soft">{r.week}</div>
                <div className="col-span-5">
                  <p className="truncate text-sm font-medium text-ink">
                    {r.title}
                  </p>
                  <p className="text-[11px] text-ink-faint">
                    {r.lessons} lesson{r.lessons === 1 ? "" : "s"} ·{" "}
                    {r.uniqueUsers} unique students
                  </p>
                </div>
                <div className="col-span-2 text-right text-sm tabular-nums text-ink-soft">
                  {r.comments}
                </div>
                <div className="col-span-2 text-right text-sm tabular-nums text-ink-soft">
                  {r.questions}
                </div>
                <div className="col-span-2 text-right">
                  <span
                    className={`text-sm font-semibold tabular-nums ${
                      r.confusedRate >= 30
                        ? "text-amber-700 dark:text-amber-300"
                        : r.confusedRate >= 15
                          ? "text-phosphor-ink"
                          : "text-ink-soft"
                    }`}
                  >
                    {r.confused} ({r.confusedRate.toFixed(0)}%)
                  </span>
                </div>
              </div>
              {r.recent.length > 0 && (
                <details className="mt-2">
                  <summary className="cursor-pointer text-[11px] uppercase tracking-wider text-ink-faint hover:text-ink-soft">
                    Recent confusion / stuck signals
                  </summary>
                  <ul className="mt-2 space-y-2 pl-2">
                    {r.recent.map((c, i) => (
                      <li
                        key={i}
                        className="rounded-lg border border-line bg-wash p-2 text-xs"
                      >
                        <p className="text-ink-faint">{c.lessonTitle}</p>
                        <p className="mt-0.5 text-ink-soft">
                          {c.body.slice(0, 220)}
                          {c.body.length > 220 ? "…" : ""}
                        </p>
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-line bg-wash p-3">
      <p className="text-[10px] uppercase tracking-wider text-ink-faint">
        {label}
      </p>
      <p className="mt-1 text-lg font-semibold text-ink">{value}</p>
    </div>
  );
}
