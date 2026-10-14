import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { checkPendingMigrations, isFresh } from "@/lib/pending-migrations";

// Per server instance; a complete answer is reused for PROBE_TTL_MS.
let cached: { at: number; missing: string[] } | null = null;

/** Migrations from 0093–0100 this database is missing (see lib/pending-migrations.ts). */
export async function pendingMigrations(): Promise<string[]> {
  const now = Date.now();
  if (cached && isFresh(cached.at, now)) return cached.missing;
  const admin = createAdminClient();
  // GET with limit 0, not a HEAD: a HEAD's error has no body to say "does not exist".
  const result = await checkPendingMigrations(async (table, columns) => {
    const { error } = await admin.from(table).select(columns).limit(0);
    return error;
  });
  if (result.complete) cached = { at: now, missing: result.missing };
  return result.missing;
}
