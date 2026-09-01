import type { ApplicationStatus } from "./types.ts";

/**
 * Who is allowed into the installed app at /app.
 *
 * Kept in its own import-free module, the same way lib/pre-cohort.ts is, for
 * two reasons. It is an access rule, so it gets a test — and a test can only
 * import this if nothing in the graph reaches next/headers or a Supabase
 * client, which lib/access.ts does. And an access rule with exactly one
 * definition cannot drift between the layout that renders the gate and any
 * future caller that needs the same answer.
 */

/**
 * Application states that earn a place in the app.
 *
 * The line is "are you actually in the funnel": you submitted something and it
 * hasn't been closed out. Waitlisted is included deliberately — a waitlisted
 * applicant is explicitly told they're first in line if a seat opens, so they
 * are still live and the app has real news for them.
 *
 * Excluded, and why:
 *   - no application at all — someone who made an account and stopped. There is
 *     nothing in the app for them; /apply is the page they want.
 *   - "draft" — started, never submitted. Same reasoning: the thing to do is
 *     finish applying, and /apply does that far better than a phone shell.
 *   - "rejected" / "withdrawn" — closed. An app that renders four empty tabs is
 *     a worse answer than an honest sentence.
 */
export const APP_ELIGIBLE_STATUSES: ReadonlySet<ApplicationStatus> = new Set([
  "submitted",
  "waitlisted",
  "accepted",
  "paid",
  "enrolled",
]);

export type AppEligibilityInput = {
  /** Holds a seat in a cohort. */
  enrolled: boolean;
  /** Most recent application status, if any. */
  applicationStatus: ApplicationStatus | null;
  /** Staff previewing the participant view — see StudentAccess.staff. */
  staff: boolean;
};

/**
 * Whether this viewer may use the installed app.
 *
 * Enrollment alone is enough regardless of application state: an admin can
 * enroll someone directly, and a student holding a seat must never be locked
 * out because their paperwork took an unusual route.
 *
 * Staff pass because the admin side of the app lives at the same URL, and this
 * is the same flag that lets them preview /dashboard.
 */
export function isEligibleForApp(input: AppEligibilityInput): boolean {
  if (input.staff) return true;
  if (input.enrolled) return true;
  return (
    !!input.applicationStatus && APP_ELIGIBLE_STATUSES.has(input.applicationStatus)
  );
}
