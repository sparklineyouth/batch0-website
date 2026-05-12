import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Cohort-isolation guard for mentors. Admins always pass. A mentor
 * passes only if they share a cohort with the student — either because
 * they have a direct mentor_assignments row for that student, OR because
 * the student is enrolled in the same cohort the mentor is teaching
 * (mentor_cohorts).
 *
 * Without this guard, any mentor can grade any student (P0 #3 in the
 * launch audit).
 */
export async function assertMentorCanAccessStudent(args: {
  callerId: string;
  callerRole: string;
  studentId: string;
}): Promise<void> {
  if (args.callerRole === "admin") return;
  if (args.callerRole !== "mentor") {
    throw new Error("Forbidden");
  }

  const admin = createAdminClient();

  // Direct mentor↔student row trumps everything.
  const { data: direct } = await admin
    .from("mentor_assignments")
    .select("id")
    .eq("mentor_id", args.callerId)
    .eq("student_id", args.studentId)
    .limit(1)
    .maybeSingle();
  if (direct) return;

  // Fallback: same cohort. If the mentor doesn't have any assignment to
  // this student specifically but they share a cohort, allow it. This is
  // the common case — a cohort-wide mentor with no per-student matching.
  const { data: enrollment } = await admin
    .from("enrollments")
    .select("cohort_id")
    .eq("user_id", args.studentId)
    .limit(1)
    .maybeSingle();
  if (!enrollment?.cohort_id) {
    throw new Error("Student has no active cohort.");
  }
  // Does the mentor have ANY mentor_assignments in this cohort?
  const { data: cohortPresence } = await admin
    .from("mentor_assignments")
    .select("id")
    .eq("mentor_id", args.callerId)
    .eq("cohort_id", enrollment.cohort_id)
    .limit(1)
    .maybeSingle();
  if (cohortPresence) return;

  throw new Error(
    "You aren't assigned to this student's cohort.",
  );
}
