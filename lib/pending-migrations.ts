/**
 * Which of the October 2026 migrations (0093–0100) this database is missing.
 *
 * Production gets the code before the migrations are run by hand, so the admin
 * overview shows one line while any probe says one is missing. Two kinds:
 *
 *   - schema: read one new table or column with `limit 0`; "does not exist"
 *     means its migration hasn't run (0093–0096).
 *   - leftover: look for one row the migration removes; finding one means it
 *     hasn't run (0099 and 0100 strip retired permission keys from roles).
 *
 * The policy changes in 0097–0099 leave nothing PostgREST can see, so only
 * the doc's verify queries confirm those. A database with no leftover rows
 * reads as up to date for 0099/0100, which is right: there is nothing to fix.
 *
 * Pure: the only import is ./schema-ready.ts, so `node --test` runs it as-is.
 * lib/pending-migrations-server.ts runs the probes against the database.
 */
import { isMissingSchemaError } from "./schema-ready.ts";

export const MIGRATIONS_DOC = "docs/migrations-2026-10.md";

export const PENDING_MIGRATIONS_NOTICE = `Database update needed: run migrations 0093–0100 (${MIGRATIONS_DOC})`;

export type MigrationProbe = {
  migration: string;
  table: string;
  columns: string;
  /** A leftover probe: a row whose `column` contains every one of `values`. */
  leftover?: { column: string; values: readonly string[] };
};

export const MIGRATION_PROBES: readonly MigrationProbe[] = [
  { migration: "0093", table: "course_assignments", columns: "id" },
  { migration: "0093", table: "course_assignment_targets", columns: "assignment_id" },
  { migration: "0093", table: "course_assignment_submissions", columns: "id" },
  { migration: "0094", table: "team_drive_links", columns: "id" },
  { migration: "0094", table: "pitch_submissions", columns: "deck_url" },
  { migration: "0095", table: "recording_sessions", columns: "id, end_reason, finalize_attempts" },
  { migration: "0096", table: "events", columns: "live_primary_host_id" },
  {
    migration: "0099",
    table: "app_roles",
    columns: "slug",
    leftover: { column: "permissions", values: ["discussions.manage"] },
  },
  {
    migration: "0100",
    table: "app_roles",
    columns: "slug",
    leftover: { column: "permissions", values: ["ai_usage.view"] },
  },
];

/** What one probe saw: the query's error, and whether a leftover row came back. */
export type ProbeResult = { error: unknown; found?: boolean };

/** How long one answer is trusted. */
export const PROBE_TTL_MS = 5 * 60_000;

export type ProbeOutcome = "ok" | "missing" | "unknown";

/**
 * A probe's answer → its outcome. An error other than "does not exist" is
 * "unknown", never "missing"; a leftover row is "missing".
 */
export function classifyProbe(error: unknown, found = false): ProbeOutcome {
  if (error) return isMissingSchemaError(error) ? "missing" : "unknown";
  return found ? "missing" : "ok";
}

export type PendingCheck = {
  /** Migrations with at least one probe that came back "does not exist". */
  missing: string[];
  /** False when some probe failed for another reason: don't cache it. */
  complete: boolean;
};

/**
 * Run every probe through `probe` and summarise. A probe that throws counts
 * as unknown.
 */
export async function checkPendingMigrations(
  probe: (p: MigrationProbe) => Promise<ProbeResult>,
  probes: readonly MigrationProbe[] = MIGRATION_PROBES,
): Promise<PendingCheck> {
  const outcomes = await Promise.all(
    probes.map(async (p) => {
      try {
        const r = await probe(p);
        return { migration: p.migration, outcome: classifyProbe(r.error, r.found) };
      } catch {
        return { migration: p.migration, outcome: "unknown" as const };
      }
    }),
  );
  const missing = [...new Set(outcomes.filter((o) => o.outcome === "missing").map((o) => o.migration))].sort();
  return { missing, complete: outcomes.every((o) => o.outcome !== "unknown") };
}

/** A cached answer is still good. */
export function isFresh(checkedAt: number, now: number, ttlMs: number = PROBE_TTL_MS): boolean {
  return now >= checkedAt && now - checkedAt < ttlMs;
}
