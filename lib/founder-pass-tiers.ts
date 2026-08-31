// Founder-pass tiers: what a given pass is actually worth.
//
// Every pass used to be identical — one discount, one decision target, one
// feedback credit — because every pass was a card pulled off a print run with
// nobody's name on it. Virtual passes (migration 0054) changed that: they are
// issued TO a person, one at a time, by someone who knows why. This module is
// where that "why" turns into mechanics.
//
// The rule this file exists to enforce: a tier is a set of NUMBERS THE CODE
// READS, never a set of adjectives. Every field below is consumed somewhere
// real — checkout math, the feedback-credit ceiling, the applications gate,
// the decision-target clock — so a tier cannot promise something the product
// doesn't do. That is the same standard app/pass/page.tsx holds its perk list
// to, and it is the reason there is no `prestige: number` here.
//
// DEPENDENCY-FREE ON PURPOSE. The admin issue form is a client component and
// renders these perks as you pick a tier, so this module must never reach
// lib/founder-pass.ts — that pulls founder-pass-code.ts, and node:crypto with
// it, into the browser bundle. Same split, same reason as
// lib/founder-pass-topics.ts.

export type PassTierKey = "standard" | "founding" | "full_ride";

/**
 * How a tier treats the applications gate.
 *
 *   "window" — the historical behaviour: this pass opens the gate only while
 *              the admin has the `founder_pass_early_access` window switched
 *              on. When the cohort genuinely closes, the pass closes with it.
 *   "always" — this specific pass opens the gate regardless. Reserved for the
 *              top tier, because it is a standing invitation handed to one
 *              named person, not a property of "holding a pass".
 */
export type EarlyAccessPolicy = "window" | "always";

export type PassTier = {
  key: PassTierKey;
  label: string;
  /** One line for the admin picker: who this tier is for. */
  blurb: string;
  /**
   * Tuition discount. A number is a flat amount in cents; "full" waives
   * whatever the applicant would otherwise pay, including a regional price.
   * Resolve it with tuitionDiscountCents() rather than reading it raw — that
   * helper is what clamps the value to the actual price.
   */
  tuitionDiscount: number | "full";
  /** Business days we aim to decide a complete application within. */
  decisionTargetDays: number;
  /**
   * How many feedback credits this pass carries over its whole life.
   *
   * Distinct from how many may be OPEN at once, which is always one and is
   * enforced by a partial unique index (migration 0041/0055). This number is
   * the ceiling on non-declined requests in total, checked in code — the index
   * is what makes that check race-safe, since a second concurrent request can
   * never get past "one open".
   */
  feedbackCredits: number;
  earlyAccess: EarlyAccessPolicy;
};

/**
 * The roster. Order is deliberate: ascending, so the admin picker reads as a
 * ladder and `standard` sits first as the default.
 *
 * Keep in lockstep with the check constraint in migration 0055. Adding a tier
 * here without adding it there makes every insert of that tier fail at write
 * time — the same coupling 0051 documents for blog author keys.
 */
export const PASS_TIERS: readonly PassTier[] = [
  {
    key: "standard",
    label: "Standard",
    blurb: "The pass as it ships on a printed card. Use this unless you have a reason not to.",
    tuitionDiscount: 3000,
    decisionTargetDays: 3,
    feedbackCredits: 1,
    earlyAccess: "window",
  },
  {
    key: "founding",
    label: "Founding",
    blurb: "For someone you've actually met and want in the room. Double the discount, a faster clock, a second feedback credit.",
    tuitionDiscount: 6000,
    decisionTargetDays: 2,
    feedbackCredits: 2,
    earlyAccess: "window",
  },
  {
    key: "full_ride",
    label: "Full ride",
    blurb: "Tuition waived outright, and the gate stays open for them even after applications close. Hand these out sparingly.",
    tuitionDiscount: "full",
    decisionTargetDays: 1,
    feedbackCredits: 3,
    earlyAccess: "always",
  },
];

