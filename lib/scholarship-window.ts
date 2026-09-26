// ---------------------------------------------------------------------------
// When a student may apply for a scholarship — decided by THEIR COHORT.
//
// A scholarship used to carry its own opens_at / closes_at. One global window
// cannot fit a program that runs cohort after cohort: the Learner's Scholarship
// closed on Sep 20 while Fall 2026 ran to Nov 13, so every enrolled student was
// told "closed" for the second half of their cohort, and Winter would have
// found it shut unless someone remembered to edit the dates — which would then
// have moved them for everyone. So the window is no longer a property of the
// scholarship at all. It is derived, per student, from the cohort they are in
// and the stage they are at:
//
//   accepted (not yet paid) — open until the cohort's ENROLLMENT DEADLINE, the
//     same instant lib/cohort-eligibility.ts cohortEligibility() hands the
//     checkout. A discount only exists at the till (lib/tuition-quote.ts), and
//     the till refuses payment after that deadline (lib/checkout-service.ts),
//     so an award decided later could never reach the student.
//   enrolled — open until the END of the cohort's last day, Eastern. A paid
//     student's money award is a refund and their perks (mentor calls, Demo Day
//     guest tickets) are spent during the cohort; once it has ended there is
//     nothing left for either to be used on.
//
// The scholarships.opens_at / closes_at columns stay in the table (no
// migration), but nothing reads them and the admin form saves them as null.
//
// Pure, like the rest of the scholarship rules: `now` is always passed in, and
// the only import is ./cohort-eligibility.ts, which is itself import-free. That
// keeps `npm test` able to run this through Node's native type stripping and
// the admin editor able to import it into a client component. The type import
// from ./scholarship-award.ts is erased at runtime, so the two modules can
// reference each other without a runtime cycle.
// ---------------------------------------------------------------------------

import {
  cohortEligibility,
  easternDateOf,
  easternEndOfDay,
  type AdmissionCohort,
} from "./cohort-eligibility.ts";
import type { AwardType, EligibleStage } from "./scholarship-award.ts";

/** A `cohorts` row, as far as a scholarship window needs one. */
export type ScholarshipCohort = AdmissionCohort & {
  id: string;
  name: string | null;
};

/** What the end of an open window is pinned to. */
export type WindowBasis = "enrollment_deadline" | "cohort_end";

export type ScholarshipWindow =
  | {
      open: true;
      /** The last instant it is open (ISO), or null when the cohort has no end on file. */
      until: string | null;
      basis: WindowBasis;
      cohortId: string;
      cohortName: string;
      /** Why it closes when it does, as a phrase: "while Fall 2026 runs". */
      why: string;
    }
  | {
      open: false;
      basis: WindowBasis | "no_cohort";
      cohortId: string | null;
      cohortName: string | null;
      /** Why it's closed, as a sentence the dashboard shows verbatim. */
      reason: string;
    };

export type OpenScholarshipWindow = Extract<ScholarshipWindow, { open: true }>;

export const NO_COHORT_REASON =
  "Scholarships follow your cohort's dates, and you haven't been placed in a cohort yet.";

const NEW_YORK = "America/New_York";

