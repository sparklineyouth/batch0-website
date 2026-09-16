import { createAdminClient } from "@/lib/supabase/admin";
import { can, type Capabilities } from "@/lib/permissions";

/**
 * Cohort-isolation guard for mentors. A caller passes only if they share a
 * cohort with the student — either because they have a direct
 * mentor_assignments row for that student, OR because they hold an assignment
 * carrying one of the cohorts the student is enrolled in.
 *
 * Without this guard, any mentor can grade any student (P0 #3 in the
 * launch audit).
 *
 * Pass `caps` wherever the caller has them resolved. /mentor is gated on
 * `mentor.panel`, so a custom role an admin granted that permission at
 * /admin/roles reaches these pages — and its slug is neither "mentor" nor
 * "admin", so the slug-only path below denies it outright. `callerRole` stays
 * accepted for the call sites that still resolve a slug only.
 */
export async function assertMentorCanAccessStudent(args: {
  callerId: string;
  callerRole?: string;
  caps?: Capabilities | null;
  studentId: string;
}): Promise<void> {
  if (args.caps) {
    // The wildcard only, not canAccessAdmin(): whether an admin-area viewer
    // gets the program-wide view is the call site's decision (they skip this
    // guard entirely), and a permission like `people.view` says nothing about
    // which cohorts its holder mentors.
    if (args.caps.superAdmin) return;
    if (!can(args.caps, "mentor.panel")) throw new Error("Forbidden");
  } else {
    if (args.callerRole === "admin") return;
    if (args.callerRole !== "mentor") {
      throw new Error("Forbidden");
    }
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
  //
  // Every cohort, not one row: `enrollments` is unique(user_id, cohort_id), so
  // a student can hold rows in two cohorts and reading one arbitrary row with
  // no ORDER BY picked between them at random. The listings match per
  // enrollment row, so that mismatch showed a student on /mentor/students
  // whose detail page then 404'd.
  const { data: enrollments } = await admin
    .from("enrollments")
    .select("cohort_id")
    .eq("user_id", args.studentId);
  const studentCohortIds = [
    ...new Set(
      (enrollments ?? [])
        .map((e) => e.cohort_id as string | null)
        .filter((id): id is string => !!id),
    ),
  ];
  if (studentCohortIds.length === 0) {
    throw new Error("Student has no active cohort.");
  }
  // Does the mentor have ANY mentor_assignments in one of those cohorts?
  const { data: cohortPresence } = await admin
    .from("mentor_assignments")
    .select("id")
    .eq("mentor_id", args.callerId)
    .in("cohort_id", studentCohortIds)
    .limit(1)
    .maybeSingle();
  if (cohortPresence) return;

  throw new Error(
    "You aren't assigned to this student's cohort.",
  );
}

/** Which cohorts and which individual students one mentor may see. */
export type MentorScope = { cohortIds: string[]; studentIds: string[] };

/**
 * The read side of the rule `assertMentorCanAccessStudent` enforces on writes.
 * The two have to stay together: a listing wider than the guard renders a
 * feedback form the write then refuses, and a guard wider than the listing
 * hides work the mentor is responsible for.
 *
 * Read once per render and applied to both the rows and the cohort pills.
 */
export async function mentorScope(
  admin: ReturnType<typeof createAdminClient>,
  mentorId: string,
): Promise<MentorScope> {
  const { data: assignments } = await admin
    .from("mentor_assignments")
    .select("student_id, cohort_id")
    .eq("mentor_id", mentorId);
  const rows = (assignments ?? []) as any[];
  return {
    cohortIds: [
      ...new Set(
        rows.map((a) => a.cohort_id as string | null).filter((id): id is string => !!id),
      ),
    ],
    studentIds: [...new Set(rows.map((a) => a.student_id as string))],
  };
}

/**
 * The scope as one PostgREST `or()` filter, for a table that carries both
 * `cohort_id` and `user_id` (enrollments, student_checkins). Both halves are
 * needed because an assignment may carry no cohort, and either half can be
 * empty — PostgREST rejects an empty `in.()`, so those are dropped.
 *
 * Null means the mentor is in scope for nobody: there is no filter that says
 * "no rows", so the caller must SKIP the read rather than run it unfiltered.
 */
export function mentorScopeFilter(scope: MentorScope): string | null {
  const halves = [
    scope.cohortIds.length ? `cohort_id.in.(${scope.cohortIds.join(",")})` : null,
    scope.studentIds.length ? `user_id.in.(${scope.studentIds.join(",")})` : null,
  ].filter(Boolean);
  return halves.length > 0 ? halves.join(",") : null;
}