const BY_KEY = new Map<string, PassTier>(PASS_TIERS.map((t) => [t.key, t]));

/** The tier every pass gets unless someone chose otherwise. */
export const DEFAULT_TIER: PassTier = BY_KEY.get("standard")!;

/**
 * Resolve a stored tier key.
 *
 * Falls back to standard rather than throwing, and that fallback is
 * load-bearing in two places: rows written before migration 0055 have no tier
 * at all, and a row written by a future deploy could name a tier this build
 * has never heard of. Neither should make a holder's pass evaporate — the
 * floor is "the pass everyone gets", never "no pass".
 */
export function passTier(key: string | null | undefined): PassTier {
  return BY_KEY.get(key ?? "") ?? DEFAULT_TIER;
}

export function isPassTierKey(key: string): key is PassTierKey {
  return BY_KEY.has(key);
}

/**
 * What this tier takes off a given price, in cents.
 *
 * `listPriceCents` must be the price the applicant would actually pay before
 * the pass — i.e. AFTER regional pricing — because a "full ride" has to waive
 * the regional amount, not the US list price. Clamped to that price so the
 * discount shown can never exceed the bill, which keeps this in step with the
 * `Math.max(0, price - discount)` the checkout route has always done.
 */
export function tuitionDiscountCents(
  tier: PassTier,
  listPriceCents: number,
): number {
  const price = Math.max(0, Math.round(listPriceCents));
  if (tier.tuitionDiscount === "full") return price;
  return Math.min(price, Math.max(0, tier.tuitionDiscount));
}