/** Today's calendar date in New York — the calendar every cohort date is written in. */
export function easternToday(now: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: NEW_YORK,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

function cohortLabel(cohort: ScholarshipCohort): string {
  return cohort.name?.trim() || "your cohort";
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function possessive(name: string): string {
  return /s$/i.test(name) ? `${name}'` : `${name}'s`;
}

/** Money off tuition is part of the award (so it lands at checkout, or as a refund). */
function paysMoney(awardType: AwardType | undefined): boolean {
  return awardType === "discount" || awardType === "both";
}

/**
 * Whether the cohort itself is over, whatever the student's stage: the reason
 * as a kind, or null while it is upcoming or running. "Over" means cancelled,
 * marked completed, or past the end of its last Eastern day.
 */
function cohortOver(
  cohort: ScholarshipCohort,
  now: Date,
): "ended" | "cancelled" | "not_running" | null {
  if (cohort.status === "cancelled") return "cancelled";
  if (cohort.status === "completed") return "ended";
  if (cohort.status !== "upcoming" && cohort.status !== "active") return "not_running";
  if (cohort.ends_on && easternToday(now) > cohort.ends_on) return "ended";
  return null;
}

/**
 * Whether a cohort is over (see cohortOver), as a yes/no. Used by the
 * one-at-a-time rule, where an award from a cohort that is over stops
 * blocking, and by the perk readers, which prefer an award whose cohort is
 * not over.
 *
 * No cohort reads as NOT over. A legacy award with no cohort on file has no
 * end, so its perks aren't dropped and it keeps blocking, the conservative
 * reading in both places.
 */
export function cohortIsOver(cohort: ScholarshipCohort | null, now: Date): boolean {
  return !!cohort && cohortOver(cohort, now) !== null;
}

function overSentence(
  kind: "ended" | "cancelled" | "not_running",
  name: string,
): string {
  const Name = capitalize(name);
  if (kind === "cancelled") return `${Name} was cancelled.`;
  if (kind === "not_running") return `${Name} isn't running.`;
  return `${Name} has ended.`;
}

/** The calendar day before a YYYY-MM-DD date. */
function dayBefore(date: string): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) - 86_400_000)
    .toISOString()
    .slice(0, 10);
}

/**
 * The enrollment deadline when cohortEligibility() has none to report — which
 * it only does before the start, with no applications_close_at on file. Then
 * enrollment runs until the cohort starts, and on past it only if late entry
 * is configured (a late_entry_until AND a catch-up plan, the same pair
 * cohortEligibility requires once the cohort is underway).
 */
function implicitEnrollmentDeadline(cohort: ScholarshipCohort): string | null {
  if (
    cohort.late_entry_until &&
    Number.isFinite(Date.parse(cohort.late_entry_until)) &&
    cohort.catch_up_plan?.trim()
  ) {
    return cohort.late_entry_until;
  }
  if (cohort.starts_on && /^\d{4}-\d{2}-\d{2}$/.test(cohort.starts_on)) {
    return easternEndOfDay(dayBefore(cohort.starts_on));
  }
  return null;
}

/**
 * The window a student at `stage` in `cohort` has to apply for a scholarship
 * paying out `awardType`, as of `now`.
 *
 * `awardType` only shapes the wording — the dates are the same for money and
 * perks. It's optional so a caller with no particular scholarship in mind (the
 * admin list) can still ask.
 */
export function scholarshipWindow(
  input: {
    cohort: ScholarshipCohort | null;
    stage: EligibleStage;
    awardType?: AwardType;
  },
  now: Date,
): ScholarshipWindow {
  const { cohort, stage } = input;
  const basis: WindowBasis = stage === "accepted" ? "enrollment_deadline" : "cohort_end";
  if (!cohort) {
    return {
      open: false,
      basis: "no_cohort",
      cohortId: null,
      cohortName: null,
      reason: NO_COHORT_REASON,
    };
  }
  const name = cohortLabel(cohort);
  const money = paysMoney(input.awardType);

  const over = cohortOver(cohort, now);
  if (over) {
    return {
      open: false,
      basis,
      cohortId: cohort.id,
      cohortName: name,
      reason: overSentence(over, name),
    };
  }

  if (stage === "enrolled") {
    return {
      open: true,
      until: cohort.ends_on ? easternEndOfDay(cohort.ends_on) : null,
      basis,
      cohortId: cohort.id,
      cohortName: name,
      why: `while ${name} runs`,
    };
  }

  // Accepted: exactly the rule the checkout enforces. No occupancy is passed —
  // an accepted student already holds their place, so a full cohort is not a
  // reason to stop them applying.
  const admission = cohortEligibility(cohort, now);
  if (!admission.eligible) {
    return {
      open: false,
      basis,
      cohortId: cohort.id,
      cohortName: name,
      reason: money
        ? `Enrollment in ${name} has closed, so there's no checkout left for the award to come off.`
        : `Enrollment in ${name} has closed.`,
    };
  }
  return {
    open: true,
    until: admission.deadline ?? implicitEnrollmentDeadline(cohort),
    basis,
    cohortId: cohort.id,
    cohortName: name,
    why: money
      ? `${possessive(name)} enrollment deadline, since the award comes off your tuition at checkout`
      : `${possessive(name)} enrollment deadline`,
  };
}

