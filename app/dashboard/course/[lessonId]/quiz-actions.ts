"use server";
import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { assertSelf } from "@/lib/server-guards";

export async function submitQuizAttempt(args: {
  quizId: string;
  lessonId: string;
  answers: Record<string, string>;
}) {
  const { userId } = await assertSelf();
  const admin = createAdminClient();
  const { data: questions, error: qErr } = await admin
    .from("quiz_questions")
    .select("id, correct_option_id")
    .eq("quiz_id", args.quizId);
  if (qErr) throw new Error(qErr.message);
  const total = questions?.length ?? 0;
  let score = 0;
  for (const q of (questions ?? []) as any[]) {
    if (args.answers[q.id] === q.correct_option_id) score++;
  }
  const { error } = await admin.from("quiz_attempts").insert({
    quiz_id: args.quizId,
    user_id: userId,
    answers: args.answers,
    score,
    total,
  });
  if (error) throw new Error(error.message);
  revalidatePath(`/dashboard/course/${args.lessonId}`);
  return { score, total };
}
