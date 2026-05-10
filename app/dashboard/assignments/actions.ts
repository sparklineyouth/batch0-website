"use server";
import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { assertSelf } from "@/lib/server-guards";
import { createClient } from "@/lib/supabase/server";

export type SubmissionInput = {
  assignmentId: string;
  content: string;
  links: { title: string; url: string }[];
  files: { name: string; path: string }[];
  submit: boolean; // false = save draft; true = submit for grading
};

export async function saveSubmission(input: SubmissionInput) {
  const { userId } = await assertSelf();
  const supabase = createClient();

  // Verify the user is enrolled in the assignment's cohort.
  const { data: assignment } = await supabase
    .from("assignments")
    .select("id, cohort_id")
    .eq("id", input.assignmentId)
    .maybeSingle();
  if (!assignment) throw new Error("Assignment not found");
  const { data: enrollment } = await supabase
    .from("enrollments")
    .select("id")
    .eq("user_id", userId)
    .eq("cohort_id", assignment.cohort_id)
    .maybeSingle();
  if (!enrollment) throw new Error("Not enrolled in this cohort");

  // Validate URL fields.
  for (const l of input.links) {
    if (l.url && !/^https?:\/\/.+/.test(l.url)) {
      throw new Error(`Link "${l.title || l.url}" must be a full URL`);
    }
  }

  const admin = createAdminClient();
  const { data: existing } = await admin
    .from("assignment_submissions")
    .select("id, status")
    .eq("assignment_id", input.assignmentId)
    .eq("user_id", userId)
    .maybeSingle();

  if (existing?.status === "graded") {
    throw new Error("This assignment has already been graded.");
  }

  const status = input.submit ? "submitted" : "draft";
  const payload = {
    assignment_id: input.assignmentId,
    user_id: userId,
    content: input.content || null,
    links: input.links.filter((l) => l.url.trim()),
    files: input.files,
    status,
    submitted_at: input.submit ? new Date().toISOString() : null,
  };

  if (existing) {
    const { error } = await admin
      .from("assignment_submissions")
      .update(payload)
      .eq("id", existing.id);
    if (error) throw new Error(error.message);
  } else {
    const { error } = await admin
      .from("assignment_submissions")
      .insert(payload);
    if (error) throw new Error(error.message);
  }

  revalidatePath("/dashboard/assignments");
  revalidatePath(`/dashboard/assignments/${input.assignmentId}`);
  revalidatePath(`/mentor/assignments/${input.assignmentId}`);
}
