import type { SupabaseClient } from "@supabase/supabase-js";
import { getRegionalPrice } from "./pricing.ts";
import { listPriceCents, promoPriceCents, resolvePromoConfig } from "./promo.ts";
import { grantDiscountCents, grantOf, passTier, passKind, normalizeDiscountCents, type PassGrant } from "./founder-pass-tiers.ts";

export type TuitionQuote = {
  amountCents: number;
  currency: "usd";
  country: string | null;
  regionalPricing: boolean;
  baseCents: number;
  promoDiscountCents: number;
  passDiscountCents: number;
  scholarshipDiscountCents: number;
  residualWaiverCents: number;
  /** Snapshotted by the application service for stable Stripe retries. */
  cohortName?: string;
};

/** Pricing is a charging boundary. A failed discount read must stop checkout,
 * never silently turn a scholarship or full ride into a full-price bill. */
export class TuitionUnavailable extends Error {
  constructor() { super("Tuition is temporarily unavailable. Please try again before paying."); }
}

/** One authoritative snapshot for acceptance, student checkout and the payer.
 * `passGrant` remains accepted for older callers, but the current grant is read
 * strictly: callers may have obtained null from a display-only fallback. */
export async function quoteTuition(admin: SupabaseClient, args: {
  userId: string; cohortId: string | null; rowPriceCents: number;
  country: string | null; passGrant?: PassGrant | null; now?: Date;
}): Promise<TuitionQuote> {
  let awardQuery = admin.from("scholarship_applications")
    .select("award_cents,award_percent,fulfillment").eq("user_id", args.userId).eq("status", "awarded");
  awardQuery = args.cohortId ? awardQuery.eq("cohort_id", args.cohortId) : awardQuery.is("cohort_id", null);
  const [promoRead, passRead, awardRead] = await Promise.all([
    admin.from("site_settings").select("key,value").in("key", ["promo_enabled", "promo_percent", "promo_ends_at"]),
    admin.from("founder_passes").select("tier,discount_cents,kind").eq("redeemed_by", args.userId).is("revoked_at", null).maybeSingle(),
    awardQuery.maybeSingle(),
  ]);
  if (promoRead.error || passRead.error || awardRead.error || !promoRead.data) throw new TuitionUnavailable();
  if (!Number.isInteger(args.rowPriceCents) || args.rowPriceCents < 0) throw new TuitionUnavailable();
  const raw = Object.fromEntries(promoRead.data.map((row) => [row.key, row.value]));
  const promo = resolvePromoConfig(raw);
  const pass = passRead.data ? grantOf(passTier(passRead.data.tier), normalizeDiscountCents(passRead.data.discount_cents), passKind(passRead.data.kind)) : null;
  const baseCents = listPriceCents(args.rowPriceCents);
  const regional = getRegionalPrice(baseCents, args.country);
  const sale = promoPriceCents(regional.amountCents, args.now ?? new Date(), promo);
  const passDiscountCents = pass ? grantDiscountCents(pass, sale) : 0;
  const afterPass = Math.max(0, sale - passDiscountCents);
  const award = awardRead.data;
  let scholarshipDiscountCents = 0;
  if (award && !["refunded", "refund_due"].includes(award.fulfillment)) {
    // Migration 0072 snapshots the award, including percentages. Never read a
    // subsequently edited catalog value or an award from a different cohort.
    if (!Number.isInteger(award.award_cents) || award.award_cents < 0 ||
      (award.award_percent !== null && (!Number.isInteger(award.award_percent) || award.award_percent < 1 || award.award_percent > 100))) throw new TuitionUnavailable();
    const discount = award.award_percent === null ? award.award_cents : Math.round(afterPass * award.award_percent / 100);
    scholarshipDiscountCents = Math.min(afterPass, Math.max(0, discount));
  }
  const remaining = Math.max(0, afterPass - scholarshipDiscountCents);
  // USD card charges must be at least $0.50. Waive a smaller remainder;
  // rounding it up would charge more than the awarded discount promised.
  const residualWaiverCents = remaining > 0 && remaining < 50 ? remaining : 0;
  return {
    amountCents: remaining - residualWaiverCents, currency: "usd",
    country: args.country, regionalPricing: regional.isRegional, baseCents,
    promoDiscountCents: regional.amountCents - sale, passDiscountCents, scholarshipDiscountCents, residualWaiverCents,
  };
}
