import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { can, rolesHolding } from "@/lib/permissions";
import { capabilitiesForRole, getAllRoles } from "@/lib/roles";
import { notifyMany } from "@/lib/notifications";
import { hostCallsHref } from "@/lib/call-lifecycle";
import {
  MAX_CALL_COHOSTS,
  normalizeCohostIds,
  type CallCohost,
  type CallInvite,
  type CallInviteStatus,
} from "@/lib/live";

/**
 * Reads for staff-initiated 1:1 calls (`call_invites`, migration 0059).
 *
 * Service-role reads with explicit filters rather than RLS-scoped ones, so a
 * single query can join both sides' profile names — but every function here
 * takes the viewer's id and filters on it. RLS is still the backstop on the
 * table; these filters are what make the backstop never the thing that saves
 * us.
 *
 * These return calls in storage order (newest start first). What a call IS
 * right now is decided by lib/call-lifecycle.ts at the point of display.
 *
 * ---------------------------------------------------------------------------
 * Co-hosts, and a database that is a deploy behind
 * ---------------------------------------------------------------------------
 *
 * Since migration 0092 a call has a staff SIDE: the host plus any co-hosts
 * (`call_invite_cohosts`). Every read here embeds them. But this code can
 * reach production before anyone has pasted 0092 into the SQL editor, and
 * PostgREST refuses a whole query that embeds a relationship it has never
 * heard of (PGRST200) — which, unhandled, would empty every calls page and
 * 404 every room. So each read tries the embed and, on exactly that error,
 * re-runs without it: on such a database every call has no co-hosts, which is
 * the truth.
 */

// Both foreign keys point at `profiles`, so PostgREST can't infer which one an
// embedded join means. Naming the constraints disambiguates them; Postgres
// generated these names from the inline `references` in the migration. The
// co-host embed is hinted the same way: 0092's join table makes call_invites
// and profiles many-to-many as well, and an unhinted embed is a guess.
const BASE_SELECT = `
  id, host_id, invitee_id, starts_at, duration_minutes, topic, status,
  created_at, updated_at,
  host:profiles!call_invites_host_id_fkey(full_name, role),
  invitee:profiles!call_invites_invitee_id_fkey(full_name)
`;
export const COHOSTS_EMBED = `
  cohosts:call_invite_cohosts!call_invite_cohosts_invite_id_fkey(
    profile_id, created_at,
    profile:profiles!call_invite_cohosts_profile_id_fkey(full_name, role)
  )
`;
const SELECT = `${BASE_SELECT}, ${COHOSTS_EMBED}`;

/**
 * The roles whose members may sit on a call's staff side as co-hosts
 * (migration 0092): every role holding `calls.invite`, the wildcard included.
 *
 * The capability, not a list of role names — the same rule createInvite
 * applies to the host, for the same reason. A co-host's only way to the call
 * is their calls list (/admin, /mentor or /investor /calls), and every one of
 * those pages requires calls.invite. Picked by role name, an investor whose
 * role had calls.invite taken away could be added to a call they then had no
 * page to find it on, and the student waited for someone who never came.
 */
async function callStaffRoleSlugs(): Promise<string[]> {
  return rolesHolding(await getAllRoles(), "calls.invite");
}

/**
 * Is this "0092 hasn't been applied" rather than a real failure?
 *
 * The same idea as `isMissingTable` in lib/webinar-data.ts, with one more
 * code: an embed of an unknown relationship is PGRST200 ("Could not find a
 * relationship ... in the schema cache"), while a direct read of an unknown
 * table is PGRST205 from PostgREST or 42P01 from Postgres. The message is
 * checked too, because it is not a stable contract and the codes have moved
 * between PostgREST releases — but only when it names the table, so an
 * unrelated "does not exist" is never mistaken for this.
 */
export function isCohostSchemaMissing(
  error: { code?: string; message?: string } | null | undefined,
): boolean {
  if (!error) return false;
  if (["PGRST200", "PGRST205", "42P01"].includes(error.code ?? "")) return true;
  const message = error.message ?? "";
  return (
    /call_invite_cohosts/.test(message) &&
    /does not exist|schema cache|relationship/i.test(message)
  );
}

type QueryResult = { data: any; error: { code?: string; message?: string } | null };

let warnedMissing = false;
/**
 * Say so — once per server instance — when the co-host embed was refused.
 * Falling back is right on a database without 0092, but the same PGRST200
 * also means a mistyped embed hint, and that must not pass as "no co-hosts"
 * in silence. (The PGlite test pins the constraint names the hints use.)
 */
