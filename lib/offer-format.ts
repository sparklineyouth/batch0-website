/** Exact tuition display: never round a different charge into a promise. */
export function formatUsd(cents: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency", currency: "USD",
    minimumFractionDigits: cents % 100 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(cents / 100);
}

export function easternDeadline(iso: string | null | undefined): string {
  if (!iso || !Number.isFinite(Date.parse(iso))) return "";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", month: "short", day: "numeric",
    hour: "numeric", minute: "2-digit", timeZoneName: "short",
  }).format(new Date(iso));
}

export type PublicSession = {
  id: string;
  title: string;
  type: string;
  starts_at: string;
  ends_at: string | null;
};

/** Only publish a timetable inside the cohort's actual calendar window. */
export function visibleSchedule(
  rows: PublicSession[], startsOn: string | null, endsOn: string | null,
): PublicSession[] {
  if (!startsOn || !endsOn) return [];
  const localDate = (iso: string) => new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date(iso));
  return rows.filter(row => {
    if (!Number.isFinite(Date.parse(row.starts_at))) return false;
    const date = localDate(row.starts_at);
    return date >= startsOn && date <= endsOn;
  }).sort((a, b) => Date.parse(a.starts_at) - Date.parse(b.starts_at));
}

export function sessionTime(session: PublicSession): string {
  const start = new Date(session.starts_at);
  const date = start.toLocaleDateString("en-US", {
    timeZone: "America/New_York", weekday: "short", month: "short", day: "numeric",
  });
  const time = (value: Date) => value.toLocaleTimeString("en-US", {
    timeZone: "America/New_York", hour: "numeric", minute: "2-digit",
  });
  const zone = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", timeZoneName: "short",
  }).formatToParts(start).find(part => part.type === "timeZoneName")?.value ?? "Eastern";
  const end = session.ends_at && Number.isFinite(Date.parse(session.ends_at))
    ? `–${time(new Date(session.ends_at))}` : "";
  return `${date} · ${time(start)}${end} ${zone}`;
}
