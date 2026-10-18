import type { SupabaseClient } from "@supabase/supabase-js";
import { addDays, easternDate } from "./assignments.ts";
import { isMissingSchemaError } from "./schema-ready.ts";
import { KICKOFF_COLUMNS, type KickoffRow } from "./kickoff.ts";
import { can, type Capabilities } from "./permissions.ts";
import {
  EDITOR_PERMISSION,
  cohortFileRefs,
  cohortReadiness,
  readinessApplies,
  type Bucket,
  type CohortReadiness,
  type ReadinessAssignment,
  type ReadinessEvent,
  type ReadinessModule,
  type ReadinessResource,
  type StoredFiles,
} from "./cohort-readiness.ts";

/**
 * Reads for the readiness checklist on /admin/cohorts (rules in
 * lib/cohort-readiness.ts). One query per table for every cohort on the page,
 * plus one storage round trip per bucket, so the page costs the same with one
 * cohort or five.
 *
 * Nothing here may take the cohorts page down: a failed or not-yet-migrated
 * table comes back null and its check says "Couldn't load", a read or a
 * storage call that hangs is given up on after a few seconds the same way,
 * and an unexpected throw leaves the page without checklists rather than
 * without cohorts.
 *
 * The client comes in as an argument and every import is relative, so
 * lib/cohort-readiness-load.test.ts runs this under `node --test` against a
 * fake client. Server code imports it through lib/cohort-readiness-server.ts.
 */

type Db = SupabaseClient<any, any, any>;

/** The cohort columns the checks read, as /admin/cohorts already selects them. */
export type ReadinessCohortRow = {
  id: string;
  name: string;
  status: string;
  starts_on: string | null;
  ends_on: string | null;
  capacity: number | null;
  price_cents: number | null;
  applications_close_at?: string | null;
  late_entry_until?: string | null;
  catch_up_plan?: string | null;
  enrollments?: { count: number }[];
};

// Storage takes a list of paths per signing call; 100 keeps each request
// small. A Winter-sized cohort has ~130 files.
export const SIGN_BATCH = 100;
// The URLs are thrown away — signing is only the existence test.
const SIGN_TTL_SECONDS = 60;

/**
 * How long the page waits on each read before that check says it couldn't
 * load. Postgres answers these in milliseconds; the limit is for an incident,
 * so admins can still change dates, prices and late entry while Storage (or
 * one slow query) is down.
 */
export const READINESS_TIMEOUTS = { readMs: 4_000, storageMs: 3_000 };

type Timeouts = typeof READINESS_TIMEOUTS;

const EVENT_COLUMNS = "id, cohort_id, title, visibility, live_mode, starts_at, ends_at, zoom_url, live_ended_at";

