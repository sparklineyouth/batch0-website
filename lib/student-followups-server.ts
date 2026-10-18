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
 * before the migration runs. Any other failure (a timeout, a 5xx, a names
 * read that errored) is `ready: false, failed: true`: callers say "couldn't
 * load", never "not set up" and never an empty list, because "nothing due"
 * is exactly what a reader would wrongly conclude from either.
 */

type Db = ReturnType<typeof createAdminClient>;

/** Short enough for a PostgREST `in` filter in a URL. */
const CHUNK = 100;

function chunks<T>(items: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += CHUNK) out.push(items.slice(i, i + CHUNK));
  return out;
}

/**
 * Why a read came back empty-handed. `failed: false` is "0107 isn't applied
 * here"; `failed: true` is any other error, which the page must say out loud.
 */
export type FollowUpReadState = { ready: true; failed: false } | { ready: false; failed: boolean };

const READY: FollowUpReadState = { ready: true, failed: false };

function notReady(where: string, error: unknown): FollowUpReadState {
  const missing = isMissingSchemaError(error);
  if (!missing) console.error(`[followups] ${where}`, (error as any)?.message ?? error);
  return { ready: false, failed: !missing };
}

function personName(p: { full_name: string | null; email: string | null } | undefined): string | null {
  if (!p) return null;
  return p.full_name?.trim() || displayEmail(p.email) || null;
}

/**
 * Names for every person the rows mention, in one round trip per chunk.
 * Throws when a read fails: a live student shown as "Deleted account", or an
 * owner as "Someone on the team", is a wrong answer, not a degraded one.
 */
