import { cache } from "react";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
// Safe to import: lib/auth never imports this module, so no cycle. The shared
// getUser() keeps the whole request at one auth round trip however many
// access helpers run.
import { getUser } from "@/lib/auth";
import { capabilitiesForRole } from "@/lib/roles";
import { can, canAccessAdmin } from "@/lib/permissions";
import { isEligibleForApp } from "@/lib/app-eligibility";
import type { Role, ApplicationStatus } from "@/lib/types";
import {
  computePreCohort,
  todayISO,
  cohortHasStarted,
  isAcceptedStatus,
  type PreCohortCohort,
} from "@/lib/pre-cohort";

/**
 * Staff previewing the student view. Anyone who can open the admin area gets
 * the full dashboard so they can see what students see — the check is on the
 * permission rather than the `admin` slug, so a custom role with admin access
 * behaves the same way.
 */
async function isStaffPreview(role?: Role | null): Promise<boolean> {
  if (!role) return false;
  return canAccessAdmin(await capabilitiesForRole(role));
}

/**
 * Whether the current user is enrolled in any cohort. Staff are treated
 * as enrolled so they can preview enrolled-only routes; mentors and
 * investors don't reach /dashboard so the answer doesn't matter for them.
 */
export async function isEnrolled(role?: Role | null): Promise<boolean> {
  if (await isStaffPreview(role)) return true;
  const user = await getUser();
  if (!user) return false;
  const supabase = createClient();
  const { data } = await supabase
    .from("enrollments")
    .select("id")
    .eq("user_id", user.id)
    .limit(1)
    .maybeSingle();
  return !!data;
}

/**
 * Shape returned by getStudentAccess: a single object the dashboard
 * pages can branch on to render a soft "you need to be enrolled" view
 * instead of redirecting or 500'ing the user.
 */
export type StudentAccess = {
  enrolled: boolean;
  /** Most recent application status, if any. */
  applicationStatus: ApplicationStatus | null;
  /** Role of the current user, defaulting to "student". */
  role: Role;
  /**
   * Staff previewing the dashboard rather than a participant in it. Replaces
   * the old `role === "admin"` test so a custom admin-area role behaves the
   * same way.
   */
  staff: boolean;
  /**
   * Accepted (or enrolled) but the cohort hasn't started yet. Pre-cohort
   * students only get the personal pages — plus kickoff and pre-cohort
   * resources once enrolled. The middleware enforces it, the nav and pages
   * mirror it. Kept in lockstep with the check in
   * lib/supabase/middleware.ts via lib/pre-cohort.ts.
   */
  preCohort: boolean;
  /** Start date (YYYY-MM-DD) of the soonest not-yet-started cohort, when pre-cohort. */
  cohortStartsOn: string | null;
  /** Name of that cohort, when pre-cohort. */
  cohortName: string | null;
  /**
   * The cohort this student is currently tied to — the soonest not-yet-started
   * one, or the most recently started one when they're all underway. Unlike
   * `cohortStartsOn` / `cohortName` above (which stay pre-cohort-only, because
   * callers branch on them meaning "pre-cohort"), this is resolved whatever
   * the lifecycle stage, so a page like /dashboard/kickoff can look up cohort
   * content at any point in the program. Null for staff and for a student
   * with no cohort assigned yet.
   */
  cohortId: string | null;
};

const NO_PRE_COHORT = {
  preCohort: false,
  cohortStartsOn: null,
  cohortName: null,
} as const;

type NamedCohort = PreCohortCohort & { name: string | null };

/** Soonest start date first; dateless cohorts sort last. */
function byStartDate(a: PreCohortCohort, b: PreCohortCohort): number {
  return (a.starts_on ?? "9999-12-31") < (b.starts_on ?? "9999-12-31") ? -1 : 1;
}

/** Supabase embeds to-one relations as object or single-element array. */
function embeddedCohort(c: unknown): NamedCohort | null {
  const cohort = Array.isArray(c) ? c[0] : c;
  return (cohort as NamedCohort) ?? null;
}

/**
 * The two user-keyed reads behind getStudentAccess, on their own.
 *
 * Split out because they depend only on the signed-in user, never on `role` —
 * while getStudentAccess as a whole cannot start until the caller has resolved
 * a role, which in the dashboard layout means waiting on getViewer() first.
 * That ordering made these queries a third serial wave in a render that has
 * nothing to show until it finishes: `loading.tsx` lives inside the layout's
 * boundary, so the user watches a blank frame for the duration.
 *
 * Exported so the layout can start it in the same parallel batch as
 * getViewer(). By the time getStudentAccess() runs, this is already resolved
 * and returns from cache.
 *
 * The zero arity is load-bearing. React's cache() keys on arguments, so adding
 * a parameter here would make the layout's speculative call and
 * getStudentAccess's call two different entries — two round trips instead of
 * none.
 */
