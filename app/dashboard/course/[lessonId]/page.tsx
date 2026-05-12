import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireUser, getProfile } from "@/lib/auth";
import { Card } from "@/components/ui/card";
import { LessonPlayer } from "./lesson-player";
import { Comments } from "./comments";
import { ArrowLeft, FileText } from "lucide-react";

export const dynamic = "force-dynamic";

export default async function LessonPage({
  params,
}: {
  params: { lessonId: string };
}) {
  const user = await requireUser();
  const profile = await getProfile();
  const supabase = createClient();

  const { data: lesson } = await supabase
    .from("lessons")
    .select("*, module:modules(*, cohort:cohorts(*))")
    .eq("id", params.lessonId)
    .maybeSingle();

  if (!lesson) notFound();

  // Signed URLs for lesson assets are short-lived (10 min) and minted
  // server-side per request. Long-TTL URLs that leak into HTML source /
  // browser history / share sheets are a low-grade access leak; this
  // keeps the window tight while still being long enough to start a
  // video. The page is `force-dynamic` so every viewer gets a fresh URL.
  const SIGNED_URL_TTL = 60 * 10;
  let videoUrl: string | null = lesson.video_url || null;
  if (lesson.video_path) {
    const adminCli = createAdminClient();
    const { data } = await adminCli.storage
      .from("course-videos")
      .createSignedUrl(lesson.video_path, SIGNED_URL_TTL);
    if (data?.signedUrl) videoUrl = data.signedUrl;
  }

  const materials: { title: string; url: string }[] = [];
  if (Array.isArray(lesson.materials) && lesson.materials.length > 0) {
    const adminCli = createAdminClient();
    for (const m of lesson.materials as any[]) {
      if (!m?.path) continue;
      const { data } = await adminCli.storage
        .from("course-materials")
        .createSignedUrl(m.path, SIGNED_URL_TTL);
      if (data?.signedUrl) {
        materials.push({ title: m.title || m.path, url: data.signedUrl });
      }
    }
  }

  const { data: progress } = await supabase
    .from("lesson_progress")
    .select("watched_seconds, completed_at")
    .eq("user_id", user.id)
    .eq("lesson_id", lesson.id)
    .maybeSingle();

  // Comments + author profile in a single embedded select.
  const { data: commentRows } = await supabase
    .from("lesson_comments")
    .select(
      "id, user_id, parent_id, body, created_at, author:profiles(full_name, email, role)",
    )
    .eq("lesson_id", lesson.id)
    .order("created_at", { ascending: true });
  const comments = (commentRows ?? []).map((c: any) => ({
    ...c,
    author: Array.isArray(c.author) ? c.author[0] : c.author,
  }));

  const isStaff =
    profile?.role === "admin" || profile?.role === "mentor";

  return (
    <div className="mx-auto max-w-4xl">
      <Link
        href="/dashboard/course"
        className="inline-flex items-center gap-1.5 text-sm text-white/55 hover:text-white"
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
          <p className="mt-2 text-white/65">{lesson.description}</p>
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
          <h3 className="mb-3 text-sm font-medium uppercase tracking-wider text-white/55">
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


      <Card className="mt-8">
        <Comments
          lessonId={lesson.id}
          initial={comments as any}
          currentUserId={user.id}
          isStaff={isStaff}
        />
      </Card>
    </div>
  );
}
