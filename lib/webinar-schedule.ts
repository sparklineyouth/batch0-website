/**
 * When webinars happen, and what they are called.
 *
 * batch0 webinars run on Sundays — one a week, on the Sunday that closes each
 * cohort week. The scheduler used to offer a free datetime picker, which is
 * how the calendar ended up with hosted sessions scattered across weekdays,
 * each named whatever was typed in the moment. This module is the single
 * place that knows the rule, so the form that offers dates, the check that
 * refuses a wrong one, and the name a webinar gets can't drift apart.
 *
 * Everything here works in *local calendar days* of whoever is scheduling:
 * an admin picks "Sunday" in their own timezone, and that is the Sunday the
 * webinar lands on. Import-free on purpose, like lib/apply-window.ts, so it
 * carries a test that runs with `npm test` and no transpile step.
 */

const DAY_MS = 86_400_000;

/** `YYYY-MM-DD` in the local calendar of `d`. */
export function localYmd(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** The local-time `Date` for a `YYYY-MM-DD` at midnight. */
function localMidnight(ymd: string): Date {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(y, m - 1, d);
}

/** Is this instant a Sunday, in local time? */
export function isSunday(d: Date): boolean {
  return d.getDay() === 0;
}

/**
 * The next `count` Sundays on or after `from`'s local date, as `YYYY-MM-DD`.
 *
 * "On or after" so that scheduling on a Sunday morning still offers today —
 * the time field decides whether that's still useful. Never returns a Sunday
 * before `from`: the form must not be able to default to a date that's gone.
 */
export function upcomingSundays(from: Date, count: number): string[] {
  const start = localMidnight(localYmd(from));
  const ahead = (7 - start.getDay()) % 7;
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    const d = new Date(start);
    d.setDate(start.getDate() + ahead + 7 * i);
    out.push(localYmd(d));
  }
  return out;
}

/**
 * Which cohort week a Sunday belongs to, or null if it's before the cohort
 * starts (or the start is unknown).
 *
 * Same arithmetic as lib/cohort-week.ts — calendar days from `starts_on`,
 * divided by seven, one-based — so a webinar's week number agrees with the
 * week the course page shows. With a cohort starting Monday Sep 14, the
 * Sunday that follows (Sep 20) is week 1, Sep 27 is week 2, and so on.
 */
export function webinarWeek(
  sundayYmd: string,
  cohortStartsOn: string | null | undefined,
): number | null {
  if (!cohortStartsOn) return null;
  const start = Date.parse(`${cohortStartsOn}T00:00:00Z`);
  const sunday = Date.parse(`${sundayYmd}T00:00:00Z`);
  if (Number.isNaN(start) || Number.isNaN(sunday)) return null;
  const days = Math.floor((sunday - start) / DAY_MS);
  if (days < 0) return null;
  return Math.floor(days / 7) + 1;
}

/**
 * The name a webinar gets: "Week 3 Webinar", or — when there is no cohort
 * week to hang it on — "Sunday Webinar · Oct 4".
 */
export function webinarTitle(sundayYmd: string, week: number | null): string {
  if (week !== null) return `Week ${week} Webinar`;
  const d = localMidnight(sundayYmd);
  const label = d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  return `Sunday Webinar · ${label}`;
}

/** Combine a `YYYY-MM-DD` and `HH:MM` into a local `Date`. */
export function localDateTime(ymd: string, hhmm: string): Date {
  const [h, m] = hhmm.split(":").map(Number);
  const d = localMidnight(ymd);
  d.setHours(h, m, 0, 0);
  return d;
}

/** `HH:MM` local time of an instant — the "same time as last week" default. */
export function localHhmm(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
