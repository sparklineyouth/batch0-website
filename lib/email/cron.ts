/**
 * A five-field cron matcher, evaluated in UTC.
 *
 * Scheduled automations don't each get their own Vercel cron entry — one
 * drain job runs every few minutes and asks each enabled automation "were you
 * due since you last ran?". That keeps adding an automation a database write
 * instead of an infrastructure change, which is the difference between an
 * admin building a drip themselves and filing a ticket.
 *
 * Supported per field: `*`, a number, `a-b` ranges, `a,b,c` lists, and step
 * syntax (a slash followed by an interval, as in every-15-minutes). Names (`MON`, `JAN`) are accepted for the weekday and
 * month fields. Deliberately no `@daily`-style macros, no `L`/`W`/`#` — an
 * expression an admin can't read back off the screen is worse than one they
 * have to write out.
 *
 * Import-free so `npm test` can run it directly.
 */

export type CronField = { min: number; max: number; names?: string[] };

const FIELDS: CronField[] = [
  { min: 0, max: 59 }, // minute
  { min: 0, max: 23 }, // hour
  { min: 1, max: 31 }, // day of month
  {
    min: 1,
    max: 12,
    names: ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"],
  },
  { min: 0, max: 6, names: ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] },
];

export type ParsedCron = [Set<number>, Set<number>, Set<number>, Set<number>, Set<number>];

export class CronParseError extends Error {}

function parseField(raw: string, field: CronField, index: number): Set<number> {
  const out = new Set<number>();
  for (const part of raw.split(",")) {
    const piece = part.trim().toLowerCase();
    if (piece === "") throw new CronParseError(`Empty value in field ${index + 1}`);
    const [rangePart, stepPart] = piece.split("/");
    let step = 1;
    if (stepPart !== undefined) {
      step = Number(stepPart);
      if (!Number.isInteger(step) || step < 1) {
        throw new CronParseError(`Bad step "/${stepPart}" in field ${index + 1}`);
      }
    }
    let lo: number;
    let hi: number;
    if (rangePart === "*") {
      lo = field.min;
      hi = field.max;
    } else if (rangePart.includes("-")) {
      const [a, b] = rangePart.split("-");
      lo = toNumber(a, field, index);
      hi = toNumber(b, field, index);
      if (lo > hi) throw new CronParseError(`Reversed range "${rangePart}" in field ${index + 1}`);
    } else {
      lo = hi = toNumber(rangePart, field, index);
    }
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out;
}

function toNumber(token: string, field: CronField, index: number): number {
  const t = token.trim().toLowerCase();
  if (field.names) {
    const named = field.names.indexOf(t);
    if (named >= 0) return named + field.min;
  }
  const n = Number(t);
  if (!Number.isInteger(n)) {
    throw new CronParseError(`"${token}" isn't a number in field ${index + 1}`);
  }
  // Cron traditionally accepts 7 for Sunday as well as 0.
  if (index === 4 && n === 7) return 0;
  if (n < field.min || n > field.max) {
    throw new CronParseError(
      `"${token}" is outside ${field.min}-${field.max} in field ${index + 1}`,
    );
  }
  return n;
}

export function parseCron(expr: string): ParsedCron {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new CronParseError(
      `Expected 5 fields (minute hour day month weekday), got ${parts.length}`,
    );
  }
  return parts.map((p, i) => parseField(p, FIELDS[i], i)) as ParsedCron;
}

/** Null when it parses, the reason when it doesn't. For inline form errors. */
export function cronError(expr: string): string | null {
  try {
    parseCron(expr);
    return null;
  } catch (err: any) {
    return err?.message ?? "Invalid schedule";
  }
}

/**
 * Does `date` (UTC) satisfy the expression?
 *
 * Day-of-month and weekday are OR'd when both are restricted, which is the
 * historical Vixie-cron behaviour. It surprises people, so it's worth being
 * explicit: `0 9 1 * MON` fires on the 1st *and* on every Monday, not on
 * Mondays that fall on the 1st.
 */
export function cronMatches(parsed: ParsedCron, date: Date): boolean {
  const [min, hour, dom, month, dow] = parsed;
  if (!min.has(date.getUTCMinutes())) return false;
  if (!hour.has(date.getUTCHours())) return false;
  if (!month.has(date.getUTCMonth() + 1)) return false;

  const domRestricted = dom.size < 31;
  const dowRestricted = dow.size < 7;
  const domHit = dom.has(date.getUTCDate());
  const dowHit = dow.has(date.getUTCDay());
  if (domRestricted && dowRestricted) return domHit || dowHit;
  if (domRestricted) return domHit;
  if (dowRestricted) return dowHit;
  return true;
}

/**
 * Was this schedule due at some point in `(after, now]`?
 *
 * The drainer runs every few minutes, not every minute, so asking "does it
 * match right now?" would silently skip most fires. This walks the minutes
 * since the last run instead. Capped at a day of catch-up: an automation that
 * has been paused for a week should resume, not send seven days of backlog
 * the moment it's re-enabled.
 */
export function wasDue(
  parsed: ParsedCron,
  after: Date | null,
  now: Date,
  maxCatchUpMinutes = 60 * 24,
): boolean {
  const end = Math.floor(now.getTime() / 60000);
  const startFrom = after ? Math.floor(after.getTime() / 60000) + 1 : end;
  const start = Math.max(startFrom, end - maxCatchUpMinutes);
  for (let m = start; m <= end; m++) {
    if (cronMatches(parsed, new Date(m * 60000))) return true;
  }
  return false;
}

/** Next fire at or after `from`, or null if nothing in the next four years. */
export function nextRun(parsed: ParsedCron, from: Date): Date | null {
  const start = Math.floor(from.getTime() / 60000) + 1;
  const limit = 60 * 24 * 366 * 4;
  for (let i = 0; i < limit; i++) {
    const d = new Date((start + i) * 60000);
    if (cronMatches(parsed, d)) return d;
  }
  return null;
}

/**
 * Common schedules, offered as a dropdown so most admins never type cron.
 *
 * Nothing finer than the queue drain (every five minutes) is offered: a
 * schedule the drain can't honour would fire late and quietly mean something
 * other than what it says.
 */
export const CRON_PRESETS = [
  { value: "0 14 * * 1", label: "Weekly — Mondays at 14:00 UTC" },
  { value: "0 14 * * 5", label: "Weekly — Fridays at 14:00 UTC" },
  { value: "0 13 * * *", label: "Daily at 13:00 UTC" },
  { value: "0 9 * * 1-5", label: "Weekdays at 09:00 UTC" },
  { value: "0 13 1 * *", label: "Monthly — 1st at 13:00 UTC" },
  { value: "0 * * * *", label: "Hourly, on the hour" },
  { value: "*/30 * * * *", label: "Every 30 minutes" },
] as const;

/** Best-effort English for the automations list. Falls back to the raw expr. */
export function describeCron(expr: string): string {
  const preset = CRON_PRESETS.find((p) => p.value === expr.trim());
  if (preset) return preset.label;
  return `cron: ${expr.trim()} (UTC)`;
}
