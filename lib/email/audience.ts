import { createAdminClient } from "@/lib/supabase/admin";
import { STATUS_RANK, pickParentEmail } from "@/app/admin/email/blast/shared";
import type { AudienceSegment } from "@/lib/email/catalog";

/**
 * Resolve an audience segment to the people in it.
 *
 * Shared by the scheduled-automation runner, the manual "run now" button, and
 * the one-off composer's "pick a segment" mode. The blast composer keeps its
 * own resolver because it also has to ship selectable rows to the browser and
 * handle the parent/student split; the *definitions* of the segments are the
 * same and come from lib/email/catalog.ts either way.
 */

export type AudienceMember = {
  userId: string;
  email: string;
  name: string | null;
  parentEmail: string | null;
  appStatus: string | null;
  cohorts: string[];
  role: string;
};

export type AudienceSpec = {
  segment: AudienceSegment;
  /** Narrow to one cohort. Ignored by segments that aren't cohort-shaped. */
  cohortId?: string | null;
  /** Also write to the parent address on file, where there is one. */
  includeParents?: boolean;
};

// Same ceiling the blast composer uses. A scheduled automation runs
// unattended, so the guard matters more here, not less.
export const MAX_AUDIENCE = 1000;

export async function resolveAudience(
  spec: AudienceSpec,
): Promise<AudienceMember[]> {
  const admin = createAdminClient();
  let q = admin
    .from("profiles")
    .select(
      "id, email, full_name, role, applications!applications_user_id_fkey(status, parent_email, created_at), enrollments!enrollments_user_id_fkey(cohort_id, cohort:cohorts(name))",
    )
    .not("email", "is", null)
    .limit(5000);

  if (spec.segment === "students") q = q.eq("role", "student");
  else if (spec.segment === "mentors") q = q.eq("role", "mentor");
  else if (spec.segment === "admins") q = q.eq("role", "admin");

  const { data, error } = await q;
  if (error) {
    console.error("[email/audience] query failed", error.message);
    return [];
  }

  const members: AudienceMember[] = (data ?? [])
    .filter((p: any) => p.email)
    .map((p: any) => {
      const statuses: string[] = (p.applications ?? []).map((a: any) => a.status);
      const appStatus =
        statuses.length > 0
          ? statuses.reduce((best, s) =>
              (STATUS_RANK[s] ?? -1) > (STATUS_RANK[best] ?? -1) ? s : best,
            )
          : null;
      const enrollments = (p.enrollments ?? []) as any[];
      return {
        userId: p.id,
        email: p.email,
        name: p.full_name ?? null,
        parentEmail: pickParentEmail(p.applications ?? []),
        appStatus,
        role: p.role,
        cohorts: enrollments
          .map((e) => (Array.isArray(e.cohort) ? e.cohort[0]?.name : e.cohort?.name))
          .filter(Boolean),
        _cohortIds: enrollments.map((e) => e.cohort_id).filter(Boolean),
      } as AudienceMember & { _cohortIds: string[] };
    })
    .filter((m: any) => {
      if (spec.cohortId && !m._cohortIds.includes(spec.cohortId)) return false;
      switch (spec.segment) {
        case "enrolled":
          return m.cohorts.length > 0;
        case "accepted":
          return m.appStatus === "accepted";
        case "waitlisted":
          return m.appStatus === "waitlisted";
        case "applied":
          return m.appStatus === "submitted";
        default:
          return true;
      }
    })
    .map(({ _cohortIds, ...m }: any) => m);

  return members.slice(0, MAX_AUDIENCE);
}

/**
 * Every address an audience resolves to, deduped.
 *
 * Deduping matters more than it looks: siblings share a parent address, and
 * plenty of under-18s put a parent's address on their own account. Without
 * this, that parent gets the same scheduled email twice a week, forever.
 */
export function audienceAddresses(
  members: AudienceMember[],
  includeParents = false,
): { email: string; name: string | null; userId: string | null }[] {
  const byAddress = new Map<
    string,
    { email: string; name: string | null; userId: string | null }
  >();
  for (const m of members) {
    const key = m.email.toLowerCase();
    if (!byAddress.has(key)) {
      byAddress.set(key, { email: m.email, name: m.name, userId: m.userId });
    }
    if (includeParents && m.parentEmail) {
      const pk = m.parentEmail.toLowerCase();
      // A student's own address wins if it collides with a parent entry, so
      // they're greeted by name rather than as an anonymous guardian.
      if (!byAddress.has(pk)) {
        byAddress.set(pk, { email: m.parentEmail, name: null, userId: null });
      }
    }
  }
  return Array.from(byAddress.values());
}

export async function countAudience(spec: AudienceSpec): Promise<number> {
  const members = await resolveAudience(spec);
  return audienceAddresses(members, spec.includeParents).length;
}