export const loadAccessRows = cache(async function loadAccessRows() {
  const user = await getUser();
  if (!user) return null;
  const admin = createAdminClient();
  const [{ data: enrollments }, { data: app }] = await Promise.all([
    admin
      .from("enrollments")
      .select("cohort_id, cohort:cohorts(name, starts_on, status)")
      .eq("user_id", user.id),
    admin
      .from("applications")
      .select("status, cohort_id, cohort:cohorts(name, starts_on, status)")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);
  return { enrollments, app };
});

/**
 * Request-cached (React cache): the dashboard layout and the rendered
 * page both call this for the same role in one request and share a
 * single resolution — no duplicate queries, no layout/page disagreement.
 */
export const getStudentAccess = cache(async function getStudentAccess(
  role: Role = "student",
): Promise<StudentAccess> {
  if (await isStaffPreview(role)) {
    return {
      enrolled: true,
      applicationStatus: null,
      role,
      staff: true,
      cohortId: null,
      ...NO_PRE_COHORT,
    };
  }
  const rows = await loadAccessRows();
  if (!rows) {
    return {
      enrolled: false,
      applicationStatus: null,
      role,
      staff: false,
      cohortId: null,
      ...NO_PRE_COHORT,
    };
  }
  const { enrollments, app } = rows;
  const enrolled = (enrollments?.length ?? 0) > 0;
  const applicationStatus = (app?.status as ApplicationStatus) ?? null;
  const accepted = isAcceptedStatus(applicationStatus);

  let preCohort = false;
  let cohortStartsOn: string | null = null;
  let cohortName: string | null = null;
  let cohortId: string | null = null;
  if (enrolled || accepted) {
    // Every cohort the student is tied to: all enrollments + the accepted
    // application's cohort. Deduped by id; the embeds ride along on the
    // two queries above, so no extra round trip.
    const byId = new Map<string, NamedCohort>();
    for (const e of enrollments ?? []) {
      const c = embeddedCohort(e.cohort);
      if (e.cohort_id && c) byId.set(e.cohort_id, c);
    }
    if (accepted && app?.cohort_id) {
      const c = embeddedCohort(app.cohort);
      if (c) byId.set(app.cohort_id, c);
    }
    const entries = Array.from(byId.entries());
    const cohorts = entries.map(([, c]) => c);
    const today = todayISO();
    preCohort = computePreCohort(true, cohorts, today);

    // The one cohort that represents "where this student is". Prefer the
    // soonest one still ahead of them; once everything has started, the most
    // recently started one is the cohort they're actually living in.
    const upcoming = entries
      .filter(([, c]) => !cohortHasStarted(c, today))
      .sort(([, a], [, b]) => byStartDate(a, b))[0];
    const current =
      upcoming ??
      entries
        .filter(([, c]) => cohortHasStarted(c, today))
        .sort(([, a], [, b]) => byStartDate(b, a))[0];
    cohortId = current?.[0] ?? null;

    if (preCohort) {
      cohortStartsOn = upcoming?.[1]?.starts_on ?? null;
      cohortName = upcoming?.[1]?.name ?? null;
    }
  }

  return {
    enrolled,
    applicationStatus,
    role,
    staff: false,
    preCohort,
    cohortStartsOn,
    cohortName,
    cohortId,
  };
});

/**
 * Does the signed-in user owe an unpaid fine?
 *
 * The same predicate middleware applies to /dashboard, /apply, /mentor and
 * /investor — but callable from a server component, so the installed app can
 * enforce it from its layout instead of buying an edge-to-region round trip in
 * middleware on every navigation. See the note in lib/supabase/middleware.ts.
 *
 * Request-cached: the layout and anything else that asks in the same render
 * share one read.
 *
 * Fails CLOSED on a query error — an unreadable charges table must not become a
 * way to use the product for free. The cost of being wrong here is one person
 * seeing a pay screen they could dismiss by reloading; the cost the other way is
 * the fine gate quietly not existing.
 */
export const hasPendingFine = cache(async function hasPendingFine(): Promise<boolean> {
  const user = await getUser();
  if (!user) return false;
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("user_charges")
    .select("id")
    .eq("user_id", user.id)
    .eq("kind", "fine")
    .eq("status", "pending")
    .limit(1)
    .maybeSingle();
  if (error) {
    console.error("[access] pending-fine check failed:", error.message);
    return true;
  }
  return !!data;
});

/**
 * Whether this viewer may use the installed app at /app.
 *
 * A pure function on an already-resolved StudentAccess, like aiAccessFrom
 * below: the layout has one in hand, so the gate costs no extra query. The rule
 * itself lives in lib/app-eligibility.ts — import-free so it can be tested, and
 * so there is exactly one definition of who gets in.
 */
export function installedAppAccessFrom(access: StudentAccess): boolean {
  return isEligibleForApp({
    enrolled: access.enrolled,
    applicationStatus: access.applicationStatus,
    staff: access.staff,
  });
}

/**
 * AI co-founder access derived from a StudentAccess. Staff always;
 * students need a reviewed application (accepted / paid / enrolled) AND
 * their cohort to have started — pre-cohort students only get the
 * personal pages.
 */
export function aiAccessFrom(access: StudentAccess): boolean {
  if (access.staff) return true;
  if (access.preCohort) return false;
  return isAcceptedStatus(access.applicationStatus);
}

/**
 * Whether the current user is allowed to access the AI co-founder.
 * Staff always have access. Students need an application that has
 * passed admin review (accepted / paid / enrolled) and a started cohort.
 */
export async function canUseAi(role: Role): Promise<boolean> {
  const caps = await capabilitiesForRole(role);
  if (
    canAccessAdmin(caps) ||
    can(caps, "mentor.panel") ||
    can(caps, "investor.panel")
  ) {
    return true;
  }
  return aiAccessFrom(await getStudentAccess(role));
}
