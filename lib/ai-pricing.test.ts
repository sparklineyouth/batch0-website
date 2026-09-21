import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MONTHLY_FREE_INPUT_TOKENS,
  MONTHLY_FREE_OUTPUT_TOKENS,
  OVERAGE_INPUT_PER_M_CENTS,
  OVERAGE_OUTPUT_PER_M_CENTS,
  freeAllowance,
  computeOverageCents,
  type TokenUsage,
} from "./ai/pricing.ts";

// The overage math bills students silently, per message, months after the
// free band was set — so the band's width and the moment it's crossed are
// worth pinning. The scholarship AI boost (migration 0074) widens the band;
// this is where "2×" has to mean exactly 2×.
//
// Pure module, no database, no environment.

const usage = (input: number, output: number): TokenUsage => ({
  input_tokens: input,
  output_tokens: output,
  cache_creation_tokens: 0,
  cache_read_tokens: 0,
});

test("the standard allowance is the constants, untouched", () => {
  assert.deepEqual(freeAllowance(), {
    input: MONTHLY_FREE_INPUT_TOKENS,
    output: MONTHLY_FREE_OUTPUT_TOKENS,
  });
  assert.deepEqual(freeAllowance(1), freeAllowance());
});

test("a boost multiplies both halves of the allowance", () => {
  const boosted = freeAllowance(2);
  assert.equal(boosted.input, MONTHLY_FREE_INPUT_TOKENS * 2);
  assert.equal(boosted.output, MONTHLY_FREE_OUTPUT_TOKENS * 2);
});

test("a broken multiplier narrows nothing and widens nothing", () => {
  // The safe reading of "couldn't tell" is the standard band, never a
  // narrower one (that would bill someone early) and never a wider one.
  assert.deepEqual(freeAllowance(0), freeAllowance());
  assert.deepEqual(freeAllowance(-3), freeAllowance());
  assert.deepEqual(freeAllowance(Number.NaN), freeAllowance());
  assert.deepEqual(freeAllowance(0.5), freeAllowance());
});

test("nothing is billed inside the free band", () => {
  const before = usage(0, 0);
  const delta = usage(MONTHLY_FREE_INPUT_TOKENS, MONTHLY_FREE_OUTPUT_TOKENS);
  assert.equal(computeOverageCents({ before, delta }), 0);
});

test("the first token past the band is billed, and only that token", () => {
  const before = usage(MONTHLY_FREE_INPUT_TOKENS, 0);
  // One million input tokens over → exactly the per-million rate.
  const delta = usage(1_000_000, 0);
  assert.equal(computeOverageCents({ before, delta }), OVERAGE_INPUT_PER_M_CENTS);
  const outBefore = usage(0, MONTHLY_FREE_OUTPUT_TOKENS);
  assert.equal(
    computeOverageCents({ before: outBefore, delta: usage(0, 1_000_000) }),
    OVERAGE_OUTPUT_PER_M_CENTS,
  );
});

test("a boosted student is not billed where a standard student would be", () => {
  // Sitting exactly at the standard ceiling, the next million tokens cost a
  // standard student the full rate and a boosted one nothing.
  const before = usage(MONTHLY_FREE_INPUT_TOKENS, MONTHLY_FREE_OUTPUT_TOKENS);
  const delta = usage(1_000_000, 100_000);
  assert.ok(computeOverageCents({ before, delta }) > 0);
  assert.equal(computeOverageCents({ before, delta, freeMultiplier: 2 }), 0);
});

test("a boosted student is billed once they pass the WIDER band", () => {
  const wide = freeAllowance(2);
  const before = usage(wide.input, wide.output);
  const delta = usage(1_000_000, 0);
  assert.equal(
    computeOverageCents({ before, delta, freeMultiplier: 2 }),
    OVERAGE_INPUT_PER_M_CENTS,
  );
});

test("crossing the band mid-request bills only the part that's over", () => {
  const before = usage(MONTHLY_FREE_INPUT_TOKENS - 500_000, 0);
  const delta = usage(1_500_000, 0); // 500K inside, 1M over
  assert.equal(computeOverageCents({ before, delta }), OVERAGE_INPUT_PER_M_CENTS);
});
