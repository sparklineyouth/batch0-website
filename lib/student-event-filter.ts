/**
 * Which events a student may see, for service-role reads that RLS does not
 * guard (Discord slash commands). Mirrors the `events read` policy (migration
 * 0098) minus its staff, speaker and ticket clauses, so it can only ever show
 * less than RLS would: for a signed-in caller, public events plus `enrolled`
 * events of a cohort they are enrolled in. `staff` events (rehearsals) never
 * match. Since 0098 `public` means "Everyone signed in", so a caller with no
 * batch0 account (a Discord member who never linked) sees no events at all.
 *
 * Import-free so `node --test` runs it directly.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type CohortIds = readonly (string | null | undefined)[];

/**
 * A PostgREST `.or()` filter for the events a caller may see. Pass the
 * cohorts a signed-in caller is enrolled in, or `null` for a caller with no
 * batch0 account, who gets `null`: no filter, so skip the read. Anything that
 * isn't a UUID is dropped, so the string can never be bent into a wider
 * filter.
 */
export function studentEventsOrFilter(cohortIds: CohortIds): string;
export function studentEventsOrFilter(cohortIds: CohortIds | null): string | null;
export function studentEventsOrFilter(cohortIds: CohortIds | null): string | null {
  if (cohortIds === null) return null;
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
