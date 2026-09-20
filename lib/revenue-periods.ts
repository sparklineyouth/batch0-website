/** Revenue uses the founder's Eastern calendar; check-in week keys are separate. */
export const REVENUE_TIME_ZONE = "America/New_York";
const calendar = new Intl.DateTimeFormat("en-US", {
  timeZone: REVENUE_TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
});

function parts(date: Date) {
  return Object.fromEntries(calendar.formatToParts(date).map(part => [part.type, part.value]));
}
function calendarDate(date: Date) {
  const p = parts(date);
  return `${p.year}-${p.month}-${p.day}`;
}
function shiftDate(date: string, days: number) {
  const shifted = new Date(`${date}T00:00:00Z`);
  shifted.setUTCDate(shifted.getUTCDate() + days);
  return shifted.toISOString().slice(0, 10);
}
function midnight(date: string): Date {
  const target = Date.parse(`${date}T00:00:00Z`);
  let instant = target;
  // Resolve the wall-clock midnight using the offset at that instant, rather
  // than subtracting fixed 24-hour days across a daylight-saving transition.
  for (let i = 0; i < 3; i++) {
    const p = parts(new Date(instant));
    const wall = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
    const correction = target - wall;
    if (correction === 0) break;
    instant += correction;
  }
  return new Date(instant);
}

export type RevenuePeriod = { start: Date; end: Date };
export function revenuePeriods(now: Date, weekCount = 8) {
  const today = calendarDate(now);
  const current = { start: midnight(shiftDate(today, -6)), end: midnight(shiftDate(today, 1)) };
  const previous = { start: midnight(shiftDate(today, -13)), end: current.start };
  const weekday = new Date(`${today}T00:00:00Z`).getUTCDay();
  const monday = shiftDate(today, weekday === 0 ? -6 : 1 - weekday);
  const weeks = Array.from({ length: weekCount }, (_, i) => {
    const key = shiftDate(monday, -(weekCount - 1 - i) * 7);
    return {
      key,
      label: new Date(`${key}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" }),
      start: midnight(key), end: midnight(shiftDate(key, 7)),
    };
  });
  return { current, previous, weeks };
}

export function revenueInPeriod(rows: { paid_at: string | null; amount_cents: number | null }[], period: RevenuePeriod): number {
  return rows.reduce((sum, row) => {
    if (!row.paid_at) return sum;
    const paid = new Date(row.paid_at);
    return paid >= period.start && paid < period.end ? sum + (row.amount_cents ?? 0) : sum;
  }, 0);
}
