// ---------------------------------------------------------------------------
// The student nav: which links exist, and who sees each one.
//
// One predicate (isStudentHrefVisible) feeds the desktop sidebar, the mobile
// drawer (both via lib/nav-config.ts) and the installed app's More screen.
// Middleware enforces the pre-cohort list in lib/pre-cohort.ts; pages behind
// ENROLLED_ONLY_HREFS render <LockedFeature> for anyone not enrolled.
//
// Import-free apart from ./pre-cohort.ts, so `node --test` runs it as-is and
// client components can import it.
// ---------------------------------------------------------------------------

import { PRE_COHORT_ALLOWED_HREFS, isPreCohortAllowedPath } from "./pre-cohort.ts";

/** No student ever sees more links than this (lib/student-nav.test.ts). */
export const STUDENT_NAV_MAX = 12;

export const STUDENT_NAV_LAYOUT = [
  {
    label: "",
    items: [
      { href: "/dashboard", label: "Home" },
      { href: "/dashboard/application", label: "Application" },
      { href: "/dashboard/kickoff", label: "Kickoff" },
    ],
  },
  {
    label: "Program",
    items: [
      { href: "/dashboard/course", label: "Course" },
      { href: "/dashboard/assignments", label: "Assignments" },
      { href: "/dashboard/team", label: "Team" },
      { href: "/dashboard/events", label: "Events" },
      { href: "/dashboard/calls", label: "1:1 calls" },
      { href: "/dashboard/resources", label: "Resources" },
    ],
  },
  {
    label: "Cohort",
    items: [
      { href: "/dashboard/announcements", label: "Announcements" },
      { href: "/chat", label: "Chat" },
    ],
  },
  {
    label: "Account",
    items: [
      { href: "/dashboard/billing", label: "Billing" },
      { href: "/dashboard/scholarships", label: "Scholarships" },
      { href: "/dashboard/referrals", label: "Refer friends" },
      { href: "/dashboard/support", label: "Help & support" },
      { href: "/dashboard/settings", label: "Settings" },
    ],
  },
] as const;

export type StudentNavHref =
  (typeof STUDENT_NAV_LAYOUT)[number]["items"][number]["href"];

/**
 * Pages that need an enrollment row. Each one renders <LockedFeature> for
 * anyone else; Announcements also matches its RLS (0027), which returns
 * nothing to an applicant.
 */
export const ENROLLED_ONLY_HREFS = new Set<string>([
  "/dashboard/course",
  "/dashboard/team",
  "/dashboard/announcements",
  "/dashboard/assignments",
  "/dashboard/events",
  "/dashboard/resources",
]);

export type StudentNavContext = {
  referralsEnabled: boolean;
  /** Staff previewing the dashboard resolve as enrolled (lib/access.ts). */
  enrolled: boolean;
  /** Accepted or enrolled, cohort not started (lib/pre-cohort.ts). */
  preCohort: boolean;
  /** A paid Demo Day ticket opens Events, and nothing else. */
  demoDayTicket?: boolean;
};

/**
 * Whether a student sees a link to `href`. Pre-cohort lockdown wins first;
 * then the lifecycle items; then enrolled-only pages.
 *
 * Chat (/chat, outside /dashboard) is always there: before acceptance it's
 * how an applicant messages the team, after it the cohort's channels.
 *
 * Lifecycle items keep the list short at every stage: Application until
 * enrolled (the home hero carries it after), Kickoff only while counting
 * down, Scholarships and Refer friends until the cohort starts (Billing links
 * both after that, and nav search finds them under Billing).
 */
export function isStudentHrefVisible(href: string, ctx: StudentNavContext): boolean {
  if (ctx.preCohort && !PRE_COHORT_ALLOWED_HREFS.has(href)) return false;
  const beforeStart = !ctx.enrolled || ctx.preCohort;
  switch (href) {
    case "/dashboard/application":
      return !ctx.enrolled;
    case "/dashboard/kickoff":
      return ctx.enrolled && ctx.preCohort;
    case "/dashboard/scholarships":
      return beforeStart;
    case "/dashboard/referrals":
      return ctx.referralsEnabled && beforeStart;
    case "/dashboard/events":
      if (ctx.demoDayTicket) return true;
      break;
  }
  return ctx.enrolled || !ENROLLED_ONLY_HREFS.has(href);
}

/**
 * The startup-tool chips on the Team page (app/dashboard/team/team-home.tsx).
 * Team opens before kickoff, so a chip shown pre-cohort must be a route the
 * middleware lets through, or the click bounces the student home.
 */
export const TEAM_TOOL_HREFS = [
  "/dashboard/intros",
  "/dashboard/team/offers",
  "/dashboard/team/pitch-coach",
  "/dashboard/ai",
] as const;

export type TeamToolHref = (typeof TEAM_TOOL_HREFS)[number];

export function isTeamToolVisible(
  href: TeamToolHref,
  ctx: { preCohort: boolean; ai: boolean },
): boolean {
  if (href === "/dashboard/ai" && !ctx.ai) return false;
  return !ctx.preCohort || isPreCohortAllowedPath(href);
}
