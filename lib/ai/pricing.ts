// ----------------------------------------------------------------------------
// AI usage pricing + monthly quota.
//
// Free tier per student per calendar month is generous enough that
// realistic use fits inside it (~50 substantial conversations). Overage
// is billed at roughly 2× our raw model cost as a sustainable markup —
// once usage exits the free band, every subsequent request creates a
// fee charge on the student's account (existing user_charges flow).
// ----------------------------------------------------------------------------

export const MONTHLY_FREE_INPUT_TOKENS = 1_500_000;
export const MONTHLY_FREE_OUTPUT_TOKENS = 300_000;

// Cents per million tokens of OVERAGE (above the free tier).
// Sonnet 4.6 base ≈ $3/M input, $15/M output; we charge $6/$30 to cover
// caching wins + gateway overhead + a thin margin. Adjust here only.
export const OVERAGE_INPUT_PER_M_CENTS = 600;
export const OVERAGE_OUTPUT_PER_M_CENTS = 3000;

// Hard ceiling. If a single user racks up more than this in a single
// month, the chat handler refuses further messages and asks them to
// contact admins. Protects against a buggy / runaway client loop.
export const MONTHLY_HARD_CAP_CENTS = 5000; // $50

export function thisMonthStartISODate(): string {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1))
    .toISOString()
    .slice(0, 10);
}

export type TokenUsage = {
  input_tokens: number;
  output_tokens: number;
  cache_creation_tokens: number;
  cache_read_tokens: number;
};

/**
 * Computes the OVERAGE cost of a single request given the user's
 * usage *before* the request. Returns cents to charge for the request.
 * Cached input is free for the user (Anthropic discount); cache_read
 * is billed at 10% of normal input price → we pass that through.
 */
export function computeOverageCents(args: {
  before: TokenUsage;
  delta: TokenUsage;
}): number {
  const beforeBilledInput = Math.max(
    0,
    args.before.input_tokens - MONTHLY_FREE_INPUT_TOKENS,
  );
  const afterBilledInput = Math.max(
    0,
    args.before.input_tokens + args.delta.input_tokens - MONTHLY_FREE_INPUT_TOKENS,
  );
  const billableInput = Math.max(0, afterBilledInput - beforeBilledInput);

  const beforeBilledOutput = Math.max(
    0,
    args.before.output_tokens - MONTHLY_FREE_OUTPUT_TOKENS,
  );
  const afterBilledOutput = Math.max(
    0,
    args.before.output_tokens +
      args.delta.output_tokens -
      MONTHLY_FREE_OUTPUT_TOKENS,
  );
  const billableOutput = Math.max(
    0,
    afterBilledOutput - beforeBilledOutput,
  );

  const inputCents =
    (billableInput * OVERAGE_INPUT_PER_M_CENTS) / 1_000_000;
  const outputCents =
    (billableOutput * OVERAGE_OUTPUT_PER_M_CENTS) / 1_000_000;
  // Round up so the platform never under-charges on rounding.
  return Math.ceil(inputCents + outputCents);
}
