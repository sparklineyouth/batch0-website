import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { checkPendingMigrations, isFresh } from "@/lib/pending-migrations";
import { isMissingSchemaError } from "@/lib/schema-ready";

// Per server instance; a complete answer is reused for PROBE_TTL_MS.
let cached: { at: number; missing: string[] } | null = null;

/** Migrations from 0093–0100 this database is missing (see lib/pending-migrations.ts). */
export async function pendingMigrations(): Promise<string[]> {
  const now = Date.now();
  if (cached && isFresh(cached.at, now)) return cached.missing;
  const admin = createAdminClient();
  // GET, not a HEAD: a HEAD's error has no body to say "does not exist".
  // Schema probes read no rows (limit 0); a leftover probe needs at most one.
  const result = await checkPendingMigrations(async (p) => {
    let query = admin.from(p.table).select(p.columns);
    if (p.leftover) query = query.contains(p.leftover.column, [...p.leftover.values]);
    const { data, error } = await query.limit(p.leftover ? 1 : 0);
    return { error, found: (data?.length ?? 0) > 0 };
  });
  if (result.complete) cached = { at: now, missing: result.missing };
  return result.missing;
}

// Migration 0095 (recording takes), for the live rooms. Once seen it stays
// seen; "missing" is re-asked after a minute, so the rooms notice the
// migration soon after it runs.
let recordingsSeen = false;
let recordingsMissingAt = 0;
const RECORDINGS_RECHECK_MS = 60_000;

/**
 * Can rooms record yet (migration 0095)? Until then every take is refused,
 * so the green room must not tell anyone "this call is recorded". An error
 * other than "does not exist" answers yes: the recorder still reports its
 * own failure, and the room stays as it was.
 */
export async function recordingsReady(): Promise<boolean> {
  if (recordingsSeen) return true;
  if (Date.now() - recordingsMissingAt < RECORDINGS_RECHECK_MS) return false;
  const { error } = await createAdminClient().from("recording_sessions").select("id").limit(0);
  if (error && isMissingSchemaError(error)) {
    recordingsMissingAt = Date.now();
    return false;
  }
  if (!error) recordingsSeen = true;
  return true;
}
