import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { getAllRoles } from "@/lib/roles";

/**
 * Reads for "Request a 1:1" (`interview_requests`, migration 0061): an
 * enrolled student asks the team for a call, whenever they want.
 *
 * Service-role reads with explicit filters, the same shape as lib/calls.ts:
 * RLS is the backstop, but every function here filters on the id it was given
 * so the backstop is never what saves us.
 *
 * Not to be confused with lib intro/`intro_requests` (0011) — that's the
 * investor↔team intro feature.
 */

export type InterviewRequestStatus =
  | "requested"
  | "scheduled"
  | "declined"
  | "cancelled";

export type InterviewRequest = {
  id: string;
  studentId: string;
  studentName: string;
  studentEmail: string;
  cohortName: string | null;
  preferredAt: string | null;
  altAt: string | null;
  note: string | null;
  status: InterviewRequestStatus;
  callInviteId: string | null;
  createdAt: string;
};

const SELECT = `
  id, student_id, cohort_id, preferred_at, alt_at, note, status,
  call_invite_id, created_at,
  student:profiles!interview_requests_student_id_fkey(full_name, email),
  cohort:cohorts(name)
`;

function one<T>(v: T | T[] | null | undefined): T | null {
  return Array.isArray(v) ? (v[0] ?? null) : (v ?? null);
}

function toRequest(row: any): InterviewRequest {
  const student = one<any>(row.student);
  const cohort = one<any>(row.cohort);
  return {
    id: row.id,
    studentId: row.student_id,
    studentName: student?.full_name || student?.email || "A student",
    studentEmail: student?.email || "",
    cohortName: cohort?.name ?? null,
    preferredAt: row.preferred_at,
    altAt: row.alt_at,
    note: row.note,
    status: row.status as InterviewRequestStatus,
    callInviteId: row.call_invite_id,
    createdAt: row.created_at,
  };
}

/**
 * This student's request still waiting on the team, if any (the database
 * allows one). Booked, declined and withdrawn ones are history.
 */
export async function getInterviewRequestForStudent(
  studentId: string,
): Promise<InterviewRequest | null> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("interview_requests")
    .select(SELECT)
    .eq("student_id", studentId)
    .eq("status", "requested")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return data ? toRequest(data) : null;
}

/** Everything still waiting on the team, oldest first — a queue. */
export async function listOpenInterviewRequests(): Promise<InterviewRequest[]> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("interview_requests")
    .select(SELECT)
    .eq("status", "requested")
    .order("created_at", { ascending: true })
    .limit(200);
  return (data ?? []).map(toRequest);
}

/** One request, plus the raw student id the schedule action authorizes against. */
export async function getInterviewRequest(
  id: string,
): Promise<(InterviewRequest & { cohortId: string | null }) | null> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("interview_requests")
    .select(SELECT)
    .eq("id", id)
    .maybeSingle();
  if (!data) return null;
  return { ...toRequest(data), cohortId: (data as any).cohort_id ?? null };
}

/**
 * User ids of the batch0 team who confirm these requests, for the new-request
 * fan-out. That's the admins: a student asking for a 1:1 is asking the core
 * team, and /admin/calls (where the queue lives) is an admin page. The scheduling action itself is authorized by `calls.invite`
 * the broader permission, so a mentor or investor could still act on one; they
 * just aren't paged about it.
 *
 * Roles are data (migration 0048), so "admin" here means any role holding the
 * '*' wildcard — a custom admin-tier role is included exactly as the RLS
 * policy would let it read the row.
 */
export async function listInterviewTeamIds(): Promise<string[]> {
  const roles = await getAllRoles();
  const slugs = roles
    .filter((r) => r.permissions.includes("*"))
    .map((r) => r.slug);
  if (slugs.length === 0) return [];

  const admin = createAdminClient();
  const { data } = await admin
    .from("profiles")
    .select("id")
    .in("role", slugs)
    .limit(500);
  return (data ?? []).map((p: any) => p.id as string);
}
