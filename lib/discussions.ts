import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { getAllRoles } from "@/lib/roles";
import { can, type Capabilities } from "@/lib/permissions";
import {
  canReadThread,
  type DiscussionStatus,
  type DiscussionViewer,
  type DiscussionVisibility,
} from "@/lib/discussions-access";

/**
 * Reads for discussion threads and replies (migration 0068).
 *
 * Service-role reads with explicit filters, the same shape as
 * lib/interview-requests.ts: RLS is the backstop, but every function here
 * scopes on the viewer it was given so the backstop is never what saves us.
 * The reason it can't be plain RLS: a student may only read their own
 * `profiles` row, and every list here needs the author's name on it.
 */

export type DiscussionThread = {
  id: string;
  cohortId: string | null;
  cohortName: string | null;
  authorId: string;
  authorName: string;
  /** Only surfaced on admin pages — never hand it to another student. */
  authorEmail: string;
  visibility: DiscussionVisibility;
  title: string;
  body: string;
  status: DiscussionStatus;
  isStaff: boolean;
  pinned: boolean;
  needsReply: boolean;
  replyCount: number;
  lastActivityAt: string;
  createdAt: string;
};

export type DiscussionReply = {
  id: string;
  threadId: string;
  authorId: string;
  authorName: string;
  authorEmail: string;
  body: string;
  isStaff: boolean;
  createdAt: string;
};

const THREAD_SELECT = `
  id, cohort_id, author_id, visibility, title, body, status, is_staff, pinned,
  needs_reply, reply_count, last_activity_at, created_at,
  author:profiles!discussion_threads_author_id_fkey(full_name, email),
  cohort:cohorts(name)
`;

const REPLY_SELECT = `
  id, thread_id, author_id, body, is_staff, created_at,
  author:profiles!discussion_replies_author_id_fkey(full_name, email)
`;

function one<T>(v: T | T[] | null | undefined): T | null {
  return Array.isArray(v) ? (v[0] ?? null) : (v ?? null);
}

/** A name to show. Never the email — a student's classmates don't get that. */
function displayName(p: { full_name?: string | null } | null): string {
  return p?.full_name?.trim() || "A batch0 founder";
}

function toThread(row: any): DiscussionThread {
  const author = one<any>(row.author);
  const cohort = one<any>(row.cohort);
  return {
    id: row.id,
    cohortId: row.cohort_id,
    cohortName: cohort?.name ?? null,
    authorId: row.author_id,
    authorName: displayName(author),
    authorEmail: author?.email ?? "",
    visibility: row.visibility,
    title: row.title,
    body: row.body,
    status: row.status,
    isStaff: !!row.is_staff,
    pinned: !!row.pinned,
    needsReply: !!row.needs_reply,
    replyCount: row.reply_count ?? 0,
    lastActivityAt: row.last_activity_at,
    createdAt: row.created_at,
  };
}

function toReply(row: any): DiscussionReply {
  const author = one<any>(row.author);
  return {
    id: row.id,
    threadId: row.thread_id,
    authorId: row.author_id,
    authorName: displayName(author),
    authorEmail: author?.email ?? "",
    body: row.body,
    isStaff: !!row.is_staff,
    createdAt: row.created_at,
  };
}

/** Strip the fields a student must not see about another student. */
export function forStudent<T extends { authorEmail: string }>(
  x: T,
): Omit<T, "authorEmail"> {
  const { authorEmail: _drop, ...rest } = x;
  return rest;
}

// ---------------------------------------------------------------------------
// Viewer
// ---------------------------------------------------------------------------

/** Every cohort this user is enrolled in. */
export async function listEnrolledCohortIds(userId: string): Promise<string[]> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("enrollments")
    .select("cohort_id")
    .eq("user_id", userId);
  return (data ?? []).map((r: any) => r.cohort_id as string).filter(Boolean);
}

/** The shape every read below scopes on. */
export async function getDiscussionViewer(
  userId: string,
  caps: Capabilities | null,
): Promise<DiscussionViewer> {
  return {
    userId,
    manages: can(caps, "discussions.manage"),
    cohortIds: await listEnrolledCohortIds(userId),
  };
}

/**
 * A cohort's display name. StudentAccess.cohortName is pre-cohort-only by
 * contract (lib/access.ts), so a mid-cohort page resolves the name here.
 */