export function noteCohostsUnavailable(error: { message?: string } | null): void {
  if (warnedMissing) return;
  warnedMissing = true;
  console.warn(
    "[calls] reading calls without co-hosts — has migration 0092 been applied?",
    error?.message ?? "",
  );
}

/**
 * Run a call_invites read with the co-host embed, or — on a database where
 * 0092 hasn't run — without it. `run` builds the query from a select list.
 */
async function withCohosts(
  run: (select: string) => PromiseLike<QueryResult>,
): Promise<QueryResult> {
  const first = await run(SELECT);
  if (!isCohostSchemaMissing(first.error)) return first;
  noteCohostsUnavailable(first.error);
  return run(BASE_SELECT);
}

function one<T>(v: T | T[] | null | undefined): T | null {
  return Array.isArray(v) ? (v[0] ?? null) : (v ?? null);
}

/**
 * The co-host embed (COHOSTS_EMBED) of a call_invites row as `CallCohost`s, in
 * the order they were added — [] for a row read without it. Anyone who is
 * also the host or the student is dropped: nothing writes such a row
 * (normalizeCohostIds strips them), and if one ever existed, the room would
 * dial that person twice and the card would name them twice. Shared with
 * resolveCallAccess, so the lists and the room read a call's team alike.
 */
export function cohostsFromRow(row: any): CallCohost[] {
  const rows = Array.isArray(row?.cohosts) ? (row.cohosts as any[]) : [];
  return rows
    .filter(
      (c) =>
        !!c?.profile_id &&
        c.profile_id !== row.host_id &&
        c.profile_id !== row.invitee_id,
    )
    .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))
    .map((c) => {
      const p = one<any>(c.profile);
      return {
        id: c.profile_id as string,
        name: p?.full_name || "A member of the team",
        role: p?.role || "mentor",
      };
    });
}

function toInvite(row: any): CallInvite {
  const host = one<any>(row.host);
  const invitee = one<any>(row.invitee);
  return {
    id: row.id,
    hostId: row.host_id,
    inviteeId: row.invitee_id,
    hostName: host?.full_name || "A member of the team",
    hostRole: host?.role || "mentor",
    inviteeName: invitee?.full_name || "Student",
    cohosts: cohostsFromRow(row),
    startsAt: row.starts_at,
    durationMinutes: row.duration_minutes,
    topic: row.topic,
    status: row.status as CallInviteStatus,
    updatedAt: row.updated_at ?? undefined,
    // batch0 Live needs no provider-side room.
    roomName: null,
    roomUrl: null,
  };
}

const byStartDesc = (a: CallInvite, b: CallInvite) =>
  new Date(b.startsAt).getTime() - new Date(a.startsAt).getTime();

/**
 * Invites this person is on the staff side of: ones they sent, and ones they
 * were added to as a co-host.
 *
 * Two reads rather than one `or=(host_id.eq.…,id.in.(…))`: the co-hosted ids
 * would have to travel in the URL, and an admin who has sat in on a few
 * hundred calls would eventually outgrow it. The second read starts from the
 * join table and embeds each call, so it costs one round trip however many
 * there are. A database without 0092 has no co-hosted calls.
 */
export async function listInvitesForHost(
  hostId: string,
): Promise<CallInvite[]> {
  const admin = createAdminClient();
  const [hosted, cohosted] = await Promise.all([
    withCohosts((select) =>
      admin
        .from("call_invites")
        .select(select)
        .eq("host_id", hostId)
        .order("starts_at", { ascending: false }),
    ),
    admin
      .from("call_invite_cohosts")
      .select(`invite:call_invites!call_invite_cohosts_invite_id_fkey(${SELECT})`)
      .eq("profile_id", hostId),
  ]);
  if (cohosted.error && !isCohostSchemaMissing(cohosted.error)) {
    console.error("[calls] co-hosted read failed", cohosted.error.message);
  }

  const invites = ((hosted.data ?? []) as any[]).map(toInvite);
  const seen = new Set(invites.map((i) => i.id));
  for (const r of (cohosted.data ?? []) as any[]) {
    const row = one<any>(r.invite);
    if (!row || seen.has(row.id)) continue;
    seen.add(row.id);
    invites.push(toInvite(row));
  }
  return invites.sort(byStartDesc);
}

