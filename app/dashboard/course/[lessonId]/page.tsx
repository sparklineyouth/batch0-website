import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireUser, getProfile } from "@/lib/auth";
import { Card } from "@/components/ui/card";
import { LessonPlayer } from "./lesson-player";
import { Comments } from "./comments";
import { ArrowLeft, FileText } from "lucide-react";
import { renderLessonMarkdown } from "@/lib/lesson-content";

export const dynamic = "force-dynamic";

export default async function LessonPage({
  params,
}: {
  params: { lessonId: string };
}) {
  const user = await requireUser();
  const profile = await getProfile();
  const supabase = createClient();

  // Signed URLs for lesson assets are short-lived (10 min) and minted
  // server-side per request. Long-TTL URLs that leak into HTML source /
  // browser history / share sheets are a low-grade access leak; this
  // keeps the window tight while still being long enough to start a
  // video. The page is `force-dynamic` so every viewer gets a fresh URL.
  const SIGNED_URL_TTL = 60 * 10;

  // All materials in one storage batch, keeping the authored order and
  // skipping anything that fails to sign — same as minting one by one.
  const signAssets = async (lesson: any) => {
    let videoUrl: string | null = lesson.video_url || null;
    const materials: { title: string; url: string }[] = [];
    const adminCli = createAdminClient();
    const rawMaterials = Array.isArray(lesson.materials)
      ? (lesson.materials as any[]).filter((m) => m?.path)
      : [];
    const [video, signed] = await Promise.all([
      lesson.video_path
        ? adminCli.storage
            .from("course-videos")
            .createSignedUrl(lesson.video_path, SIGNED_URL_TTL)
        : null,
      rawMaterials.length > 0
        ? adminCli.storage
            .from("course-materials")
            .createSignedUrls(
              rawMaterials.map((m) => m.path as string),
              SIGNED_URL_TTL,
            )
        : null,
    ]);
    if (video?.data?.signedUrl) videoUrl = video.data.signedUrl;
    const byPath = new Map<string, string>();
    for (const item of signed?.data ?? []) {
      if (item.path && item.signedUrl) byPath.set(item.path, item.signedUrl);
    }
    for (const m of rawMaterials) {
      const url = byPath.get(m.path);
      if (url) materials.push({ title: m.title || m.path, url });
    }
    return { videoUrl, materials };
  };

  // Progress and comments filter only on the route param + user, so they
  // ride one batch with the lesson; the signed URLs chain off the lesson
  // row inside the same batch instead of adding serial stages.
  // Promise.resolve materializes the builder — a raw PostgREST builder
  // re-runs its fetch on every .then(), and this one is consumed twice.
  const lessonPromise = Promise.resolve(
    supabase
      .from("lessons")
      .select("*, module:modules(week, title, cohort_id)")
      .eq("id", params.lessonId)
      .maybeSingle(),
  );
  const [{ data: lesson }, assets, { data: progress }, { data: commentRows }] =
    await Promise.all([
      lessonPromise,
      lessonPromise.then(({ data: l }) =>
        l ? signAssets(l) : { videoUrl: null, materials: [] },
      ),
      supabase
        .from("lesson_progress")
        .select("watched_seconds, completed_at")
        .eq("user_id", user.id)
        .eq("lesson_id", params.lessonId)
        .maybeSingle(),
      // Comments + author profile in a single embedded select.
      supabase
        .from("lesson_comments")
        .select(
          "id, user_id, parent_id, body, created_at, author:profiles(full_name, email, role)",
        )
        .eq("lesson_id", params.lessonId)
        .order("created_at", { ascending: true }),
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
  const { videoUrl, materials } = assets;
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
          videoUrl={videoUrl}
          completed={Boolean(progress?.completed_at)}
        />
      </div>

      {materials.length > 0 && (
        <Card className="mt-6">
          <h3 className="mb-3 text-sm font-medium uppercase tracking-wider text-ink-soft">
            Materials
          </h3>
          <ul className="space-y-2">
            {materials.map((m, i) => (
              <li key={i}>
                <a
                  href={m.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-2 text-sm text-phosphor-ink hover:underline"
                >
                  <FileText className="h-4 w-4" />
                  {m.title}
                </a>
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
