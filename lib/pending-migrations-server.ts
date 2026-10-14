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
