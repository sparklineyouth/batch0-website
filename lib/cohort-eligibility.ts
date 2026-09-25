/** Shared public/apply/checkout admissions rule. Instants are stored with an
 * offset; date-only cohort boundaries are calendar days in New York. */
export type AdmissionCohort = {
  status: string;
  starts_on: string | null;
  ends_on: string | null;
  applications_close_at?: string | null;
  late_entry_until?: string | null;
  catch_up_plan?: string | null;
  capacity?: number;
};

export type CohortEligibility = {
  eligible: boolean;
  mode: "open" | "late_entry" | "closed" | "full";
  reason: string | null;
  deadline: string | null;
};

export function cohortEligibility(
  cohort: AdmissionCohort,
  now = new Date(),
  occupied?: number,
): CohortEligibility {
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(now);
  const closed = (reason: string): CohortEligibility => ({ eligible: false, mode: "closed", reason, deadline: null });
  if (!["upcoming", "active"].includes(cohort.status)) return closed("This cohort is closed.");
  if (cohort.ends_on && today > cohort.ends_on) return closed("This cohort has ended.");
  const started = !!cohort.starts_on && today >= cohort.starts_on;
  const deadline = started ? cohort.late_entry_until : cohort.applications_close_at;
  if (started && (!deadline || !cohort.catch_up_plan?.trim())) {
    return closed("Enrollment has closed. Please choose an upcoming cohort.");
  }
  if (deadline && (!Number.isFinite(Date.parse(deadline)) || now.getTime() > Date.parse(deadline))) {
    return closed("The enrollment deadline has passed. Please choose an upcoming cohort.");
  }
  if (occupied !== undefined && cohort.capacity !== undefined && occupied >= cohort.capacity) {
    return { eligible: false, mode: "full", reason: "This cohort is full. Please choose an upcoming cohort.", deadline: deadline ?? null };
  }
  return { eligible: true, mode: started ? "late_entry" : "open", reason: null, deadline: deadline ?? null };
}

const NEW_YORK = "America/New_York";
const nyCalendar = new Intl.DateTimeFormat("en-US", {
  timeZone: NEW_YORK, year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
});

/**
 * The instant 23:59:59 in New York on a calendar date. Late entry is
 * advertised as running "through <date>", so the stored deadline has to be
 * the end of that Eastern day: storing the admin's date as UTC midnight
 * would expire the window most of a day early for an Eastern audience.
 * Resolved against the offset at that instant, so it stays correct on both
 * sides of a daylight-saving change (see midnight() in lib/revenue-periods).
 */
export function easternEndOfDay(date: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const target = Date.parse(`${date}T23:59:59Z`);
  if (!Number.isFinite(target)) return null;
  let instant = target;
  for (let i = 0; i < 3; i++) {
    const p = Object.fromEntries(
      nyCalendar.formatToParts(new Date(instant)).map(part => [part.type, part.value]),
    );
    const wall = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
    const correction = target - wall;
    if (correction === 0) break;
    instant += correction;
  }
  return new Date(instant).toISOString();
}

/** The New York calendar date an instant falls on — the inverse of
 * easternEndOfDay, used to show a stored deadline in a date input. A value
 * that is already a plain date passes straight through: it is what the admin
 * just typed, and re-parsing it as UTC midnight would display the day before. */
export function easternDateOf(iso: string | null | undefined): string {
  if (!iso) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso;
  if (!Number.isFinite(Date.parse(iso))) return "";
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: NEW_YORK, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date(iso));
}
