import type { SupabaseClient } from "@supabase/supabase-js";

// Batch/serial allocation for founder passes.
//
// Lives apart from lib/founder-pass.ts for the same reason
// lib/founder-pass-code.ts does: this module is imported by BOTH the Next app
// (app/api/admin/passes/mint) and the plain-node CLI (scripts/mint-cards.mts).
// founder-pass.ts imports through the "@/" alias, which only a bundler
// resolves — Node would fail on it. So anything the CLI shares has to stay
// dependency-free and alias-free, taking its Supabase client as an argument.
//
// The two callers MUST agree on which serial is next. If they drifted, the
// admin button and the CLI would hand out colliding serials and the unique
// index would reject one of them — after the slow Onshape work had run.

/**
 * Where the next batch should begin, and what to call it.
 *
 * Reads the high-water mark from founder_passes rather than trusting a caller.
 * serial is UNIQUE, so a wrong guess is a hard failure, and it used to fail
 * only after the Onshape leg — the worst possible moment to discover you
 * meant --start rather than --count.
 *
 * Batch names follow cards-NN and increment per run, so each print run stays
 * independently revocable: if one batch's code list leaks, that batch dies
 * without touching cards already in other people's wallets.
 *
 * Note this is advisory, not a reservation — two mints racing would compute the
 * same start. The unique index on serial is the real guard, and it makes the
 * loser fail cleanly rather than double-allocate. For one admin minting a
 * batch at a time, that's the right trade.
 */
export async function nextBatchDefaults(
  client: SupabaseClient,
): Promise<{ start: number; batch: string }> {
  const { data: maxRow } = await client
    .from("founder_passes")
    .select("serial")
    .order("serial", { ascending: false })
    .limit(1)
    .maybeSingle();
  const start = ((maxRow as { serial: number } | null)?.serial ?? 0) + 1;

  const { data: batchRows } = await client.from("founder_passes").select("batch");
  const numbers = ((batchRows ?? []) as Array<{ batch: string }>)
    .map((r) => /^cards-(\d+)$/.exec(r.batch)?.[1])
    .filter(Boolean)
    .map((n) => Number.parseInt(n as string, 10));
  const nextNum = (numbers.length ? Math.max(...numbers) : 0) + 1;

  return { start, batch: `cards-${String(nextNum).padStart(2, "0")}` };
}