/** Invites this person received. */
export async function listInvitesForInvitee(
  inviteeId: string,
): Promise<CallInvite[]> {
  const admin = createAdminClient();
  const { data } = await withCohosts((select) =>
    admin
      .from("call_invites")
      .select(select)
      .eq("invitee_id", inviteeId)
      .order("starts_at", { ascending: false }),
  );
  return ((data ?? []) as any[]).map(toInvite);
}

/** Every invite, for the admin view. */
export async function listAllInvites(): Promise<CallInvite[]> {
  const admin = createAdminClient();
  const { data } = await withCohosts((select) =>
    admin
      .from("call_invites")
      .select(select)
      .order("starts_at", { ascending: false })
      .limit(200),
  );
  return ((data ?? []) as any[]).map(toInvite);
}

/**
 * One invite, plus the raw ids the join page needs to authorize against —
 * which, with `cohosts`, is everything `isOnCall` / `isStaffOnCall` read.
 */
export async function getInvite(id: string): Promise<
  | (CallInvite & {
      hostId: string;
      inviteeId: string;
    })
  | null
> {
  const admin = createAdminClient();
  const { data } = await withCohosts((select) =>
    admin.from("call_invites").select(select).eq("id", id).maybeSingle(),
  );
  if (!data) return null;
  return {
    ...toInvite(data),
    hostId: (data as any).host_id,
    inviteeId: (data as any).invitee_id,
  };
}

/**
 * The co-host ids of one call, for the server actions that read a bare
 * call_invites row and must then decide who is on it.
 *
 * Throws on a real read failure rather than answering "nobody": an empty
 * answer would quietly lock every co-host out of the call they are sitting
 * in (End call refused, the status poll closing their room). A database
 * without 0092 has no co-hosts, and says so.
 */
export async function readCohostIds(
  admin: ReturnType<typeof createAdminClient>,
  inviteId: string,
): Promise<string[]> {
  const { data, error } = await admin
    .from("call_invite_cohosts")
    .select("profile_id")
    .eq("invite_id", inviteId);
  if (error) {
    if (isCohostSchemaMissing(error)) return [];
    throw new Error(error.message);
  }
  return ((data ?? []) as any[]).map((r) => r.profile_id as string);
}

export type InviteeOption = {
  id: string;
  name: string;
  email: string;
  teamName?: string | null;
};

/**
 * Who can be invited: every student, deliberately (a product decision). The
 * audit log and the admins' view of every call cover the edge that an
 * investor can reach a student they don't know; tighten here if ever needed.
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

/**
 * Who can be added to a call's staff side: everyone whose role may host calls
 * (callStaffRoleSlugs) — admins, and mentors and investors while their roles
 * hold calls.invite. The page drops the viewer (already the host), so one
 * list serves every host. `teamName` carries the role, so the picker reads
 * "mentor" where a student's team would be.
 */
export async function listInvitableStaff(): Promise<InviteeOption[]> {
  const roles = await callStaffRoleSlugs();
  if (roles.length === 0) return [];
  const admin = createAdminClient();
  const { data } = await admin
    .from("profiles")
    .select("id, full_name, email, role")
    .in("role", roles)
    .order("full_name", { ascending: true })
    .limit(500);

  return (data ?? []).map((p: any) => ({
    id: p.id,
    name: p.full_name || p.email || "Unnamed",
    email: p.email ?? "",
    teamName: p.role,
  }));
}

// ---------------------------------------------------------------------------
// Writing co-hosts
// ---------------------------------------------------------------------------
//
// Shared by createInvite (app/calls/actions.ts) and scheduleInterviewRequest
// (app/calls/interview-actions.ts), which put people on a call as it is
// booked, and addCallCohosts (app/calls/actions.ts), which adds them to one
// that already exists. Here rather than in any action file for the reason
// refundScholarshipCreditFor below gives: a helper exported from a "use
// server" file becomes a server action anyone can call with any ids.

export type ResolvedCohost = { id: string; name: string; role: string };

/**
 * Which kind of write a co-host list is for. Only what a database without
 * 0092 is TOLD differs: an invite being booked can go ahead without the extra
 * people, while adding people to a call that already exists cannot go ahead
 * at all — and "send the invite without them" would be advice about an
 * invite that was sent long ago.
 */
export type CohostWrite = "booking" | "existing";

function cohostSchemaMissingMessage(write: CohostWrite): string {
  return write === "booking"
    ? "Adding people from the team needs a database update (migration 0092) that hasn't been applied yet. Send the invite without them for now."
    : "Adding people to a call that's already booked needs a database update (migration 0092) that hasn't been applied yet. Until it is, a call has only the people it was booked with.";
}

