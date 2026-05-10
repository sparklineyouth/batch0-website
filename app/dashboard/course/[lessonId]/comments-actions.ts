"use server";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { assertSelf } from "@/lib/server-guards";

export async function postLessonComment(args: {
  lessonId: string;
  parentId: string | null;
  body: string;
}) {
  const { userId } = await assertSelf();
  const body = args.body.trim();
  if (!body) throw new Error("Empty comment");
  if (body.length > 4000) throw new Error("Comment too long");

  const supabase = createClient();
  // RLS will block if not enrolled; insert via the user-scoped client
  // so the policy is enforced.
  const { error } = await supabase.from("lesson_comments").insert({
    lesson_id: args.lessonId,
    parent_id: args.parentId,
    body,
    user_id: userId,
  });
  if (error) throw new Error(error.message);
  revalidatePath(`/dashboard/course/${args.lessonId}`);
}

export async function deleteLessonComment(commentId: string) {
  const { userId } = await assertSelf();
  const admin = createAdminClient();
  const { data: existing } = await admin
    .from("lesson_comments")
    .select("user_id, lesson_id")
    .eq("id", commentId)
    .single();
  if (!existing) throw new Error("Not found");

  const supabase = createClient();
  const { data: profile } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", userId)
    .single();

  const isStaff = profile?.role === "admin" || profile?.role === "professor";
  if (existing.user_id !== userId && !isStaff) {
    throw new Error("Forbidden");
  }
  const { error } = await admin
    .from("lesson_comments")
    .delete()
    .eq("id", commentId);
  if (error) throw new Error(error.message);
  revalidatePath(`/dashboard/course/${existing.lesson_id}`);
}
