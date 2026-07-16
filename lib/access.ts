import { cache } from "react";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Role, ApplicationStatus } from "@/lib/types";
import {
  computePreCohort,
  todayISO,
  cohortHasStarted,
  isAcceptedStatus,
  type PreCohortCohort,
} from "@/lib/pre-cohort";

/**
 * Whether the current user is enrolled in any cohort. Admins are treated
 * as enrolled so they can preview enrolled-only routes; mentors and
 * investors don't reach /dashboard so the answer doesn't matter for them.
 */
export async function isEnrolled(role?: Role | null): Promise<boolean> {
  if (role === "admin") return true;
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return false;
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
   * Accepted (or enrolled) but the cohort hasn't started yet. Pre-cohort
   * students only get the personal pages + pre-cohort resources — the
   * middleware enforces it, the nav and pages mirror it. Kept in lockstep
   * with the check in lib/supabase/middleware.ts via lib/pre-cohort.ts.
   */
  preCohort: boolean;
  /** Start date (YYYY-MM-DD) of the soonest not-yet-started cohort, when pre-cohort. */
  cohortStartsOn: string | null;
  /** Name of that cohort, when pre-cohort. */
  cohortName: string | null;
};

const NO_PRE_COHORT = {
  preCohort: false,
  cohortStartsOn: null,
  cohortName: null,
} as const;

type NamedCohort = PreCohortCohort & { name: string | null };

/** Supabase embeds to-one relations as object or single-element array. */
function embeddedCohort(c: unknown): NamedCohort | null {
  const cohort = Array.isArray(c) ? c[0] : c;
  return (cohort as NamedCohort) ?? null;
}

/**
 * Request-cached (React cache): the dashboard layout and the rendered
 * page both call this for the same role in one request and share a
 * single resolution — no duplicate queries, no layout/page disagreement.
 */
export const getStudentAccess = cache(async function getStudentAccess(
  role: Role = "student",
): Promise<StudentAccess> {
  if (role === "admin") {
    return { enrolled: true, applicationStatus: null, role, ...NO_PRE_COHORT };
  }
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return { enrolled: false, applicationStatus: null, role, ...NO_PRE_COHORT };
  }
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
  const enrolled = (enrollments?.length ?? 0) > 0;
  const applicationStatus = (app?.status as ApplicationStatus) ?? null;
  const accepted = isAcceptedStatus(applicationStatus);

  let preCohort = false;
  let cohortStartsOn: string | null = null;
  let cohortName: string | null = null;
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
    const cohorts = Array.from(byId.values());
    const today = todayISO();
    preCohort = computePreCohort(true, cohorts, today);
    if (preCohort) {
      const upcoming = cohorts
        .filter((c) => !cohortHasStarted(c, today))
        .sort((a, b) =>
          (a.starts_on ?? "9999-12-31") < (b.starts_on ?? "9999-12-31") ? -1 : 1,
        )[0];
      cohortStartsOn = upcoming?.starts_on ?? null;
      cohortName = upcoming?.name ?? null;
    }
  }

  return {
    enrolled,
    applicationStatus,
    role,
    preCohort,
    cohortStartsOn,
    cohortName,
  };
});

/**
 * AI co-founder access derived from a StudentAccess. Staff always;
 * students need a reviewed application (accepted / paid / enrolled) AND
 * their cohort to have started — pre-cohort students only get the
 * personal pages.
 */
export function aiAccessFrom(access: StudentAccess): boolean {
  if (access.role !== "student") return true;
  if (access.preCohort) return false;
  return isAcceptedStatus(access.applicationStatus);
}

/**
 * Whether the current user is allowed to access the AI co-founder.
 * Staff always have access. Students need an application that has
 * passed admin review (accepted / paid / enrolled) and a started cohort.
 */
export async function canUseAi(role: Role): Promise<boolean> {
  if (role === "admin" || role === "mentor" || role === "investor") {
    return true;
  }
  return aiAccessFrom(await getStudentAccess(role));
}
