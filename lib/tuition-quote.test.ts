import test from "node:test";
import assert from "node:assert/strict";
import { quoteTuition, TuitionUnavailable } from "./tuition-quote.ts";

// `site_settings` defaults to an explicitly DISABLED promo, not to `[]`.
//
// `[]` meant "no promo rows", which `resolvePromoConfig` resolves to the SEED
// promo — so whether these fixtures had a discount running depended entirely
// on whether `args.now` happened to fall before or after `PROMO_ENDS_AT`. It
// fell after, so the seed promo was dormant and the tests below read as if no
// promo existed. Re-running the promo moved that deadline past the fixture
// date and three tests that say nothing about promotions began failing on
// prices that were, in fact, correctly discounted.
//
// A test that only means "no pass and no scholarship" should not also be
// asserting the current calendar. Tests that actually exercise the promotion
// pass their own `site_settings` rows and are unaffected; the seed-fallback
// behaviour itself is covered in lib/promo.test.ts, which is where it belongs.
const PROMO_OFF = { data: [{ key: "promo_enabled", value: false }], error: null };

function pricingDb(results: Record<string, any>, calls: unknown[][] = []): any {
  return { from(table: string) {
    const response = results[table] ?? (table === "site_settings" ? PROMO_OFF : { data: null, error: null });
    const chain: any = { then(resolve: any, reject: any) { return Promise.resolve(response).then(resolve, reject); } };
    for (const method of ["select", "eq", "is", "in", "maybeSingle"]) chain[method] = (...args: unknown[]) => { calls.push([table,method,...args]); return chain; };
    return chain;
  } };
}
const args = { userId: "student", cohortId: "fall", rowPriceCents: 12999, country: "IN", now: new Date("2026-09-20T12:00:00Z") };

test("regional price, promotion, pass and percentage award stack into the exact payable quote", async () => {
  const db = pricingDb({
    site_settings: { data: [{key:"promo_enabled",value:true},{key:"promo_percent",value:10},{key:"promo_ends_at",value:null}] },
    founder_passes: { data: { tier: "standard", discount_cents: 3000, kind: "card" } },
    scholarship_applications: { data: { award_cents: 6500, award_percent: 50, fulfillment: "discount" } },
  });
  const quote = await quoteTuition(db, args);
  assert.equal(quote.baseCents, 12999);
  assert.equal(quote.promoDiscountCents, 1100); // Indian list115 -> sale104.
  assert.equal(quote.passDiscountCents, 3000);
  assert.equal(quote.scholarshipDiscountCents, 3700);
  assert.equal(quote.amountCents, 3700);
});
for (const table of ["site_settings", "founder_passes", "scholarship_applications"]) {
  test(`${table} read failure blocks payment instead of increasing tuition`, async () => {
    await assert.rejects(quoteTuition(pricingDb({[table]:{data:null,error:{message:"offline"}}}), args), TuitionUnavailable);
  });
}
test("confirmed absent discounts charge the regional rate, and cohort matching never spills an award", async () => {
  const calls: unknown[][] = [];
  assert.equal((await quoteTuition(pricingDb({}, calls), args)).amountCents, 11500);
  assert.ok(calls.some(c => JSON.stringify(c) === JSON.stringify(["scholarship_applications","eq","cohort_id","fall"])));
});
test("full tuition pass plus scholarship clamps at zero; an already refunded award is not deducted twice", async () => {
  const db = pricingDb({
    founder_passes: { data: { tier: "standard", discount_cents: 99999, kind: "card" } },
    scholarship_applications: { data: { award_cents: 5000, award_percent: null, fulfillment: "discount" } },
  });
  assert.equal((await quoteTuition(db, args)).amountCents, 0);
  assert.equal((await quoteTuition(pricingDb({ scholarship_applications: { data: { award_cents: 5000, award_percent: null, fulfillment: "refunded" } } }), args)).amountCents, 11500);
});

test("USD residual amounts below fifty cents are waived; exactly fifty cents is payable", async () => {
  for (const remaining of [1,25,49,50]) {
    const quote = await quoteTuition(pricingDb({scholarship_applications:{data:{award_cents:11500-remaining,award_percent:null,fulfillment:"discount"}}}), args);
    assert.equal(quote.amountCents, remaining < 50 ? 0 : remaining);
    assert.equal(quote.residualWaiverCents, remaining < 50 ? remaining : 0);
  }
});