/**
 * Check a host's co-host picks BEFORE the invite is written, and return them.
 *
 * Every id must be someone whose role may host calls (callStaffRoleSlugs) —
 * the picker only offers those, but the picker is not the boundary, exactly
 * as for the invitee. The host and the student are dropped rather than
 * refused (normalizeCohostIds).
 *
 * Also where a database without 0092 is caught: asking for co-hosts there
 * fails HERE, with a sentence a person can act on, before any invite exists —
 * not after the student has been emailed about a call that is missing half
 * its people. Asking for none never touches the table, so plain invites keep
 * working on that database.
 *
 * addCallCohosts passes "existing" as `write`, and only the people new to
 * the call (cohostsToAdd, which has already held them to the cap on the
 * call's total), so the same role rule covers everyone added later.
 */
export async function resolveCohosts(
  admin: ReturnType<typeof createAdminClient>,
  requested: readonly unknown[] | null | undefined,
  parties: { hostId: string; inviteeId: string },
  write: CohostWrite = "booking",
): Promise<ResolvedCohost[]> {
  const ids = normalizeCohostIds(requested, parties);
  if (ids.length === 0) return [];
  if (ids.length > MAX_CALL_COHOSTS) {
    throw new Error(
      `That's a lot of people for a 1:1. Add up to ${MAX_CALL_COHOSTS} from the team.`,
    );
  }

  const probe = await admin
    .from("call_invite_cohosts")
    .select("invite_id")
    .limit(1);
  if (probe.error) {
    if (isCohostSchemaMissing(probe.error)) {
      throw new Error(cohostSchemaMissingMessage(write));
    }
    throw new Error(probe.error.message);
  }

  const [{ data: rows, error }, staffRoles] = await Promise.all([
    admin.from("profiles").select("id, role, full_name").in("id", ids),
    callStaffRoleSlugs(),
  ]);
  if (error) throw new Error(error.message);
  const byId = new Map(((rows ?? []) as any[]).map((r) => [r.id as string, r]));
  const out: ResolvedCohost[] = [];
  for (const id of ids) {
    const r = byId.get(id);
    if (!r || !staffRoles.includes(r.role)) {
      throw new Error(
        "Only people whose role can host 1:1 calls can join one as part of the team.",
      );
    }
    out.push({ id, name: r.full_name || "A member of the team", role: r.role });
  }
  return out;
}

/**
 * Put the resolved co-hosts on a call that has just been written. Throws on
 * failure; the caller deletes the invite it wrote (the rows cascade), so a
 * call is never left with half its people.
 */
export async function attachCohosts(
  admin: ReturnType<typeof createAdminClient>,
  inviteId: string,
  cohosts: readonly ResolvedCohost[],
): Promise<void> {
  if (cohosts.length === 0) return;
  const { error } = await admin
    .from("call_invite_cohosts")
    .insert(cohosts.map((c) => ({ invite_id: inviteId, profile_id: c.id })));
  if (error) {
    if (isCohostSchemaMissing(error)) {
      throw new Error(cohostSchemaMissingMessage("booking"));
    }
    throw new Error(error.message);
  }
}

/**
 * Put resolved co-hosts on a call that ALREADY exists (addCallCohosts), and
 * return the ones this request actually added.
 *
 * `on conflict do nothing` rather than attachCohosts' plain insert, because
 * here the call already exists and anyone on it may be adding people too: two
 * people adding the same mentor at once, or one double-click, must converge
 * on the one row the primary key allows instead of failing whoever came
 * second. The rows that come back are
 * exactly the ones THIS statement inserted — a row that already existed is
 * skipped, not returned — so the request that lost such a race neither
 * notifies nor audits an add that someone else already made.
 *
 * Nothing to undo on failure: unlike a booking, the call was complete before
 * this ran, and a failed statement adds nobody.
 */