// ---------------------------------------------------------------------------
// Which cohort a student's window follows
// ---------------------------------------------------------------------------

/** A cohort a student is tied to, and the stage they're at in it. */
export type CohortCandidate = {
  cohort: ScholarshipCohort;
  stage: EligibleStage;
  /** The batch0 application behind it, when known. */
  applicationId: string | null;
};

function cohortStarted(cohort: ScholarshipCohort, today: string): boolean {
  if (cohort.status === "active" || cohort.status === "completed") return true;
  return !!cohort.starts_on && cohort.starts_on <= today;
}

function startKey(c: CohortCandidate): string {
  return c.cohort.starts_on ?? "9999-12-31";
}

/**
 * The one cohort — and so the one stage — a student's scholarship window
 * follows, from every cohort they're tied to: each enrollment (stage
 * "enrolled") plus their latest application's cohort when it is accepted
 * (stage "accepted") or already paid.
 *
 * The same rule lib/access.ts getStudentAccess uses for `cohortId`: the
 * soonest cohort that hasn't started yet, otherwise the most recently started
 * one. That is what stops an old, finished enrollment from speaking for a
 * student who has since been accepted into a later cohort — and an unordered
 * `.limit(1)` enrollment read from picking whichever row came back first.
 *
 * A cohort listed twice resolves to the enrolled entry (paying is the later
 * step). Cancelled cohorts are passed over while any other cohort remains.
 */
export function resolveScholarshipCohort(
  candidates: readonly CohortCandidate[],
  now: Date,
): CohortCandidate | null {
  const byId = new Map<string, CohortCandidate>();
  for (const c of candidates) {
    const prev = byId.get(c.cohort.id);
    if (!prev) {
      byId.set(c.cohort.id, c);
    } else if (prev.stage === "accepted" && c.stage === "enrolled") {
      byId.set(c.cohort.id, { ...c, applicationId: c.applicationId ?? prev.applicationId });
    }
  }
  const all = [...byId.values()];
  const live = all.filter((c) => c.cohort.status !== "cancelled");
  const pool = live.length ? live : all;
  if (pool.length === 0) return null;

  const today = easternToday(now);
  const upcoming = pool
    .filter((c) => !cohortStarted(c.cohort, today))
    .sort((a, b) => (startKey(a) < startKey(b) ? -1 : startKey(a) > startKey(b) ? 1 : 0))[0];
  if (upcoming) return upcoming;
  return (
    pool
      .filter((c) => cohortStarted(c.cohort, today))
      .sort((a, b) => (startKey(a) > startKey(b) ? -1 : startKey(a) < startKey(b) ? 1 : 0))[0] ??
    null
  );
}

// ---------------------------------------------------------------------------
// Scholarship-funded 1:1 mentor calls
// ---------------------------------------------------------------------------

export type CallWindow =
  | { open: true; until: string | null; cohortName: string | null }
  | { open: false; reason: string };

/**
 * When a scholarship-funded mentor call can happen: during the cohort the
 * AWARD belongs to, up to the end of its last Eastern day. The perk is extra
 * mentor time for the program, so a call proposed for after the cohort has
 * ended — or asked for once it has — is a call with nothing to work on.
 *
 * An award with no cohort on file (a legacy row) is left unbounded rather
 * than refused: the team confirms every call time by hand, and a student
 * holding real credits must not be locked out by a missing column value.
 * Callers fall back to the student's current cohort before landing here.
 */
