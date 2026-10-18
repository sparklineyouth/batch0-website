import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { requireUser } from "@/lib/auth";
import { Card } from "@/components/ui/card";
import { LessonPlayer } from "./lesson-player";
import { ArrowLeft, FileText } from "lucide-react";
import { renderLessonMarkdown } from "@/lib/lesson-content";
import { loadStudentAssignments } from "@/lib/assignments-server";
import { formatEastern } from "@/lib/assignments";
import { StatusChip } from "@/components/assignments/status-chip";
import {
  lessonMaterialHref,
  lessonMaterials,
  lessonVideoHref,
  materialProblem,
} from "@/lib/lesson-assets";
import { MaterialLink } from "@/components/dashboard/material-link";

export const dynamic = "force-dynamic";

export default async function LessonPage(
  props: {
    params: Promise<{ lessonId: string }>;
    searchParams: Promise<{ material?: string | string[] }>;
  }
) {
  const [params, searchParams] = await Promise.all([props.params, props.searchParams]);
  const user = await requireUser();
  const supabase = await createClient();

  // Nothing is signed here any more. The video and every material link point
  // at routes that check the viewer can read this lesson and sign at the
  // moment of the request (lib/lesson-assets.ts): a URL minted at render was
  // dead ten minutes later, which is before most students reach the
  // worksheet at the bottom of a lesson.
  const [{ data: lesson }, { data: progress }, attached] = await Promise.all([
    supabase
      .from("lessons")
      .select("*, module:modules(week, title, cohort_id)")
      .eq("id", params.lessonId)
      .maybeSingle(),
    supabase
      .from("lesson_progress")
      .select("watched_seconds, completed_at")
      .eq("user_id", user.id)
      .eq("lesson_id", params.lessonId)
      .maybeSingle(),
    // Assignments anchored to this lesson that this student has been set.
    loadStudentAssignments(supabase, user.id, { lessonId: params.lessonId }),
  ]);

  if (!lesson) notFound();
  const lessonHtml = lesson.description ? await renderLessonMarkdown(lesson.description) : null;
  const { data: syllabus } = await supabase
    .from("modules")
    .select("week, position, lessons(id, title, position)")
    .eq("cohort_id", lesson.module.cohort_id)
    .order("week", { ascending: true })
    .order("position", { ascending: true });
  const sequence = (syllabus ?? []).flatMap((m: any) =>
    [...(m.lessons ?? [])].sort((a: any, b: any) => a.position - b.position),
  );
  const lessonIndex = sequence.findIndex((l: any) => l.id === lesson.id);
  const nextLesson = lessonIndex >= 0 ? sequence[lessonIndex + 1] : null;
  const videoSrc: string | null = lesson.video_path
    ? lessonVideoHref(lesson.id)
    : lesson.video_url || null;
  const materials = lessonMaterials(lesson.materials).map((m) => ({
    title: m.title,
    href: lessonMaterialHref(lesson.id, m.path),
  }));
  const problem = materialProblem(searchParams.material);

  return (
    <div className="mx-auto max-w-4xl">
      <Link
        href="/dashboard/course"
        className="inline-flex items-center gap-1.5 text-sm text-ink-soft hover:text-ink"
      >
        <ArrowLeft className="h-4 w-4" /> Back to course
      </Link>
      <div className="mt-4">
        <p className="text-xs font-medium uppercase tracking-wider text-phosphor-ink">
          Week {lesson.module?.week} · {lesson.module?.title}
        </p>
        <h1 className="mt-1 text-2xl font-bold tracking-tight md:text-3xl">
          {lesson.title}
        </h1>
      </div>

      {attached.items.map(({ assignment: a, status }) => (
        <Link
          key={a.id}
          href={`/dashboard/assignments/${a.id}`}
          className="mt-6 flex items-center gap-3 border-y border-line py-3 text-sm hover:bg-wash"
        >
          <span className="min-w-0 flex-1 truncate text-ink">
            Assignment: {a.title}
            {a.due_at && <span className="text-ink-faint"> · Due {formatEastern(a.due_at)}</span>}
          </span>
          <StatusChip status={status} />
        </Link>
      ))}

      {lessonHtml && (
        <article
          aria-label="Lesson and exercises"
          className="blog-prose mt-8 max-w-none"
          dangerouslySetInnerHTML={{ __html: lessonHtml }}
        />
      )}

      <div className="mt-6">
        <LessonPlayer
          lessonId={lesson.id}
          videoSrc={videoSrc}
          // Signed by the video route, so the player may ask it again.
          refreshable={Boolean(lesson.video_path)}
          // As saved: the player applies the resume rules against the file's
          // real duration (lessons.duration_seconds is typed by hand), and
          // re-reads it in case this page came out of the router cache.
          savedSeconds={progress?.watched_seconds ?? 0}
          completed={Boolean(progress?.completed_at)}
        />
      </div>

      {/* A material link that couldn't open lands back here (its route). */}
      {problem && (
        <p role="alert" className="mt-6 text-sm text-red-600 dark:text-red-400">
          {problem === "missing"
            ? "That file isn't part of this lesson any more — it may have been replaced."
            : "That file couldn't be opened just now. Try again in a moment."}
        </p>
      )}
      {materials.length > 0 && (
        <Card className="mt-6">
          <h3 className="mb-3 text-sm font-medium uppercase tracking-wider text-ink-soft">
            Materials
          </h3>
          <ul className="space-y-2">
            {materials.map((m, i) => (
              <li key={i}>
                <MaterialLink
                  href={m.href}
                  className="inline-flex items-center gap-2 text-sm text-phosphor-ink hover:underline"
                >
                  <FileText className="h-4 w-4" />
                  {m.title}
                </MaterialLink>
              </li>
            ))}
          </ul>
        </Card>
      )}
      {nextLesson && (
        <Link href={`/dashboard/course/${nextLesson.id}`} className="mt-8 block rounded-xl border border-line p-5 text-sm hover:bg-wash">
          <span className="block text-xs uppercase tracking-wider text-ink-faint">Next lesson</span>
          <span className="mt-1 block font-medium text-phosphor-ink">{nextLesson.title} →</span>
        </Link>
      )}
    </div>
  );
}
