/**
 * Which week of the cohort today is.
 *
 * `modules.week` is a 1-based integer per cohort, and `cohorts.starts_on` is a
 * date with no time or zone. Both are calendar facts, so the arithmetic is done
 * entirely in UTC calendar days: taking `Date.now()` directly would make the
 * answer flip a few hours early or late depending on the reader's timezone, and
 * "which week am I in" changing based on who is asking is exactly the kind of
 * off-by-one that only shows up in the field.
 *
 * Returns null before the cohort starts — the caller decides whether that means
 * "locked" or "counting down", and null is the only value that can't be
 * mistaken for week 0.
 */
export function cohortWeek(
  startsOn: string | null | undefined,
  today: Date = new Date(),
): number | null {
  if (!startsOn) return null;
  const start = Date.parse(`${startsOn}T00:00:00Z`);
  if (Number.isNaN(start)) return null;
  const now = Date.UTC(
    today.getUTCFullYear(),
    today.getUTCMonth(),
    today.getUTCDate(),
  );
  const days = Math.floor((now - start) / 86_400_000);
  if (days < 0) return null;
  return Math.floor(days / 7) + 1;
}