/** "$30" / "$130". Whole dollars — every tier amount is a round number. */
export function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(cents % 100 === 0 ? 0 : 2)}`;
}

/**
 * How the discount reads before we know the applicant's region.
 *
 * "Full ride" deliberately renders as words rather than a number: quoting
 * "$130 off" in an invite would be wrong for anyone on a regional price, and
 * the perk is the waiver, not the amount.
 */
export function discountLabel(tier: PassTier): string {
  return tier.tuitionDiscount === "full"
    ? "Tuition waived in full"
    : `${formatCents(tier.tuitionDiscount)} off tuition`;
}

// ===========================================================================
// Grants — a tier, plus the one thing an admin can override by hand.
// ===========================================================================

/**
 * What a specific pass is actually worth: the named package, and an optional
 * hand-set discount that beats it (migration 0056).
 *
 * This — not PassTier — is what every surface should reason about once a pass
 * exists. A tier alone is a shelf item; a grant is what somebody was given.
 *
 * `discountCents` is null on the overwhelming majority of passes, meaning
 * "whatever the tier says". A number means exactly that many cents, and it
 * wins over the tier including over "full".
 */
export type PassGrant = {
  tier: PassTier;
  discountCents: number | null;
};

/** A grant carrying nothing but its tier's own terms. */
export function grantOf(
  tier: PassTier,
  discountCents: number | null = null,
): PassGrant {
  return { tier, discountCents: normalizeDiscountCents(discountCents) };
}

/**
 * Coerce an override into something safe to store: a non-negative whole number
 * of cents, or null for "use the tier".
 *
 * Returns null for anything unusable — NaN, Infinity, negatives, a stray
 * string — rather than throwing or clamping to 0. That difference matters: 0
 * is a real, meaningful override ("this pass carries no discount"), so a
 * broken input must NOT land on it. Falling back to the tier is the safe
 * reading of "I couldn't understand what you typed".
 */
export function normalizeDiscountCents(
  value: number | null | undefined,
): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const cents = Math.round(value);
  if (cents < 0) return null;
  return cents;
}

/**
 * What this grant takes off a given price, in cents.
 *
 * `listPriceCents` must be the price the applicant would actually pay before
 * the pass — i.e. AFTER regional pricing — because a "full ride" has to waive
 * the regional amount, not the US list price, and an override of $500 against
 * a $70 regional price has to resolve to $70 rather than a refund.
 *
 * Clamped to that price in every branch, which is what keeps the checkout
 * math's `Math.max(0, price - discount)` from ever needing to do real work.
 */
export function grantDiscountCents(
  grant: PassGrant,
  listPriceCents: number,
): number {
  const price = Math.max(0, Math.round(listPriceCents));
  if (grant.discountCents !== null) {
    return Math.min(price, grant.discountCents);
  }
  return tuitionDiscountCents(grant.tier, price);
}

/**
 * How a grant's discount reads before we know the applicant's region.
 *
 * An override renders as its own flat number. "Full ride" deliberately renders
 * as words: quoting "$130 off" in an invite would be wrong for anyone on a
 * regional price, and the perk is the waiver, not the amount.
 */
export function grantDiscountLabel(grant: PassGrant): string {
  if (grant.discountCents !== null) {
    return grant.discountCents === 0
      ? "No tuition discount"
      : `${formatCents(grant.discountCents)} off tuition`;
  }
  return discountLabel(grant.tier);
}

/**
 * The grant's promises as plain sentences — the single source for the invite
 * email, the admin preview, and the holder's own pass page.
 *
 * One source so those three can never disagree. An email that promises a
 * second feedback credit the pass page doesn't show is worse than no email.
 * Only the varying fields appear here; perks every pass carries (the toolkit,
 * the profile, the Discord role, the rebuild) are listed separately by
 * whichever surface wants them, because they don't vary.
 */
export function grantPerkLines(grant: PassGrant): string[] {
  const { tier } = grant;
  const lines: string[] = [];

  if (grant.discountCents !== null) {
    // An explicit 0 is a real choice — a pass issued purely for the priority
    // lane and the tools. Saying "$0 off tuition" would read as a bug, so say
    // what's true instead, and never silently drop the line.
    lines.push(
      grant.discountCents === 0
        ? "No tuition discount on this one — it's for the lane and the tools."
        : `${formatCents(grant.discountCents)} off tuition if you're accepted.`,
    );
  } else {
    lines.push(
      tier.tuitionDiscount === "full"
        ? "Tuition waived in full if you're accepted — you pay nothing."
        : `${formatCents(tier.tuitionDiscount)} off tuition if you're accepted.`,
    );
  }

  lines.push(
    tier.decisionTargetDays === 1
      ? "Read first, with a decision the next business day after a complete application."
      : `Read first, with a decision inside ${tier.decisionTargetDays} business days of a complete application.`,
  );
  lines.push(
    tier.feedbackCredits === 1
      ? "A feedback credit: one piece of work read properly and written up."
      : `${tier.feedbackCredits} feedback credits — ${tier.feedbackCredits} pieces of work read properly and written up, one at a time.`,
  );
  if (tier.earlyAccess === "always") {
    lines.push("You can apply even when applications are closed to everyone else.");
  }
  return lines;
}

/** Perk lines for a bare tier, with no override in play. */
export function tierPerkLines(tier: PassTier): string[] {
  return grantPerkLines(grantOf(tier));
}

// ---------------------------------------------------------------------------
// Dollars <-> cents, for the one input that speaks dollars.
// ---------------------------------------------------------------------------

/**
 * Parse the admin's discount box.
 *
 * Accepts "45", "45.50", "$45", " $45.50 ", and empty. Empty (or unparseable)
 * means "use the tier" — see normalizeDiscountCents on why that is the right
 * fallback rather than zero.
 *
 * Returns cents, so the rounding happens exactly once, here, at the boundary
 * between what a human typed and what the database stores.
 */
export function parseDollarsToCents(raw: string): number | null {
  const cleaned = (raw ?? "").replace(/[$,\s]/g, "");
  if (!cleaned) return null;
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  return normalizeDiscountCents(Math.round(Number.parseFloat(cleaned) * 100));
}
