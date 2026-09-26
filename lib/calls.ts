import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import type { CallInvite, CallInviteStatus } from "@/lib/live";

/**
 * Reads for staff-initiated 1:1 calls (`call_invites`, migration 0059).
 *
 * Service-role reads with explicit filters rather than RLS-scoped ones, so a
 * single query can join both sides' profile names — but every function here
 * takes the viewer's id and filters on it. RLS is still the backstop on the
 * table; these filters are what make the backstop never the thing that saves
 * us.
 *
 * These return calls in storage order (newest start first) and no more. What
 * a call IS right now — upcoming, live, over — depends on the clock as much as
 * on `status`, and is decided by lib/call-lifecycle.ts at the point of display
 * (`splitCalls` re-sorts Upcoming soonest-first). Filtering by time here would
 * be a second copy of that rule, frozen at query time.
 */

// Both foreign keys point at `profiles`, so PostgREST can't infer which one an
// embedded join means. Naming the constraints disambiguates them; Postgres
// generated these names from the inline `references` in the migration.
const SELECT = `
  id, host_id, invitee_id, starts_at, duration_minutes, topic, status,
  daily_room_name, daily_room_url, recap, created_at,
  host:profiles!call_invites_host_id_fkey(full_name, role),
  invitee:profiles!call_invites_invitee_id_fkey(full_name)
`;

function one<T>(v: T | T[] | null | undefined): T | null {
  return Array.isArray(v) ? (v[0] ?? null) : (v ?? null);
}

function toInvite(row: any): CallInvite {
  const host = one<any>(row.host);
  const invitee = one<any>(row.invitee);
  return {
    id: row.id,
    hostName: host?.full_name || "A member of the team",
    hostRole: host?.role || "mentor",
    inviteeName: invitee?.full_name || "Student",
    startsAt: row.starts_at,
    durationMinutes: row.duration_minutes,
    topic: row.topic,
    status: row.status as CallInviteStatus,
    roomName: row.daily_room_name,
    roomUrl: row.daily_room_url,
  };
}

/** Invites this person sent. */
export async function listInvitesForHost(
  hostId: string,
): Promise<CallInvite[]> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("call_invites")
    .select(SELECT)
    .eq("host_id", hostId)
    .order("starts_at", { ascending: false });
  return (data ?? []).map(toInvite);
}

/** Invites this person received. */
export async function listInvitesForInvitee(
  inviteeId: string,
): Promise<CallInvite[]> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("call_invites")
    .select(SELECT)
    .eq("invitee_id", inviteeId)
    .order("starts_at", { ascending: false });
  return (data ?? []).map(toInvite);
}

/** Every invite, for the admin view. */
export async function listAllInvites(): Promise<CallInvite[]> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("call_invites")
    .select(SELECT)
    .order("starts_at", { ascending: false })
    .limit(200);
  return (data ?? []).map(toInvite);
}

/** One invite, plus the raw ids the join page needs to authorize against. */
export async function getInvite(id: string): Promise<
  | (CallInvite & {
      hostId: string;
      inviteeId: string;
    })
  | null
> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("call_invites")
    .select(SELECT)
    .eq("id", id)
    .maybeSingle();
  if (!data) return null;
  return {
    ...toInvite(data),
    hostId: (data as any).host_id,
    inviteeId: (data as any).invitee_id,
  };
}

export type InviteeOption = {
  id: string;
  name: string;
  email: string;
  teamName?: string | null;
};

/**
 * Who can be invited.
 *
 * Every student, deliberately — not just a mentor's assigned students or an
 * investor's portfolio. That was a product decision, and it has a real edge:
 * an investor can reach a student they have no prior relationship with. The
 * audit log and the invite's own visibility to admins are what cover that,
 * rather than the picker being narrow. If it ever needs tightening, this
 * function is the one place to do it.
 */
export async function listInvitableStudents(): Promise<InviteeOption[]> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("profiles")
    .select("id, full_name, email, role")
    .eq("role", "student")
    .order("full_name", { ascending: true })
    .limit(500);

  return (data ?? []).map((p: any) => ({
    id: p.id,
    name: p.full_name || p.email || "Unnamed student",
    email: p.email ?? "",
    teamName: null,
  }));
}
