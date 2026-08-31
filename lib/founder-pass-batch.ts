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
 * Batch names follow <prefix>-NN and increment per run, so each run stays
 * independently revocable: if one batch's code list leaks, that batch dies
 * without touching cards already in other people's wallets.
 *
 * `prefix` exists so virtual passes (issued by email, migration 0054) number
 * their own runs — virtual-01, virtual-02 — while still drawing serials from
 * the SAME global sequence as printed cards. That split is deliberate in both
 * directions: one sequence because a serial identifies a pass and must never
 * name two of them, separate batch names because the two channels fail
 * differently. A leaked email thread should be revocable without killing a
 * print run, and vice versa.
 *
 * Note this is advisory, not a reservation — two mints racing would compute the
 * same start. The unique index on serial is the real guard, and it makes the
 * loser fail cleanly rather than double-allocate. For one admin minting a
 * batch at a time, that's the right trade.
 */
export async function nextBatchDefaults(
  client: SupabaseClient,
  prefix: string = "cards",
): Promise<{ start: number; batch: string }> {
  // Unfiltered on purpose: the serial high-water mark spans every kind of
  // pass. Scoping it to one prefix would let a virtual pass and a card be
  // issued the same serial, and the unique index would reject the second
  // *after* its Onshape export or its email had already gone out.
  const { data: maxRow } = await client
    .from("founder_passes")
    .select("serial")
    .order("serial", { ascending: false })
    .limit(1)
    .maybeSingle();
  const start = ((maxRow as { serial: number } | null)?.serial ?? 0) + 1;

  const pattern = new RegExp(`^${prefix.replace(/[^a-z0-9]/gi, "")}-(\\d+)$`);
  const { data: batchRows } = await client.from("founder_passes").select("batch");
  const numbers = ((batchRows ?? []) as Array<{ batch: string }>)
    .map((r) => pattern.exec(r.batch)?.[1])
    .filter(Boolean)
    .map((n) => Number.parseInt(n as string, 10));
  const nextNum = (numbers.length ? Math.max(...numbers) : 0) + 1;

  return { start, batch: `${prefix}-${String(nextNum).padStart(2, "0")}` };
}
