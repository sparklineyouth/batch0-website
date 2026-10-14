/**
 * Which events a student may see, for service-role reads that RLS does not
 * guard (Discord slash commands, cohort emails). Mirrors the `events read`
 * policy (migration 0084) minus its staff, speaker and ticket clauses, so it
 * can only ever show less than RLS would: public events, plus `enrolled`
 * events of a cohort the student is enrolled in. `staff` events (rehearsals)
 * never match.
 *
 * Import-free so `node --test` runs it directly.
 */

export const STUDENT_EVENT_VISIBILITIES = ["public", "enrolled"] as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A PostgREST `.or()` filter for the events a student enrolled in
 * `cohortIds` may see. Anything that isn't a UUID is dropped, so the string
 * can never be bent into a wider filter.
 */
export function studentEventsOrFilter(
  cohortIds: readonly (string | null | undefined)[],
): string {
  const ids = [
    ...new Set(
      cohortIds.filter(
        (id): id is string => typeof id === "string" && UUID.test(id),
      ),
    ),
  ];
  if (ids.length === 0) return "visibility.eq.public";
  return `visibility.eq.public,and(visibility.eq.enrolled,cohort_id.in.(${ids.join(",")}))`;
}
