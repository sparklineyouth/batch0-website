"use server";
import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { assertStaff } from "@/lib/server-guards";

export type AssignmentInput = {
  id?: string;
  cohort_id: string;
  lesson_id: string | null;
  title: string;
  description: string | null;
  due_at: string | null;
};

export async function saveAssignment(input: AssignmentInput) {
  const { userId } = await assertStaff();
  if (!input.title.trim()) throw new Error("Title is required");
  if (!input.cohort_id) throw new Error("Cohort is required");

  const admin = createAdminClient();
  const payload: Record<string, any> = {
    cohort_id: input.cohort_id,
    lesson_id: input.lesson_id || null,
    title: input.title.trim(),
    description: input.description?.trim() || null,
    due_at: input.due_at || null,
  };
  if (input.id) {
    const { error } = await admin
      .from("assignments")
      .update(payload)
      .eq("id", input.id);
    if (error) throw new Error(error.message);
  } else {
    payload.created_by = userId;
    const { error } = await admin.from("assignments").insert(payload);
    if (error) throw new Error(error.message);
  }
  revalidatePath("/professor/assignments");
  revalidatePath("/dashboard/assignments");
}

export async function deleteAssignment(id: string) {
  await assertStaff();
  const admin = createAdminClient();
  const { error } = await admin.from("assignments").delete().eq("id", id);
  if (error) throw new Error(error.message);
  revalidatePath("/professor/assignments");
  revalidatePath("/dashboard/assignments");
}

export type GradeInput = {
  submissionId: string;
  grade: string;
  feedback: string;
};

export async function gradeSubmission(input: GradeInput) {
  const { userId } = await assertStaff();
  const admin = createAdminClient();
  const { data: existing, error: fetchErr } = await admin
    .from("assignment_submissions")
    .select("assignment_id, status, submitted_at")
    .eq("id", input.submissionId)
    .single();
  if (fetchErr) throw new Error(fetchErr.message);

  const { error } = await admin
    .from("assignment_submissions")
    .update({
      grade: input.grade.trim() || null,
      feedback: input.feedback.trim() || null,
      status: "graded",
      submitted_at: existing.submitted_at ?? new Date().toISOString(),
      graded_by: userId,
      graded_at: new Date().toISOString(),
    })
    .eq("id", input.submissionId);
  if (error) throw new Error(error.message);

  revalidatePath(`/professor/assignments/${existing.assignment_id}`);
  revalidatePath("/dashboard/assignments");
}

export async function reopenSubmission(submissionId: string) {
  await assertStaff();
  const admin = createAdminClient();
  const { data: existing, error: fetchErr } = await admin
    .from("assignment_submissions")
    .select("assignment_id")
    .eq("id", submissionId)
    .single();
  if (fetchErr) throw new Error(fetchErr.message);
  const { error } = await admin
    .from("assignment_submissions")
    .update({
      status: "submitted",
      grade: null,
      feedback: null,
      graded_by: null,
      graded_at: null,
    })
    .eq("id", submissionId);
  if (error) throw new Error(error.message);
  revalidatePath(`/professor/assignments/${existing.assignment_id}`);
  revalidatePath("/dashboard/assignments");
}
