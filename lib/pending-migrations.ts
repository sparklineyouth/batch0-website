/**
 * Which of the October 2026 migrations (0093–0100) this database is missing.
 *
 * Production gets the code before the migrations are run by hand, so the admin
 * overview shows one line until they are. Each probe reads one new table or
 * column with `limit 0`; a "does not exist" answer means its migration hasn't
 * run. 0097–0100 add no table or column (policies, defaults and data only), so
 * they are covered by the doc's verify queries, not by a probe.
 *
 * Pure: the only import is ./schema-ready.ts, so `node --test` runs it as-is.
 * lib/pending-migrations-server.ts runs the probes against the database.
 */
import { isMissingSchemaError } from "./schema-ready.ts";

export const MIGRATIONS_DOC = "docs/migrations-2026-10.md";

export const PENDING_MIGRATIONS_NOTICE = `Database update needed: run migrations 0093–0100 (${MIGRATIONS_DOC})`;

export type MigrationProbe = { migration: string; table: string; columns: string };

export const MIGRATION_PROBES: readonly MigrationProbe[] = [
  { migration: "0093", table: "course_assignments", columns: "id" },
  { migration: "0093", table: "course_assignment_targets", columns: "assignment_id" },
  { migration: "0093", table: "course_assignment_submissions", columns: "id" },
  { migration: "0094", table: "team_drive_links", columns: "id" },
  { migration: "0094", table: "pitch_submissions", columns: "deck_url" },
  { migration: "0095", table: "recording_sessions", columns: "id, end_reason, finalize_attempts" },
  { migration: "0096", table: "events", columns: "live_primary_host_id" },
];

/** How long one answer is trusted. */
export const PROBE_TTL_MS = 5 * 60_000;

export type ProbeOutcome = "ok" | "missing" | "unknown";

/** A probe's error → its outcome. Any other failure is "unknown", never "missing". */
export function classifyProbe(error: unknown): ProbeOutcome {
  if (!error) return "ok";
  return isMissingSchemaError(error) ? "missing" : "unknown";
}

export type PendingCheck = {
  /** Migrations with at least one probe that came back "does not exist". */
  missing: string[];
  /** False when some probe failed for another reason: don't cache it. */
  complete: boolean;
};

/**
 * Run every probe through `probe` (which resolves to the query's error, or
 * null) and summarise. A probe that throws counts as unknown.
 */
export async function checkPendingMigrations(
  probe: (table: string, columns: string) => Promise<unknown>,
  probes: readonly MigrationProbe[] = MIGRATION_PROBES,
): Promise<PendingCheck> {
  const outcomes = await Promise.all(
    probes.map(async (p) => {
      try {
        return { migration: p.migration, outcome: classifyProbe(await probe(p.table, p.columns)) };
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
