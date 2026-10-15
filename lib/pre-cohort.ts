// ---------------------------------------------------------------------------
// Pre-cohort lockdown — shared, pure logic.
//
// An accepted (or already-enrolled) student whose cohort hasn't started yet
// only gets the personal pages: home, application, billing, referrals,
// settings, chat — plus kickoff, resources (pre-cohort
// section), announcements, and team once they've paid to enroll. Everything
// else under /dashboard is off-limits until kickoff.
//
// This module is imported by the Edge middleware, server components, AND
// client components (sidebar / mobile nav) — keep it dependency-free and
// side-effect-free. The single source of truth for "which pages survive
// pre-cohort" lives here; middleware enforces it, the nav mirrors it.
// ---------------------------------------------------------------------------

import type { ApplicationStatus } from "@/lib/types";

/**
 * Application statuses that count as "passed review". Single home for the
 * list — lib/access.ts and the middleware gate import it. (Since migration
 * 0046, RLS no longer keys off these statuses for resources / flows /
 * receipts — those are enrolled-only.)
 */
export const ACCEPTED_STATUSES: readonly ApplicationStatus[] = [
  "accepted",
  "paid",
  "enrolled",
];

export function isAcceptedStatus(
  status: string | null | undefined,
): boolean {
  return (
    status != null && ACCEPTED_STATUSES.includes(status as ApplicationStatus)
  );
}

/**
 * Nav hrefs (exact) that stay visible in the sidebar pre-cohort. Kickoff,
 * Resources, and Team additionally require enrollment — isStudentHrefVisible
 * (lib/student-nav.ts) and the pages enforce that on top of this set. Chat
 * is open to every pre-cohort student: the cohort's channel is where it
 * meets before day one. (/chat lives outside /dashboard, so the lockdown
 * never touches the page itself; it's listed so the nav keeps the link.)
 */
export const PRE_COHORT_ALLOWED_HREFS = new Set<string>([
  "/dashboard",
  "/dashboard/application",
  "/dashboard/kickoff",
  "/dashboard/resources",
  "/chat",
  // Announcements are how the team reaches a cohort in the weeks BEFORE day
  // one — the stretch where students have paid, have nothing to do yet, and
  // most need to hear from us. Locking the page until kickoff meant the one
  // channel we control was dark for exactly that window, while the sidebar
  // hid the tab so nobody could tell it existed.
  "/dashboard/announcements",
  "/dashboard/team",
  // 1:1 calls stay open before kickoff: "Request a 1:1" lives on this page,
  // and a call the team books has to have somewhere to land. The page itself
  // carries no enrollment gate (see app/dashboard/calls/page.tsx).
  "/dashboard/calls",
  "/dashboard/billing",
  // Scholarships are applied for after acceptance and after enrolment, and
  // the weeks before day one are the whole of that second window — an
  // enrolled student waiting on kickoff still needs to reach the form, and an
  // awarded one needs to see their mentor-call credits.
  "/dashboard/scholarships",
  "/dashboard/referrals",
  // Support is open in every state, and the pre-cohort window is the one it
  // matters most in: the 48-hour refund window in the refund policy falls
  // entirely before day one, and a student who has just paid and changed
  // their mind must not meet a locked page. Locking this would be locking the
  // exit.
  "/dashboard/support",
  "/dashboard/settings",
]);

// Route prefixes a pre-cohort student may load, including nested routes
// (e.g. /dashboard/billing/receipts). /dashboard/pay-fine isn't in the nav
// but must stay reachable — the fine middleware forces users there.
const PRE_COHORT_ALLOWED_PREFIXES = [
  "/dashboard/application",
  // The acceptance and enrollment moments. Both are reached exactly when
  // the student is pre-cohort, so the lockdown would otherwise bounce a
  // student straight out of the page confirming they just paid. Neither
  // is a nav item, so they stay out of PRE_COHORT_ALLOWED_HREFS.
  "/dashboard/accepted",
  "/dashboard/enrolled",
  "/dashboard/kickoff",
  "/dashboard/resources",
  // The old Community page, now a redirect to /chat: old lesson and kickoff
  // links still land on it.
  "/dashboard/community",
  "/dashboard/announcements",
  "/dashboard/team",
  "/dashboard/calls",
  "/dashboard/billing",
  "/dashboard/scholarships",
  "/dashboard/referrals",
  "/dashboard/support",
  "/dashboard/settings",
  "/dashboard/pay-fine",
];

/**
 * A webinar room (`/dashboard/events/<id>/live`) — reachable pre-cohort, so an
 * orientation webinar before day one can actually be attended. Only the room,
 * not the events list, and RLS on the event still decides who may see it.
 */
const WEBINAR_ROOM_PATH = /^\/dashboard\/events\/[^/]+\/live\/?$/;

/** Whether a /dashboard pathname is reachable during pre-cohort lockdown. */
export function isPreCohortAllowedPath(path: string): boolean {
  if (path === "/dashboard") return true;
  if (WEBINAR_ROOM_PATH.test(path)) return true;
  return PRE_COHORT_ALLOWED_PREFIXES.some(
    (p) => path === p || path.startsWith(p + "/"),
  );
}

export type PreCohortCohort = {
  starts_on: string | null;
  status: string | null;
};

/** Today as a UTC calendar date (matches cohorts.starts_on, a plain date). */
export function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * A cohort counts as started once an admin flips it active (or it
 * completed), or its start date has arrived. A 'cancelled' or dateless
 * 'upcoming' cohort has not started.
 */
export function cohortHasStarted(c: PreCohortCohort, today: string): boolean {
  if (c.status === "active" || c.status === "completed") return true;
  return !!c.starts_on && c.starts_on <= today;
}

/**
 * The lockdown decision. `acceptedOrEnrolled` = the student has an
 * accepted/paid/enrolled application or an enrollments row. `cohorts` are
 * ALL cohorts tied to those (null = the lookup failed — fail open so a
 * transient DB error never locks a mid-cohort student out of the course).
 * An empty list (accepted but no cohort assigned yet) counts as pre-cohort:
 * nothing has started for them.
 */
export function computePreCohort(
  acceptedOrEnrolled: boolean,
  cohorts: PreCohortCohort[] | null,
  today: string = todayISO(),
): boolean {
  if (!acceptedOrEnrolled) return false;
  if (cohorts === null) return false;
  return cohorts.every((c) => !cohortHasStarted(c, today));
}

/** "2026-08-17" → "August 17, 2026". Dates are calendar days, so UTC. */
export function fmtDateOnly(d: string | null | undefined): string | null {
  if (!d) return null;
  const dt = new Date(`${d}T00:00:00Z`);
  if (isNaN(dt.getTime())) return d;
  return dt.toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}