export function scholarshipCallWindow(
  cohort: ScholarshipCohort | null,
  now: Date,
): CallWindow {
  if (!cohort) return { open: true, until: null, cohortName: null };
  const name = cohortLabel(cohort);
  const over = cohortOver(cohort, now);
  if (over) {
    return {
      open: false,
      reason:
        over === "cancelled"
          ? `Your scholarship calls were for ${name}, which was cancelled.`
          : `Your scholarship calls were for ${name}, which has ended.`,
    };
  }
  return {
    open: true,
    until: cohort.ends_on ? easternEndOfDay(cohort.ends_on) : null,
    cohortName: name,
  };
}

/**
 * Why a proposed call time can't be used, or null when it can. Only checks
 * the cohort bound; "is it in the future" stays with the caller, which owns
 * the clock.
 */
export function callTimeProblem(
  at: Date,
  window: CallWindow,
  which: "preferred" | "backup" = "preferred",
): string | null {
  if (!window.open) return window.reason;
  if (window.until && at.getTime() > Date.parse(window.until)) {
    const what = which === "preferred" ? "a time" : "a backup time";
    return `Pick ${what} on or before ${windowUntilLabel(window.until)} — scholarship calls happen during ${window.cohortName ?? "your cohort"}.`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Wording
// ---------------------------------------------------------------------------

/**
 * The end of a window as people read it, in Eastern time like every other
 * cohort date: "Nov 13" when it ends at the close of an Eastern day (every
 * cohort end does, and so does a late-entry deadline set from the admin date
 * picker), otherwise the exact moment — "Dec 12, 6:59 PM EST" — so a deadline
 * someone typed as a time is not rounded into a promise of the whole day.
 */
export function windowUntilLabel(until: string | null | undefined): string {
  if (!until || !Number.isFinite(Date.parse(until))) return "";
  const day = easternDateOf(until);
  const endOfDay = easternEndOfDay(day);
  const at = new Date(until);
  if (endOfDay && Math.abs(Date.parse(endOfDay) - at.getTime()) < 1000) {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: NEW_YORK,
      month: "short",
      day: "numeric",
    }).format(at);
  }
  return new Intl.DateTimeFormat("en-US", {
    timeZone: NEW_YORK,
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(at);
}

/**
 * One line for a card: "Open until Nov 13 — while Fall 2026 runs", or the
 * closed reason. Every surface prints from this so they can't word the same
 * window two ways.
 */
export function windowHeadline(window: ScholarshipWindow): string {
  if (!window.open) return window.reason;
  return window.until
    ? `Open until ${windowUntilLabel(window.until)} — ${window.why}`
    : `Open — ${window.why}`;
}

const STAGE_AUDIENCE: Record<EligibleStage, string> = {
  accepted: "accepted students",
  enrolled: "enrolled students",
};

/**
 * What one cohort's windows look like for a scholarship open to `stages`, for
 * the admin list: "accepted students until Sep 30 · enrolled students until
 * Nov 13". A stage whose window has closed says so rather than disappearing,
 * so the admin can see why nobody at that stage is applying.
 */
export function describeCohortWindows(
  input: {
    cohort: ScholarshipCohort;
    stages: readonly EligibleStage[];
    awardType?: AwardType;
  },
  now: Date,
): string {
  const order: EligibleStage[] = ["accepted", "enrolled"];
  return order
    .filter((stage) => input.stages.includes(stage))
    .map((stage) => {
      const w = scholarshipWindow(
        { cohort: input.cohort, stage, awardType: input.awardType },
        now,
      );
      const who = STAGE_AUDIENCE[stage];
      if (!w.open) return `${who} closed`;
      return w.until ? `${who} until ${windowUntilLabel(w.until)}` : `${who}, no end date`;
    })
    .join(" · ");
}
