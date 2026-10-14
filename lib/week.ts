/**
 * ISO-week helpers (UTC Monday keys).
 * `week_start` is always the Monday of that week, stored as YYYY-MM-DD.
 */

export function mondayOf(date: Date): Date {
  const d = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
  const dow = d.getUTCDay(); // 0 = Sun, 1 = Mon, ...
  const diff = dow === 0 ? -6 : 1 - dow; // shift to Monday
  d.setUTCDate(d.getUTCDate() + diff);
  return d;
}

export function isoWeekStart(date: Date = new Date()): string {
  return mondayOf(date).toISOString().slice(0, 10);
}

export function formatWeekRange(weekStartISO: string): string {
  const start = new Date(`${weekStartISO}T00:00:00Z`);
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 6);
  const opts: Intl.DateTimeFormatOptions = {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  };
  const startStr = start.toLocaleDateString("en-US", opts);
  const endStr = end.toLocaleDateString("en-US", {
    ...opts,
    year: "numeric",
  });
  return `${startStr} – ${endStr}`;
}
