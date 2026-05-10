import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireUser } from "@/lib/auth";
import { Card } from "@/components/ui/card";
import { LessonPlayer } from "./lesson-player";
import { ArrowLeft, FileText } from "lucide-react";

export const dynamic = "force-dynamic";

export default async function LessonPage({
  params,
}: {
  params: { lessonId: string };
}) {
  const user = await requireUser();
  const supabase = createClient();

  // RLS will enforce that only enrolled users can read the lesson
  const { data: lesson } = await supabase
    .from("lessons")
    .select("*, module:modules(*, cohort:cohorts(*))")
    .eq("id", params.lessonId)
    .maybeSingle();

  if (!lesson) notFound();

  // Generate signed URL for video if stored in Supabase Storage
  let videoUrl: string | null = lesson.video_url || null;
  if (lesson.video_path) {
    const admin = createAdminClient();
    const { data } = await admin.storage
      .from("course-videos")
      .createSignedUrl(lesson.video_path, 60 * 60 * 4); // 4 hours
    if (data?.signedUrl) videoUrl = data.signedUrl;
  }

  // Signed URLs for materials
  const materials: { title: string; url: string }[] = [];
  if (Array.isArray(lesson.materials) && lesson.materials.length > 0) {
    const admin = createAdminClient();
    for (const m of lesson.materials as any[]) {
      if (!m?.path) continue;
      const { data } = await admin.storage
        .from("course-materials")
        .createSignedUrl(m.path, 60 * 60 * 4);
      if (data?.signedUrl) {
        materials.push({ title: m.title || m.path, url: data.signedUrl });
      }
    }
  }

  // Existing progress
  const { data: progress } = await supabase
    .from("lesson_progress")
    .select("watched_seconds, completed_at")
    .eq("user_id", user.id)
    .eq("lesson_id", lesson.id)
    .maybeSingle();

  return (
    <div className="mx-auto max-w-4xl">
      <Link
        href="/dashboard/course"
        className="inline-flex items-center gap-1.5 text-sm text-white/50 hover:text-white"
      >
        <ArrowLeft className="h-4 w-4" /> Back to course
      </Link>
      <div className="mt-4">
        <p className="text-xs font-medium uppercase tracking-wider text-spark">
          Week {lesson.module?.week} · {lesson.module?.title}
        </p>
        <h1 className="mt-1 text-2xl font-bold tracking-tight md:text-3xl">
          {lesson.title}
        </h1>
        {lesson.description && (
          <p className="mt-2 text-white/60">{lesson.description}</p>
        )}
      </div>

      <div className="mt-6">
        <LessonPlayer
          lessonId={lesson.id}
          videoUrl={videoUrl}
          completed={Boolean(progress?.completed_at)}
        />
      </div>

      {materials.length > 0 && (
        <Card className="mt-6">
          <h3 className="mb-3 text-sm font-medium uppercase tracking-wider text-white/50">
            Materials
          </h3>
          <ul className="space-y-2">
            {materials.map((m, i) => (
              <li key={i}>
                <a
                  href={m.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-2 text-sm text-spark hover:underline"
                >
                  <FileText className="h-4 w-4" />
                  {m.title}
                </a>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
