"use server";
import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { assertStaff } from "@/lib/server-guards";

export type QuizQuestionInput = {
  id?: string;
  question: string;
  options: { id: string; text: string }[];
  correct_option_id: string;
  position: number;
};

export type QuizInput = {
  lessonId: string;
  title: string | null;
  questions: QuizQuestionInput[];
};

export async function saveQuiz(input: QuizInput) {
  await assertStaff();
  if (input.questions.length === 0) {
    throw new Error("Add at least one question.");
  }
  for (const q of input.questions) {
    if (!q.question.trim()) throw new Error("Each question needs text.");
    if (q.options.length < 2) throw new Error("Each question needs ≥2 options.");
    if (!q.options.some((o) => o.id === q.correct_option_id)) {
      throw new Error("Mark a correct option for each question.");
    }
  }

  const admin = createAdminClient();

  // Upsert the quiz row (1 per lesson).
  const { data: existingQuiz } = await admin
    .from("quizzes")
    .select("id")
    .eq("lesson_id", input.lessonId)
    .maybeSingle();

  let quizId = existingQuiz?.id ?? null;
  if (quizId) {
    await admin
      .from("quizzes")
      .update({ title: input.title?.trim() || null })
      .eq("id", quizId);
  } else {
    const { data: created, error } = await admin
      .from("quizzes")
      .insert({
        lesson_id: input.lessonId,
        title: input.title?.trim() || null,
      })
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    quizId = created!.id;
  }

  // Replace question set wholesale (simpler than diffing).
  await admin.from("quiz_questions").delete().eq("quiz_id", quizId);
  const rows = input.questions.map((q, i) => ({
    quiz_id: quizId!,
    question: q.question.trim(),
    options: q.options,
    correct_option_id: q.correct_option_id,
    position: i,
  }));
  if (rows.length > 0) {
    const { error } = await admin.from("quiz_questions").insert(rows);
    if (error) throw new Error(error.message);
  }

  revalidatePath(`/admin/course/quiz/${input.lessonId}`);
  revalidatePath(`/dashboard/course/${input.lessonId}`);
}

export async function deleteQuiz(lessonId: string) {
  await assertStaff();
  const admin = createAdminClient();
  await admin.from("quizzes").delete().eq("lesson_id", lessonId);
  revalidatePath(`/admin/course/quiz/${lessonId}`);
  revalidatePath(`/dashboard/course/${lessonId}`);
}
