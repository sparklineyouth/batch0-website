// Who may apply again, and to what.
//
// The apply page has always said two different things to two different people:
// a declined applicant is told "you can apply again to a DIFFERENT cohort",
// and someone who withdrew is told "you can reapply to the cohort below". Only
// the copy said it. The server happily let a declined applicant re-submit to
// the exact cohort that had just turned them down, and the picker would even
// preselect it — so the second application was routed straight back to the
// reviewer who had already answered it, and the student got the same no twice.
//
// This module is the rule itself, in one place, so the page's picker, the
// page's copy and the submit action can't drift from each other again. It is
// PURE — no Supabase client, no I/O — which is what makes the cases below
// testable (lib/reapply.test.ts) rather than merely asserted in a comment.
//
// The rules, stated once:
//
//   1. A DECLINE closes that cohort to you. Not batch0 — that cohort. You may
//      apply to any other open cohort, and if none is open there is nothing to
//      apply to yet, which the page has to say out loud rather than rendering
//      an empty picker.
//   2. A WITHDRAWAL closes nothing. You gave the seat up yourself; the cohort
//      you left is still yours to re-enter.
//   3. A FOUNDER PASS reopens everything. A holder who was declined may go
//      straight back at the most upcoming cohort — including the one that
//      declined them — because the pass promises a route back in (the
//      seven-day rebuild is the same promise from the other end), and the
//      whole point of the priority lane is that they don't get parked for a
//      season on a technicality.

/** The application statuses that let a user start a fresh application. */
export const REAPPLY_STATUSES = ["rejected", "withdrawn"] as const;

/**
 * Statuses that close a cohort to the applicant.
 *
 * Only a decline. A withdrawal is the applicant's own choice and reversing it
 * is the behaviour we want; a draft is not an application yet; and everything
 * from `submitted` upward is handled by the lifecycle gate below rather than
 * here, because those users aren't reapplying at all.
 */
const DECLINED_STATUSES = new Set(["rejected"]);

export type OpenCohort = {
  id: string;
  name: string;
  starts_on?: string | null;
};

/** One row of the user's application history. Extra columns are ignored. */
export type ApplicationHistoryRow = {
  status: string | null;
  cohort_id: string | null;
};

/**
 * Where the user stands with the apply form itself, before cohorts enter it.
 *
 *   "new"     — no application on file.
 *   "draft"   — an unsubmitted draft to continue.
 *   "reapply" — a decided-and-finished application; a fresh one may be started.
 *   "locked"  — an application in review or already decided in their favour.
 *               Those move by admin action, not by another self-serve write.
 */
export type ApplyStage = "new" | "draft" | "reapply" | "locked";

export function applyStage(latestStatus: string | null | undefined): ApplyStage {
  if (!latestStatus) return "new";
  if (latestStatus === "draft") return "draft";
  return (REAPPLY_STATUSES as readonly string[]).includes(latestStatus)
    ? "reapply"
    : "locked";
}

export type ReapplyPlan<C extends OpenCohort> = {
  stage: ApplyStage;
  /** Open cohorts this user may target, in the order they were given. */
  allowed: C[];
  /** Open cohorts shut to them because a previous application was declined. */
  blocked: C[];
  /**
   * True when a founder pass is what reopened a cohort that would otherwise be
   * blocked. Drives the "your pass gets you another run at this" copy — and is
   * false when the holder had nothing blocked to begin with, so the page never
   * credits the pass for a door that was already open.
   */
  passReopened: boolean;
};

/**
 * Work out which open cohorts a user may apply to right now.
 *
 * `cohorts` must already be filtered to open (upcoming/active) cohorts and
 * ordered by start date ascending — the caller's query does both — because
 * "the most upcoming cohort" in rule 3 is simply the first element that
 * survives. Sorting here would silently disagree with the order the picker
 * renders.
 *
 * `history` is EVERY application the user has, not just the latest. A student
 * declined from spring, accepted nowhere, and declined again from summer must
 * end up blocked from both — reading only the newest row would quietly reopen
 * the older decline each time they were declined somewhere else.
 */
