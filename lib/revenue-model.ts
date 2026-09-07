// ----------------------------------------------------------------------------
// Tuition revenue model — a demand curve fitted to our own funnel.
//
// This is decision support, not a crystal ball, and the whole thing turns on
// ONE assumption that we cannot measure from a single price point: how
// sensitive applicants are to tuition (price elasticity of demand). Everything
// else here is real — the number of applicants we accept, the fraction who
// then pay, the seats we have to sell — so the model is honest about which
// inputs are observed and which one is assumed, and it puts the assumed one on
// a slider in the UI rather than burying a magic number in code.
//
// The shape of the model, in one paragraph:
//
//   • We know, from our data, how many applicants we ACCEPT and how many of
//     them PAY at today's price. That ratio is today's conversion rate.
//   • As price falls, conversion rises; as it rises, conversion falls. We model
//     that with a constant-elasticity curve anchored on today's point, so at
//     today's price the model reproduces exactly what we observed.
//   • Conversion can't exceed 100% (you can't enrol more people than you
//     accepted) and paying students can't exceed CAPACITY (you can't sell more
//     seats than exist). Those two caps are what create a well-defined
//     revenue-maximising price: below it you're leaving money on every filled
//     seat, above it empty seats start to cost more than the higher price wins.
//
// Pure and dependency-free so it can be unit-tested and run on the client for a
// live "what if I move the slider" recompute.
// ----------------------------------------------------------------------------

export type RevenueModelInput = {
  /**
   * The price we charge today, in cents — the anchor the curve passes through.
   * Use the price a typical applicant actually pays (list, or the promo price
   * if a promo is running), not a regional override.
   */
  referencePriceCents: number;
  /**
   * How many applicants have PAID at the reference price. The observed
   * quantity the curve is pinned to.
   */
  referenceConversions: number;
  /**
   * How many applicants we've ACCEPTED — the addressable pool that could
   * convert. Today's conversion rate is referenceConversions / acceptedPool.
   * When we have no accept data yet, the model falls back to treating the
   * paying students as the whole pool (a 100% reference rate).
   */
  acceptedPool: number;
  /** Seats available. Paying students are capped here — you can't oversell. */
  capacity: number;
  /**
   * Price elasticity of demand: the % change in quantity for a 1% change in
   * price. Negative by definition. This is the ONE assumed input. Around −1 is
   * unit-elastic; more negative (e.g. −1.8) means applicants are more
   * price-sensitive; closer to 0 (e.g. −0.5) means less.
   */
  elasticity: number;
};

export type RevenuePoint = {
  priceCents: number;
  /** Projected paying students after the conversion and capacity caps. */
  students: number;
  revenueCents: number;
  /** students / capacity, clamped to [0, 1]. */
  fillRate: number;
};

export type RevenueModel = {
  /** The demand/revenue curve, ascending by price, for charting. */
  curve: RevenuePoint[];
  /** The revenue-maximising point on the curve. */
  optimum: RevenuePoint;
  /** Where we are today — the point the curve is anchored on. */
  referencePoint: RevenuePoint;
  /** Echoed back so the UI can state exactly what it assumed. */
  assumptions: {
    referenceRate: number;
    acceptedPool: number;
    capacity: number;
    elasticity: number;
    minPriceCents: number;
    maxPriceCents: number;
  };
};

/**
 * Effective, resolved pool and reference rate.
 *
 * Kept separate because the fallbacks matter: with no accept data (a brand-new
 * cohort) we can't compute a conversion rate, so we anchor on a 100% reference
 * rate over a pool equal to whatever has paid — degenerate but stable, and the
 * UI flags that it's running on thin data.
 */
function resolvePool(input: RevenueModelInput): {
  pool: number;
  referenceRate: number;
} {
  const paid = Math.max(0, input.referenceConversions);
  // The pool must be at least the number who paid (you can't have converted
  // more people than were in the pool) and at least 1 (avoid /0).
  const pool = Math.max(1, input.acceptedPool, paid);
  const referenceRate = Math.min(1, paid / pool);
  return { pool, referenceRate };
}

/**
 * Projected paying students at a given price, after both caps.
 *
 * Exported for the UI's live tooltip. Returns a float; round only for display.
 */
export function projectedStudents(
  input: RevenueModelInput,
  priceCents: number,
): number {
  if (input.referencePriceCents <= 0 || priceCents <= 0) return 0;
  const { pool, referenceRate } = resolvePool(input);
  const ratio = priceCents / input.referencePriceCents;
  // Constant-elasticity conversion, anchored so ratio=1 → referenceRate.
  const rate = referenceRate * Math.pow(ratio, input.elasticity);
  const cappedRate = Math.min(1, Math.max(0, rate));
  const demand = pool * cappedRate;
  return Math.min(demand, Math.max(0, input.capacity));
}

function pointAt(input: RevenueModelInput, priceCents: number): RevenuePoint {
  const students = projectedStudents(input, priceCents);
  const capacity = Math.max(0, input.capacity);
  return {
    priceCents,
    students,
    revenueCents: priceCents * students,
    fillRate: capacity > 0 ? Math.min(1, students / capacity) : 0,
  };
}

export type BuildOptions = {
  /** Lowest price to consider, cents. Default $10. */
  minPriceCents?: number;
  /**
   * Highest price to consider, cents. Default 3× the reference price — beyond
   * that the constant-elasticity form stops being trustworthy anyway.
   */
  maxPriceCents?: number;
  /** How many points on the curve. Default 120. */
  steps?: number;
};

/**
 * Build the full curve and locate the revenue-maximising price.
 *
 * The optimum is found by scanning the grid, not by calculus: the caps make the
 * revenue function piecewise and non-smooth, so a dense scan is both simpler
 * and more robust than trying to solve dR/dp = 0 across the kinks. Grid
 * resolution is the only thing that bounds how precise the optimum is, which is
 * why the price is rounded to whole dollars for the recommendation.
 */
export function buildRevenueModel(
  input: RevenueModelInput,
  opts: BuildOptions = {},
): RevenueModel {
  const ref = Math.max(1, Math.round(input.referencePriceCents));
  const minPriceCents = Math.max(100, opts.minPriceCents ?? 1000);
  const maxPriceCents = Math.max(
    ref + 100,
    opts.maxPriceCents ?? ref * 3,
  );
  const steps = Math.max(2, opts.steps ?? 120);

  const curve: RevenuePoint[] = [];
  let optimum: RevenuePoint | null = null;
  for (let i = 0; i < steps; i++) {
    const t = i / (steps - 1);
    // Round each grid price to a whole dollar so the chart's x-axis and the
    // recommended price are the same kind of number a human would set.
    const priceCents =
      Math.round((minPriceCents + t * (maxPriceCents - minPriceCents)) / 100) *
      100;
    const point = pointAt(input, priceCents);
    curve.push(point);
    if (!optimum || point.revenueCents > optimum.revenueCents) optimum = point;
  }

  const { referenceRate, pool } = resolvePool(input);
  return {
    curve,
    optimum: optimum as RevenuePoint,
    referencePoint: pointAt(input, ref),
    assumptions: {
      referenceRate,
      acceptedPool: pool,
      capacity: Math.max(0, input.capacity),
      elasticity: input.elasticity,
      minPriceCents,
      maxPriceCents,
    },
  };
}