export async function addCohostRows(
  admin: ReturnType<typeof createAdminClient>,
  inviteId: string,
  cohosts: readonly ResolvedCohost[],
): Promise<ResolvedCohost[]> {
  if (cohosts.length === 0) return [];
  const { data, error } = await admin
    .from("call_invite_cohosts")
    .upsert(
      cohosts.map((c) => ({ invite_id: inviteId, profile_id: c.id })),
      { onConflict: "invite_id,profile_id", ignoreDuplicates: true },
    )
    .select("profile_id");
  if (error) {
    if (isCohostSchemaMissing(error)) {
      throw new Error(cohostSchemaMissingMessage("existing"));
    }
    // A foreign key: the call was deleted, or someone picked was, between
    // the checks and this write.
    if (error.code === "23503") {
      throw new Error(
        "That call, or someone you picked, no longer exists. Refresh the page and try again.",
      );
    }
    throw new Error(error.message);
  }
  const inserted = new Set(
    ((data ?? []) as any[]).map((r) => r.profile_id as string),
  );
  return cohosts.filter((c) => inserted.has(c.id));
}

/**
 * Where one staff member's own calls list lives, from their role — the page a
 * notification about a call should open for them. The student's is
 * /dashboard/calls; a mentor sent there is bounced to /mentor, and an admin
 * lands on a list of calls where they are the invitee — none — so the call
 * seems to vanish. (Same rule as the room's Back link: hostCallsHref.)
 */
export async function staffCallsHref(role: string | null | undefined): Promise<string> {
  const caps = await capabilitiesForRole(role ?? "student");
  return hostCallsHref({
    superAdmin: caps.superAdmin,
    mentorPanel: can(caps, "mentor.panel"),
    investorPanel: can(caps, "investor.panel"),
    canInvite: can(caps, "calls.invite"),
  });
}

/**
 * Tell co-hosts they are on a call. In-app only: the invite email is written
 * to the student, and the call is on each co-host's own calls page from now
 * on. Best-effort, like every notification in the calls actions.
 *
 * `addedByName` is for people added to a call that already exists
 * (addCallCohosts) by someone other than its host — another co-host, or an
 * admin stepping in — so the bell names both: who added you, and whose call
 * it is ("Ana added you to Ben's 1:1 with Sam"). Omitted, the host did it,
 * which is always the case for people put on a call as it is booked.
 */
export async function notifyCohostsAdded(
  cohosts: readonly ResolvedCohost[],
  call: {
    hostName: string;
    studentName: string;
    topic: string | null;
    addedByName?: string | null;
  },
): Promise<void> {
  if (cohosts.length === 0) return;
  const title = call.addedByName
    ? `${call.addedByName} added you to ${call.hostName}'s 1:1 with ${call.studentName}`
    : `${call.hostName} added you to a 1:1 with ${call.studentName}`;
  try {
    const links = await Promise.all(cohosts.map((c) => staffCallsHref(c.role)));
    await notifyMany(
      cohosts.map((c, i) => ({
        userId: c.id,
        type: "call_invited",
        title,
        body: call.topic || null,
        link: links[i],
      })),
    );
  } catch (err) {
    console.error("[calls] co-host notify failed", err);
  }
}

/**
 * Hand back the learner's-scholarship credit a call was booked with, if any.
 *
 * The credit is spent at SCHEDULE time (scheduleInterviewRequest), so a call
 * that then never happens — cancelled by the host, declined by the student,
 * or left unanswered until its time passed — would otherwise silently consume
 * one of three without the student ever having spoken to anyone.
 *
 * Callers invoke this only after THEIR conditional status update actually
 * changed a row. That is what makes it once-per-call: the update's status
 * guard lets exactly one transition out of a live status win, so a
 * double-clicked Cancel, a cancel racing a decline, or the call-lifecycle
 * sweep withdrawing an invite the host is withdrawing by hand, refunds once
 * rather than once per request.
 *
 * Here rather than in app/calls/actions.ts because the sweep needs it too, and
 * a helper exported from a "use server" file would itself become a server
 * action anyone could call with any invite id.
 *
 * Best-effort and tolerant: a database where 0071 hasn't run has no such
 * requests, and a failure here must not undo a cancellation that has already
 * happened.
 */
export async function refundScholarshipCreditFor(
  admin: ReturnType<typeof createAdminClient>,
  inviteId: string,
): Promise<void> {
  try {
    const { data: linked } = await admin
      .from("interview_requests")
      .select("id, scholarship_application_id")
      .eq("call_invite_id", inviteId)
      .maybeSingle();
    const scholarshipAppId = (linked as any)?.scholarship_application_id ?? null;
    if (scholarshipAppId) {
      const { refundCallCredit } = await import("@/lib/scholarships");
      await refundCallCredit(admin, scholarshipAppId);
    }
  } catch (err) {
    console.error("[calls] scholarship credit refund failed", err);
  }
}
