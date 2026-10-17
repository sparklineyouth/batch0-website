/**
 * What `admin_move_student_cohort()` (supabase/migrations/0103) says, turned
 * into what moveToCohort shows the admin. Pure, so `node --test` runs it as-is.
 *
 * The function does the whole move in one transaction and answers in one of
 * two ways: a jsonb result (a move, or a refusal decided before any write), or
 * an exception from a write that failed, which rolled every write back. Both
 * mean "nothing changed" when they're not a success, and the messages say so,
 * because the old action's worst failure was a half-done move that said
 * "Moved".
 */

export type CohortMoveRefusalCode =
  | "no_profile"
  | "no_cohort"
  | "stale"
  | "nothing_to_move"
  | "same_cohort"
  | "already_enrolled"
  | "application_exists"
  | "award_conflict";

export type CohortMoveResult =
  | {
      ok: true;
      fromCohortId: string | null;
      toCohortId: string;
      applicationId: string | null;
      /** What happened to their access: moved with them, restored, or none to move. */
      enrollment: "moved" | "created" | "none";
      scholarshipApplicationIds: string[];
    }
  | { ok: false; code: CohortMoveRefusalCode | "unknown"; status?: string };

const REFUSALS: ReadonlySet<string> = new Set<CohortMoveRefusalCode>([
  "no_profile",
  "no_cohort",
  "stale",
  "nothing_to_move",
  "same_cohort",
  "already_enrolled",
  "application_exists",
  "award_conflict",
]);

const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

/** The RPC's jsonb, narrowed. Anything unrecognised is a refusal, never a success. */
export function parseCohortMoveResult(raw: unknown): CohortMoveResult {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  if (r.ok === true && str(r.to_cohort_id)) {
    const enrollment = r.enrollment === "moved" || r.enrollment === "created" ? r.enrollment : "none";
    return {
      ok: true,
      fromCohortId: str(r.from_cohort_id),
      toCohortId: str(r.to_cohort_id)!,
      applicationId: str(r.application_id),
      enrollment,
      scholarshipApplicationIds: Array.isArray(r.scholarship_application_ids)
        ? r.scholarship_application_ids.filter((x): x is string => typeof x === "string")
        : [],
    };
  }
  const code = str(r.code);
  return {
    ok: false,
    code: code && REFUSALS.has(code) ? (code as CohortMoveRefusalCode) : "unknown",
    ...(str(r.status) ? { status: str(r.status)! } : {}),
  };
}

/** The admin-facing sentence for a refusal. `cohortName` is the destination. */
export function cohortMoveRefusalMessage(
  result: Extract<CohortMoveResult, { ok: false }>,
  cohortName: string,
): string {
  switch (result.code) {
    case "no_profile":
      return "That account no longer exists.";
    case "no_cohort":
      return "That cohort doesn't exist.";
    case "stale":
      return "Their cohort changed since this page loaded, so nothing was moved. Refresh and try again.";
    case "nothing_to_move":
      return "They aren't enrolled in a cohort and have no application, so there's nothing to move.";
    case "same_cohort":
      return `They're already in ${cohortName}.`;
    case "already_enrolled":
      return `They're already enrolled in ${cohortName} as well, so nothing was moved.`;
    case "application_exists":
      return `They already have ${result.status ? `a ${result.status} application` : "an application"} for ${cohortName}, and a student has one application per cohort. Nothing was moved.`;
    case "award_conflict":
      return `They hold a scholarship award in their current cohort and another in ${cohortName}, and a student holds one award per cohort. Revoke one of the two awards, then move them.`;
    default:
      return "Couldn't move them, so nothing was changed. Try again.";
  }
}

/**
 * A write inside the move failed and the transaction rolled back. The guards
 * that raise (0081's capacity and checkout triggers) already speak plainly;
 * the one-award index doesn't.
 */
export function cohortMoveFailureMessage(message: string, cohortName: string): string {
  if (/scholarship_applications_one_award_idx|duplicate key|unique constraint/i.test(message)) {
    return `They already hold a scholarship award in ${cohortName}, and a student holds one award per cohort. Revoke one of the two awards, then move them.`;
  }
  const reason = message.trim().replace(/\.$/, "") || "the database refused it";
  return `Couldn't move them to ${cohortName}, so nothing was changed: ${reason}.`;
}

/** Until 0103 runs the function doesn't exist; say that rather than half-move. */
export const COHORT_MOVE_NOT_READY =
  "Moving people between cohorts needs database migration 0103 (docs/migrations-2026-10.md). Nothing was changed.";