/** Resolves to null when `p` hasn't settled within `ms`. */
async function within<T>(p: PromiseLike<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve(p),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

type Query = PromiseLike<{ data: unknown; error: any }> & { abortSignal(signal: AbortSignal): Query };

async function rows<T>(label: string, query: Query, ms: number): Promise<T[] | null> {
  try {
    // The abort ends the request itself; postgrest reports it as an error.
    const { data, error } = await query.abortSignal(AbortSignal.timeout(ms));
    if (error) {
      if (!isMissingSchemaError(error)) console.error(`[cohort-readiness] ${label} read failed:`, error.message);
      return null;
    }
    return (data ?? []) as T[];
  } catch (e) {
    console.error(`[cohort-readiness] ${label} read failed:`, (e as Error).message);
    return null;
  }
}

/**
 * Which of `paths` exist in `bucket`, or null when storage couldn't answer.
 *
 * Signing is the same test the student pages run: the lesson page signs every
 * material in one batch and silently skips any path storage won't sign, and
 * a missing object is exactly such a path (its entry comes back with an error
 * and no URL). So "found" here means "a student would get this file".
 *
 * createSignedUrls takes no abort signal, so a hung bucket is raced against
 * a timer instead; the request it leaves behind is discarded when it ends.
 */
async function storedPaths(admin: Db, bucket: Bucket, paths: string[], ms: number): Promise<Set<string> | null> {
  const unique = [...new Set(paths)];
  if (unique.length === 0) return new Set();
  const chunks: string[][] = [];
  for (let i = 0; i < unique.length; i += SIGN_BATCH) chunks.push(unique.slice(i, i + SIGN_BATCH));
  try {
    const results = await within(
      Promise.all(chunks.map((chunk) => admin.storage.from(bucket).createSignedUrls(chunk, SIGN_TTL_SECONDS))),
      ms,
    );
    if (!results) {
      console.error(`[cohort-readiness] ${bucket} check timed out after ${ms}ms`);
      return null;
    }
    const found = new Set<string>();
    for (const { data, error } of results) {
      if (error || !data) {
        console.error(`[cohort-readiness] ${bucket} check failed:`, error?.message ?? "no data");
        return null;
      }
      for (const item of data) {
        if (item.path && item.signedUrl && !item.error) found.add(item.path);
      }
    }
    return found;
  } catch (e) {
    console.error(`[cohort-readiness] ${bucket} check failed:`, (e as Error).message);
    return null;
  }
}

/**
 * The instants every target cohort's sessions fall between, for the query
 * of events shared by all cohorts. Padded a day each way: dates are New York
 * days, and an evening session on the last day is already the next day in
 * UTC. Cohorts with no dates count from today, open-ended.
 */
export function sharedEventSpan(
  cohorts: readonly Pick<ReadinessCohortRow, "starts_on" | "ends_on">[],
  now: Date,
): { from: string; to: string | null } {
  const starts = cohorts.map((c) => c.starts_on ?? easternDate(now)).sort();
  const ends = cohorts.map((c) => c.ends_on);
  const last = ends.every((e): e is string => !!e) ? [...ends].sort()[ends.length - 1] : null;
  return {
    from: `${addDays(starts[0], -1)}T00:00:00Z`,
    to: last ? `${addDays(last, 2)}T00:00:00Z` : null,
  };
}

type ModuleRow = ReadinessModule & { cohort_id: string };
type CohortScoped<T> = T & { cohort_id: string | null };

function byCohort<T extends { cohort_id: string | null }>(list: T[] | null, id: string): T[] | null {
  return list ? list.filter((r) => r.cohort_id === id) : null;
}

/**
 * Checklists for the upcoming and active cohorts in `cohorts`, keyed by id.
 * Links are kept only for editors `caps` can open.
 */
export async function loadCohortReadiness(
  admin: Db,
  cohorts: readonly ReadinessCohortRow[],
  opts: { caps: Capabilities | null; now?: Date; timeouts?: Partial<Timeouts> },
): Promise<Record<string, CohortReadiness>> {
  const targets = cohorts.filter((c) => readinessApplies(c.status));
  if (targets.length === 0) return {};
  const ids = targets.map((c) => c.id);
  const now = opts.now ?? new Date();
  const { readMs, storageMs } = { ...READINESS_TIMEOUTS, ...opts.timeouts };

  try {
    const span = sharedEventSpan(targets, now);
    let shared = admin
      .from("events")
      .select(EVENT_COLUMNS)
      .is("cohort_id", null)
      .eq("visibility", "public")
      .gte("starts_at", span.from);
    if (span.to) shared = shared.lte("starts_at", span.to);

    const [modules, resources, assignments, ownEvents, sharedEvents, kickoffs] = await Promise.all([
      rows<ModuleRow>(
        "modules",
        admin
          .from("modules")
          .select(
            "id, cohort_id, week, title, position, lessons(id, title, position, description, video_path, video_url, materials)",
          )
          .in("cohort_id", ids),
        readMs,
      ),
      // Only the cohort's own resources: shared ones belong to every cohort.
      rows<CohortScoped<ReadinessResource>>(
        "resources",
        admin.from("resources").select("id, cohort_id, title, storage_path, external_url").in("cohort_id", ids),
        readMs,
      ),
      rows<CohortScoped<ReadinessAssignment>>(
        "course_assignments",
        admin
          .from("course_assignments")
          .select("id, cohort_id, title, status, module_id, lesson_id, week, opens_at, due_at")
          .in("cohort_id", ids)
          .neq("status", "archived"),
        readMs,
      ),
      rows<CohortScoped<ReadinessEvent>>(
        "events",
        admin.from("events").select(EVENT_COLUMNS).in("cohort_id", ids),
        readMs,
      ),
      // Students see every "Everyone signed in" event alongside their
      // cohort's own (getCohortEvents in lib/app-cache.ts), and a new one is
      // saved with no cohort, so shared office hours or a joint kickoff call
      // count for each cohort whose dates they fall in. A public event that
      // belongs to another cohort stays on that cohort's timetable.
      rows<CohortScoped<ReadinessEvent>>("shared events", shared, readMs),
      rows<KickoffRow & { cohort_id: string }>(
        "cohort_kickoff",
        admin.from("cohort_kickoff").select(`cohort_id, ${KICKOFF_COLUMNS}`).in("cohort_id", ids),
        readMs,
      ),
    ]);

    // Every file across every cohort on the page, one signing pass per bucket.
    const wanted: Record<Bucket, string[]> = { "course-materials": [], "course-videos": [], resources: [] };
    for (const id of ids) {
      const { refs } = cohortFileRefs(byCohort(modules, id), byCohort(resources, id));
      for (const r of refs) wanted[r.bucket].push(r.path);
    }
    const buckets = Object.keys(wanted) as Bucket[];
    const stored = await Promise.all(buckets.map((b) => storedPaths(admin, b, wanted[b], storageMs)));
    const files: StoredFiles = Object.fromEntries(buckets.map((b, i) => [b, stored[i]]));

    const kickoffById = new Map((kickoffs ?? []).map((k) => [k.cohort_id, k]));
    const canOpen = (editor: keyof typeof EDITOR_PERMISSION) => can(opts.caps, EDITOR_PERMISSION[editor]);

    const out: Record<string, CohortReadiness> = {};
    for (const c of targets) {
      const own = byCohort(ownEvents, c.id);
      out[c.id] = cohortReadiness({
        cohort: {
          id: c.id,
          name: c.name,
          status: c.status,
          starts_on: c.starts_on,
          ends_on: c.ends_on,
          capacity: c.capacity,
          price_cents: c.price_cents,
          applications_close_at: c.applications_close_at ?? null,
          late_entry_until: c.late_entry_until ?? null,
          catch_up_plan: c.catch_up_plan ?? null,
          enrolled: c.enrollments?.[0]?.count ?? 0,
        },
        modules: byCohort(modules, c.id),
        resources: byCohort(resources, c.id),
        assignments: byCohort(assignments, c.id),
        // Half a calendar would read as missing sessions, so either read
        // failing is "couldn't load".
        events: own && sharedEvents ? [...own, ...sharedEvents] : null,
        kickoff: kickoffs ? { row: kickoffById.get(c.id) ?? null } : null,
        files,
        now,
        canOpen,
      });
    }
    return out;
  } catch (e) {
    console.error("[cohort-readiness] failed:", (e as Error).message);
    return {};
  }
}