async function names(admin: Db, rows: readonly FollowUpRow[]): Promise<Map<string, string | null>> {
  const ids = Array.from(
    new Set(rows.flatMap((r) => [r.student_id, r.owner_id, r.created_by, r.closed_by]).filter((x): x is string => !!x)),
  );
  const out = new Map<string, string | null>();
  await Promise.all(
    chunks(ids).map(async (part) => {
      const { data, error } = await admin.from("profiles").select("id, full_name, email").in("id", part);
      if (error) throw error;
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
): Promise<FollowUpReadState & { byStudent: Map<string, FollowUpView> }> {
  const admin = createAdminClient();
  const ids = Array.from(new Set(studentIds));
  try {
    if (ids.length === 0) {
      // Still ask, so an empty roster can tell "none yet" from "not set up".
      const { error } = await admin.from("student_followups").select("id").limit(0);
      if (error) throw error;
      return { ...READY, byStudent: new Map() };
    }
    const rows: FollowUpRow[] = [];
    for (const part of chunks(ids)) {
      const { data, error } = await admin
        .from("student_followups")
        .select(FOLLOWUP_COLUMNS)
        .eq("status", "open")
        .in("student_id", part);
      if (error) throw error;
      rows.push(...((data ?? []) as unknown as FollowUpRow[]));
    }
    const byStudent = new Map<string, FollowUpView>();
    for (const v of await views(admin, rows)) byStudent.set(v.studentId, v);
    return { ...READY, byStudent };
  } catch (error) {
    return { ...notReady("listActiveFollowUps", error), byStudent: new Map() };
  }
}

/** One student's open follow-up and the most recent closed ones (the drawer). */
export async function getFollowUpThread(
  studentId: string,
  opts: { history?: number } = {},
): Promise<FollowUpReadState & { active: FollowUpView | null; history: FollowUpView[] }> {
  const admin = createAdminClient();
  try {
    const { data, error } = await admin
      .from("student_followups")
      .select(FOLLOWUP_COLUMNS)
      .eq("student_id", studentId)
      .order("created_at", { ascending: false })
      .limit((opts.history ?? 5) + 1);
    if (error) throw error;
    const all = await views(admin, (data ?? []) as unknown as FollowUpRow[]);
    return {
      ...READY,
      active: all.find((v) => v.status === "open") ?? null,
      history: all.filter((v) => v.status !== "open").slice(0, opts.history ?? 5),
    };
  } catch (error) {
    return { ...notReady("getFollowUpThread", error), active: null, history: [] };
  }
}

/**
 * Open follow-ups whose next check is today or earlier (New York), most
 * overdue first — the attention list and the "Follow-ups due" list on
 * /admin/progress read this one function, so their counts agree.
 */
export async function listDueFollowUps(args: {
  today: string;
  limit: number;
}): Promise<FollowUpReadState & { total: number; rows: FollowUpView[] }> {
  const admin = createAdminClient();
  try {
    const { data, error, count } = await admin
      .from("student_followups")
      .select(FOLLOWUP_COLUMNS, { count: "exact" })
      .eq("status", "open")
      .lte("next_check_on", args.today)
      .order("next_check_on", { ascending: true })
      .order("created_at", { ascending: true })
      .limit(Math.max(1, args.limit));
    if (error) throw error;
    const rows = await views(admin, (data ?? []) as unknown as FollowUpRow[]);
    return { ...READY, total: count ?? rows.length, rows };
  } catch (error) {
    return { ...notReady("listDueFollowUps", error), total: 0, rows: [] };
  }
}

export type FollowUpOwner = { id: string; name: string };

/** Supabase's default max-rows: a page this long may have more behind it. */
const OWNER_PAGE = 1000;

/**
 * Who a follow-up can be given to: people whose role can change follow-ups
 * (followUpOwnerRoleSlugs). Derived from the role table, so a custom role
 * granted the keys at /admin/roles shows up without a deploy.
 *
 * Every one of them, a page at a time. It used to stop at 300, A–Z, so a
 * valid owner past that was missing from the drawer's picker — and, since a
 * save checked the owner against this same list, refused as someone who
 * "can't own follow-ups". Saves now check by id (getFollowUpOwner).
 */
export async function listFollowUpOwners(): Promise<FollowUpOwner[]> {
  const slugs = followUpOwnerRoleSlugs(await getAllRoles());
  if (slugs.length === 0) return [];
  const admin = createAdminClient();
  const out: FollowUpOwner[] = [];
  for (let from = 0; ; from += OWNER_PAGE) {
    const { data, error } = await admin
      .from("profiles")
      .select("id, full_name, email")
      .in("role", slugs)
      .order("full_name", { ascending: true })
      // A tiebreak, so two people with one name can't swap between pages.
      .order("id", { ascending: true })
      .range(from, from + OWNER_PAGE - 1);
    // Throws rather than returning nobody: an empty list would read as "no
    // one can own follow-ups", and a short one would hide whoever was cut.
    if (error) {
      console.error("[followups] listFollowUpOwners", error.message);
      throw new Error("Couldn't load who can own follow-ups. Try again.");
    }
    const page = (data ?? []) as any[];
    for (const p of page) out.push({ id: p.id as string, name: personName(p) ?? "Unnamed" });
    if (page.length < OWNER_PAGE) return out;
  }
}

/**
 * One person, if their role can own follow-ups (the same rule as
 * listFollowUpOwners); null if not, or if there's no such person. What
 * saveFollowUp checks the chosen owner with: one row by id, so how many
 * people can own follow-ups never decides whether this one may. Throws when
 * the read fails, rather than calling a valid owner invalid.
 */
export async function getFollowUpOwner(id: string): Promise<FollowUpOwner | null> {
  const slugs = followUpOwnerRoleSlugs(await getAllRoles());
  if (slugs.length === 0) return null;
  const { data, error } = await createAdminClient()
    .from("profiles")
    .select("id, full_name, email, role")
    .eq("id", id)
    .maybeSingle();
  if (error) {
    console.error("[followups] getFollowUpOwner", error.message);
    throw new Error("Couldn't check who can own follow-ups. Try again.");
  }
  const p = data as { id: string; full_name: string | null; email: string | null; role: string | null } | null;
  if (!p || !p.role || !slugs.includes(p.role)) return null;
  return { id: p.id, name: personName(p) ?? "Unnamed" };
}
