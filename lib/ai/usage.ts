import { createAdminClient } from "@/lib/supabase/admin";
import {
  thisMonthStartISODate,
  computeOverageCents,
  MONTHLY_HARD_CAP_CENTS,
  type TokenUsage,
} from "./pricing";

export type UsageRow = TokenUsage & {
  billed_cents: number;
  month_start: string;
};

const EMPTY: UsageRow = {
  input_tokens: 0,
  output_tokens: 0,
  cache_creation_tokens: 0,
  cache_read_tokens: 0,
  billed_cents: 0,
  month_start: "",
};

/** Reads the user's usage for the current calendar month. */
export async function getCurrentUsage(userId: string): Promise<UsageRow> {
  const admin = createAdminClient();
  const month = thisMonthStartISODate();
  const { data } = await admin
    .from("ai_usage")
    .select(
      "input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens, billed_cents, month_start",
    )
    .eq("user_id", userId)
    .eq("month_start", month)
    .maybeSingle();
  if (!data) return { ...EMPTY, month_start: month };
  return data as UsageRow;
}

/**
 * Atomically applies a usage delta:
 *   1) compute overage cents from before→after,
 *   2) upsert the rollup,
 *   3) (if any) issue a fee charge for the overage.
 *
 * Returns the new usage row + cents billed for this request (so the
 * caller can surface it to the user). Idempotent on a single execution
 * — the chat handler calls this once after a successful completion.
 */
export async function applyUsage(args: {
  userId: string;
  delta: TokenUsage;
}): Promise<{ usage: UsageRow; chargedCents: number }> {
  const admin = createAdminClient();
  const month = thisMonthStartISODate();
  const before = await getCurrentUsage(args.userId);

  const overage = computeOverageCents({ before, delta: args.delta });

  const next: UsageRow = {
    input_tokens: before.input_tokens + args.delta.input_tokens,
    output_tokens: before.output_tokens + args.delta.output_tokens,
    cache_creation_tokens:
      before.cache_creation_tokens + args.delta.cache_creation_tokens,
    cache_read_tokens:
      before.cache_read_tokens + args.delta.cache_read_tokens,
    billed_cents: before.billed_cents + overage,
    month_start: month,
  };

  await admin.from("ai_usage").upsert(
    {
      user_id: args.userId,
      month_start: month,
      input_tokens: next.input_tokens,
      output_tokens: next.output_tokens,
      cache_creation_tokens: next.cache_creation_tokens,
      cache_read_tokens: next.cache_read_tokens,
      billed_cents: next.billed_cents,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "user_id,month_start" },
  );

  let chargedCents = 0;
  if (overage > 0) {
    // Mint a fee charge so the student sees it on /dashboard/billing.
    // We batch by month: one charge per (user, month_start) is updated
    // in place rather than creating a charge per message.
    const { data: existingCharge } = await admin
      .from("user_charges")
      .select("id, amount_cents")
      .eq("user_id", args.userId)
      .eq("kind", "fee")
      .eq("status", "pending")
      .like("description", `AI usage overage · ${month}%`)
      .limit(1)
      .maybeSingle();
    if (existingCharge) {
      await admin
        .from("user_charges")
        .update({
          amount_cents:
            (existingCharge.amount_cents ?? 0) + overage,
        })
        .eq("id", existingCharge.id);
    } else {
      await admin.from("user_charges").insert({
        user_id: args.userId,
        kind: "fee",
        amount_cents: overage,
        description: `AI usage overage · ${month}`,
        status: "pending",
      });
    }
    chargedCents = overage;
  }

  return { usage: next, chargedCents };
}

/** True iff the user is past the hard monthly cap. Chat handler refuses
 *  further messages above this — protects against runaway loops. */
export async function isOverHardCap(userId: string): Promise<boolean> {
  const usage = await getCurrentUsage(userId);
  return usage.billed_cents >= MONTHLY_HARD_CAP_CENTS;
}