export function planReapply<C extends OpenCohort>(args: {
  cohorts: C[];
  history: ApplicationHistoryRow[];
  latestStatus: string | null | undefined;
  /** Whether the user holds a live founder pass (any tier, any kind). */
  holdsPass: boolean;
}): ReapplyPlan<C> {
  const { cohorts, history, latestStatus, holdsPass } = args;
  const stage = applyStage(latestStatus);

  const declined = new Set<string>();
  for (const row of history) {
    if (row.cohort_id && DECLINED_STATUSES.has(row.status ?? "")) {
      declined.add(row.cohort_id);
    }
  }

  const wouldBlock = cohorts.filter((c) => declined.has(c.id));

  // Rule 3. Checked against what WOULD have been blocked so `passReopened`
  // means "the pass changed the answer", not merely "they hold one".
  if (holdsPass) {
    return {
      stage,
      allowed: cohorts,
      blocked: [],
      passReopened: wouldBlock.length > 0,
    };
  }

  return {
    stage,
    allowed: cohorts.filter((c) => !declined.has(c.id)),
    blocked: wouldBlock,
    passReopened: false,
  };
}

// ---------------------------------------------------------------------------
// The other half of rule 3: when a decline outranks the pass.
// ---------------------------------------------------------------------------

/** The columns reviewerOverrodePass() reads. Extra ones are ignored. */
export type DecidedApplication = {
  status: string | null;
  reviewed_at?: string | null;
};

/**
 * Has a reviewer declined this person SINCE they redeemed their founder pass?
 *
 * This is the one thing that switches the auto-admit perk off, and it exists
 * because two features that are each correct collide badly without it. A
 * virtual pass admits its holder outright on submit
 * (lib/founder-pass-tiers.ts, grantAutoAdmits). Rule 3 above lets a declined
 * holder go straight back at the cohort that declined them. Composed naively,
 * an admin who deliberately declines a pass holder watches the application
 * reappear as "accepted" seconds later, with no way to make the no stick short
 * of revoking the pass out from under them.
 *
 * The cut is the REDEMPTION TIME, not merely "have they ever been declined":
 *
 *   - Declined in the spring, handed a virtual pass in the summer → the pass
 *     was issued knowing that history, and is the invitation that supersedes
 *     it. The automatic seat stands.
 *   - Holding the pass, applied, declined by a human → that reviewer looked at
 *     this person WITH the pass in hand and still said no. The next
 *     application goes back through the queue, which is what "you can apply
 *     again" has always meant. Their priority lane, feedback and rebuild all
 *     still apply; only the automatic seat does not.
 *
 * Compared as parsed instants, not as strings. The two sides genuinely arrive
 * in different shapes — `reviewed_at` is written by JS as "…T12:00:00.000Z"
 * while PostgREST renders `redeemed_at` as "…T12:00:00+00:00" — and although
 * the fixed-width prefixes happen to sort correctly today, that is a
 * coincidence of formatting, not a property anyone should rely on to decide
 * who gets a seat.
 *
 * Fails CLOSED: a missing or unparseable timestamp counts as an override, so
 * "we couldn't tell when this happened" resolves to "go through review". A
 * seat handed out over a reviewer's explicit objection is unrecoverable; an
 * unnecessary trip through the queue costs a wait.
 */
export function reviewerOverrodePass(
  history: DecidedApplication[],
  redeemedAt: string | null,
): boolean {
  const redeemed = redeemedAt ? Date.parse(redeemedAt) : NaN;
  if (Number.isNaN(redeemed)) return true;
  return history.some((r) => {
    if (r.status !== "rejected") return false;
    if (!r.reviewed_at) return false;
    const decided = Date.parse(r.reviewed_at);
    return Number.isNaN(decided) || decided > redeemed;
  });
}

/**
 * The cohort the form should target: the user's explicit pick if it's still
 * allowed, then their existing draft's cohort, then the admin-pinned one, then
 * the most upcoming allowed cohort.
 *
 * Every candidate is looked up in `allowed` rather than in the full list, which
 * is the whole point: the old chain ended at `cohorts[0]`, so a student
 * declined from the soonest cohort landed on it by default and had to notice
 * the problem themselves.
 */
export function selectCohortId<C extends OpenCohort>(
  allowed: C[],
  preferences: Array<string | null | undefined>,
): string | null {
  for (const pref of preferences) {
    if (!pref) continue;
    const hit = allowed.find((c) => c.id === pref);
    if (hit) return hit.id;
  }
  return allowed[0]?.id ?? null;
}
