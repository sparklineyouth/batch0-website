import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { getAllRoles } from "@/lib/roles";
import { isMissingSchemaError } from "@/lib/schema-ready";
import { displayEmail } from "@/lib/placeholder-email";
import {
  FOLLOWUP_COLUMNS,
  followUpOwnerRoleSlugs,
  type FollowUpRow,
  type FollowUpView,
} from "@/lib/student-followups";

/**
 * Reads for student follow-ups (migration 0107). Service-role: the table has
 * no client policies at all, so every caller is a page or action that has
 * already checked people.view (lib/student-followups.ts says who may write).
 *
 * Every read tolerates 0107 not being applied yet: callers get
 * `ready: false` and render "not set up yet" — production gets this code
 * before the migration runs.
 */

type Db = ReturnType<typeof createAdminClient>;

/** Short enough for a PostgREST `in` filter in a URL. */
const CHUNK = 100;

function chunks<T>(items: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += CHUNK) out.push(items.slice(i, i + CHUNK));
  return out;
}

function failed(where: string, error: unknown): { ready: false } {
  if (!isMissingSchemaError(error)) console.error(`[followups] ${where}`, (error as any)?.message ?? error);
  return { ready: false };
}

function personName(p: { full_name: string | null; email: string | null } | undefined): string | null {
  if (!p) return null;
  return p.full_name?.trim() || displayEmail(p.email) || null;
}

/** Names for every person the rows mention, in one round trip per chunk. */
async function names(admin: Db, rows: readonly FollowUpRow[]): Promise<Map<string, string | null>> {
  const ids = Array.from(
    new Set(rows.flatMap((r) => [r.student_id, r.owner_id, r.created_by, r.closed_by]).filter((x): x is string => !!x)),
  );
  const out = new Map<string, string | null>();
  await Promise.all(
    chunks(ids).map(async (part) => {
      const { data, error } = await admin.from("profiles").select("id, full_name, email").in("id", part);
      if (error) console.error("[followups] names", error.message);
      for (const p of (data ?? []) as any[]) out.set(p.id, personName(p));
    }),
  );
  return out;
}

function toView(r: FollowUpRow, who: Map<string, string | null>): FollowUpView {
  return {
    id: r.id,
    studentId: r.student_id,
    studentName: who.get(r.student_id) ?? "Deleted account",
    ownerId: r.owner_id,
    ownerName: r.owner_id ? (who.get(r.owner_id) ?? "Someone on the team") : null,
    nextCheckOn: r.next_check_on,
    note: r.note,
    status: r.status,
    closingNote: r.closing_note,
    createdByName: r.created_by ? (who.get(r.created_by) ?? null) : null,
    createdAt: r.created_at,
    closedByName: r.closed_by ? (who.get(r.closed_by) ?? null) : null,
    closedAt: r.closed_at,
    updatedAt: r.updated_at,
  };
}

async function views(admin: Db, rows: FollowUpRow[]): Promise<FollowUpView[]> {
  if (rows.length === 0) return [];
  const who = await names(admin, rows);
  return rows.map((r) => toView(r, who));
}

/** The open follow-up of each of these students (the roster's column). */
export async function listActiveFollowUps(
  studentIds: readonly string[],
): Promise<{ ready: boolean; byStudent: Map<string, FollowUpView> }> {
  const admin = createAdminClient();
  const byStudent = new Map<string, FollowUpView>();
  const ids = Array.from(new Set(studentIds));
  if (ids.length === 0) {
    // Still ask, so an empty roster can tell "none yet" from "not set up".
    const { error } = await admin.from("student_followups").select("id").limit(0);
    return error ? { ...failed("listActiveFollowUps", error), byStudent } : { ready: true, byStudent };
  }
  const rows: FollowUpRow[] = [];
  for (const part of chunks(ids)) {
    const { data, error } = await admin
      .from("student_followups")
      .select(FOLLOWUP_COLUMNS)
      .eq("status", "open")
      .in("student_id", part);
    if (error) return { ...failed("listActiveFollowUps", error), byStudent };
    rows.push(...((data ?? []) as unknown as FollowUpRow[]));
  }
  for (const v of await views(admin, rows)) byStudent.set(v.studentId, v);
  return { ready: true, byStudent };
}

/** One student's open follow-up and the most recent closed ones (the drawer). */
export async function getFollowUpThread(
  studentId: string,
  opts: { history?: number } = {},
): Promise<{ ready: boolean; active: FollowUpView | null; history: FollowUpView[] }> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("student_followups")
    .select(FOLLOWUP_COLUMNS)
    .eq("student_id", studentId)
    .order("created_at", { ascending: false })
    .limit((opts.history ?? 5) + 1);
  if (error) return { ...failed("getFollowUpThread", error), active: null, history: [] };
  const all = await views(admin, (data ?? []) as unknown as FollowUpRow[]);
  return {
    ready: true,
    active: all.find((v) => v.status === "open") ?? null,
    history: all.filter((v) => v.status !== "open").slice(0, opts.history ?? 5),
  };
}

/**
 * Open follow-ups whose next check is today or earlier (New York), most
 * overdue first — the attention list and the "Follow-ups due" list on
 * /admin/progress read this one function, so their counts agree.
 */
export async function listDueFollowUps(args: {
  today: string;
  limit: number;
}): Promise<{ ready: boolean; total: number; rows: FollowUpView[] }> {
  const admin = createAdminClient();
  const { data, error, count } = await admin
    .from("student_followups")
    .select(FOLLOWUP_COLUMNS, { count: "exact" })
    .eq("status", "open")
    .lte("next_check_on", args.today)
    .order("next_check_on", { ascending: true })
    .order("created_at", { ascending: true })
    .limit(Math.max(1, args.limit));
  if (error) return { ...failed("listDueFollowUps", error), total: 0, rows: [] };
  const rows = await views(admin, (data ?? []) as unknown as FollowUpRow[]);
  return { ready: true, total: count ?? rows.length, rows };
}

export type FollowUpOwner = { id: string; name: string };

/**
 * Who a follow-up can be given to: people whose role can change follow-ups
 * (followUpOwnerRoleSlugs). Derived from the role table, so a custom role
 * granted the keys at /admin/roles shows up without a deploy.
 */
export async function listFollowUpOwners(): Promise<FollowUpOwner[]> {
  const slugs = followUpOwnerRoleSlugs(await getAllRoles());
  if (slugs.length === 0) return [];
  const { data, error } = await createAdminClient()
    .from("profiles")
    .select("id, full_name, email")
    .in("role", slugs)
    .order("full_name", { ascending: true })
    .limit(300);
  if (error) console.error("[followups] listFollowUpOwners", error.message);
  return ((data ?? []) as any[]).map((p) => ({ id: p.id as string, name: personName(p) ?? "Unnamed" }));
}
