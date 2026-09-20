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