export async function getCohortName(cohortId: string | null): Promise<string | null> {
  if (!cohortId) return null;
  const admin = createAdminClient();
  const { data } = await admin
    .from("cohorts")
    .select("name")
    .eq("id", cohortId)
    .maybeSingle();
  return (data as any)?.name ?? null;
}

// ---------------------------------------------------------------------------
// Student-facing reads
// ---------------------------------------------------------------------------

/**
 * The cohort board: every `cohort` thread in the cohorts the viewer belongs
 * to. Pinned first, then by most recent activity.
 */
export async function listCohortThreads(
  cohortIds: readonly string[],
  limit = 100,
): Promise<DiscussionThread[]> {
  if (cohortIds.length === 0) return [];
  const admin = createAdminClient();
  const { data } = await admin
    .from("discussion_threads")
    .select(THREAD_SELECT)
    .eq("visibility", "cohort")
    .in("cohort_id", cohortIds as string[])
    .order("pinned", { ascending: false })
    .order("last_activity_at", { ascending: false })
    .limit(limit);
  return (data ?? []).map(toThread);
}

/** The private questions this student has asked the team. */
export async function listOwnQuestions(
  userId: string,
): Promise<DiscussionThread[]> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("discussion_threads")
    .select(THREAD_SELECT)
    .eq("visibility", "admin")
    .eq("author_id", userId)
    .order("last_activity_at", { ascending: false })
    .limit(100);
  return (data ?? []).map(toThread);
}

/**
 * One thread, or null when it doesn't exist OR the viewer may not read it.
 * The two cases are deliberately indistinguishable: a private question must
 * not confirm its existence to anyone but its author and the team.
 */
export async function getThreadForViewer(
  id: string,
  viewer: DiscussionViewer,
): Promise<DiscussionThread | null> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("discussion_threads")
    .select(THREAD_SELECT)
    .eq("id", id)
    .maybeSingle();
  if (!data) return null;
  const thread = toThread(data);
  return canReadThread(
    { visibility: thread.visibility, cohortId: thread.cohortId, authorId: thread.authorId },
    viewer,
  )
    ? thread
    : null;
}

/** Replies in posting order. Only call after getThreadForViewer() passed. */
export async function listReplies(threadId: string): Promise<DiscussionReply[]> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("discussion_replies")
    .select(REPLY_SELECT)
    .eq("thread_id", threadId)
    .order("created_at", { ascending: true })
    .limit(500);
  return (data ?? []).map(toReply);
}

// ---------------------------------------------------------------------------
// Team-facing reads (callers hold discussions.manage)
// ---------------------------------------------------------------------------

export type TeamThreadFilter = {
  visibility: DiscussionVisibility;
  cohortId?: string | null;
  /** Private questions only: restrict to those waiting on the team. */
  needsReply?: boolean;
  status?: DiscussionStatus;
  limit?: number;
};

export async function listThreadsForTeam(
  f: TeamThreadFilter,
): Promise<DiscussionThread[]> {
  const admin = createAdminClient();
  let q = admin
    .from("discussion_threads")
    .select(THREAD_SELECT)
    .eq("visibility", f.visibility);
  if (f.cohortId) q = q.eq("cohort_id", f.cohortId);
  if (f.needsReply != null) q = q.eq("needs_reply", f.needsReply);
  if (f.status) q = q.eq("status", f.status);
  const { data } = await q
    .order("pinned", { ascending: false })
    .order("last_activity_at", { ascending: false })
    .limit(f.limit ?? 200);
  return (data ?? []).map(toThread);
}

/** The admin overview tile: private questions still waiting on a reply. */
export async function countQuestionsNeedingReply(): Promise<number> {
  const admin = createAdminClient();
  const { count } = await admin
    .from("discussion_threads")
    .select("id", { count: "exact", head: true })
    .eq("visibility", "admin")
    .eq("needs_reply", true);
  return count ?? 0;
}

/**
 * Everyone who should hear about a new question: holders of
 * discussions.manage, plus every '*' role. Mirrors listInterviewTeamIds().
 */
export async function listDiscussionTeamIds(): Promise<string[]> {
  const roles = await getAllRoles();
  const slugs = roles
    .filter(
      (r) => r.permissions.includes("*") || r.permissions.includes("discussions.manage"),
    )
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

/** Distinct reply authors on a thread, for "someone replied" fan-out. */
export async function listParticipantIds(threadId: string): Promise<string[]> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("discussion_replies")
    .select("author_id")
    .eq("thread_id", threadId)
    .limit(500);
  return Array.from(new Set((data ?? []).map((r: any) => r.author_id as string)));
}
