import Link from "next/link";
import { notFound } from "next/navigation";
import { createAdminClient } from "@/lib/supabase/admin";
import { Card } from "@/components/ui/card";
import { QuizEditor } from "./quiz-editor";

export const metadata = { title: "Edit quiz · Admin" };

export default async function QuizEditorPage({
  params,
}: {
  params: { lessonId: string };
}) {
  const admin = createAdminClient();
  const { data: lesson } = await admin
    .from("lessons")
    .select("id, title")
    .eq("id", params.lessonId)
    .maybeSingle();
  if (!lesson) notFound();

  const { data: quiz } = await admin
    .from("quizzes")
    .select("id, title, quiz_questions(*)")
    .eq("lesson_id", params.lessonId)
    .maybeSingle();

  const questions = ((quiz?.quiz_questions ?? []) as any[])
    .sort((a, b) => a.position - b.position)
    .map((q) => ({
      id: q.id,
      question: q.question,
      options: q.options,
      correct_option_id: q.correct_option_id,
      position: q.position,
    }));

  return (
    <div className="mx-auto max-w-3xl">
      <Link
        href="/admin/course"
        className="text-sm text-white/55 hover:text-white"
      >
        ← Course
      </Link>
      <h1 className="mt-3 text-3xl font-bold tracking-tight">
        Quiz: {lesson.title}
      </h1>
      <p className="mt-1 text-sm text-white/55">
        Multiple-choice questions auto-graded for enrolled students.
      </p>
      <Card className="mt-6">
        <QuizEditor
          lessonId={lesson.id}
          initialTitle={quiz?.title ?? ""}
          initialQuestions={questions}
        />
      </Card>
    </div>
  );
}
