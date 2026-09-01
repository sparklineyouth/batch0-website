/**
 * Helpers for the ISO-week convention we use throughout check-ins.
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

/**
 * The last `n` ISO weeks, oldest → newest, keyed by Monday.
 *
 * This lived as a private function inside app/admin/pulse/page.tsx until the
 * installed app needed to bucket by week too. Two copies of "where does a week
 * start" is the one duplication this file exists to prevent — Pulse and the
 * phone must never disagree about which Monday a check-in belongs to.
 *
 * `start`/`end` are half-open (`end` is the NEXT Monday), which is what a
 * `.gte(start).lt(end)` range query wants. `label` is month/day with no year:
 * these are axis ticks on an 8-to-12 week window, where the year is noise.
 */
export function lastNWeeks(
  n: number,
): { key: string; label: string; start: Date; end: Date }[] {
  const out: { key: string; label: string; start: Date; end: Date }[] = [];
  const thisMonday = mondayOf(new Date());
  for (let i = n - 1; i >= 0; i--) {
    const start = new Date(thisMonday);
    start.setUTCDate(start.getUTCDate() - i * 7);
    const end = new Date(start);
    end.setUTCDate(end.getUTCDate() + 7);
    out.push({
      key: start.toISOString().slice(0, 10),
      label: start.toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        timeZone: "UTC",
      }),
      start,
      end,
    });
  }
  return out;
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
