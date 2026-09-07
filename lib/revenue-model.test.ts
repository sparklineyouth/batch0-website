import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildRevenueModel,
  projectedStudents,
  type RevenueModelInput,
} from "./revenue-model.ts";

// The model informs a pricing decision that moves real money, so the tests
// pin the properties a wrong number would violate: it must reproduce what we
// actually observed at today's price, never invent students past capacity or
// past the accepted pool, never quote negative revenue, and never return an
// "optimum" that is beaten by another point on its own curve.

// A cohort that is UNDERPRICED: demand (50 would-be payers) far exceeds the
// 20 seats at today's $100, so every seat fills with room to spare.
const UNDERPRICED: RevenueModelInput = {
  referencePriceCents: 10000,
  referenceConversions: 50,
  acceptedPool: 100,
  capacity: 20,
  elasticity: -1.2,
};

test("the curve passes through today's observed point", () => {
  // At the reference price the model must reproduce what we saw — here demand
  // (50) is capped by the 20 seats, so the anchored point reads 20.
  const m = buildRevenueModel(UNDERPRICED);
  assert.equal(m.referencePoint.priceCents, 10000);
  assert.equal(m.referencePoint.students, 20);
  assert.equal(m.referencePoint.revenueCents, 10000 * 20);
});

test("students never exceed capacity or the accepted pool", () => {
  const m = buildRevenueModel(UNDERPRICED);
  for (const p of m.curve) {
    assert.ok(p.students <= UNDERPRICED.capacity + 1e-9, "over capacity");
    assert.ok(p.students <= UNDERPRICED.acceptedPool + 1e-9, "over pool");
    assert.ok(p.students >= 0, "negative students");
    assert.ok(p.revenueCents >= 0, "negative revenue");
    assert.ok(p.fillRate >= 0 && p.fillRate <= 1, "fill rate out of range");
  }
});

test("the reported optimum is the best point on the curve", () => {
  const m = buildRevenueModel(UNDERPRICED);
  for (const p of m.curve) {
    assert.ok(
      m.optimum.revenueCents >= p.revenueCents,
      `a curve point beats the optimum: ${p.priceCents} > ${m.optimum.priceCents}`,
    );
  }
});

test("an underpriced cohort is told to raise price", () => {
  // Every seat fills at $100 with demand to spare, so the revenue-maximising
  // price is strictly above today's — the whole point of the tool.
  const m = buildRevenueModel(UNDERPRICED);
  assert.ok(
    m.optimum.priceCents > UNDERPRICED.referencePriceCents,
    `optimum ${m.optimum.priceCents} should exceed reference ${UNDERPRICED.referencePriceCents}`,
  );
});

test("demand is non-increasing as price rises", () => {
  // A higher price can never yield MORE paying students. A regression that
  // inverts the elasticity sign would break exactly this.
  let prev = Infinity;
  for (let price = 2000; price <= 40000; price += 2000) {
    const s = projectedStudents(UNDERPRICED, price);
    assert.ok(s <= prev + 1e-9, `students rose from ${prev} to ${s} at ${price}`);
    prev = s;
  }
});

test("more elastic demand recommends a lower price", () => {
  // Increasing price-sensitivity (a more negative elasticity) should pull the
  // revenue-maximising price down, not up.
  const inelastic = buildRevenueModel({ ...UNDERPRICED, elasticity: -0.8 });
  const elastic = buildRevenueModel({ ...UNDERPRICED, elasticity: -2.5 });
  assert.ok(
    elastic.optimum.priceCents <= inelastic.optimum.priceCents,
    `elastic optimum ${elastic.optimum.priceCents} should be <= inelastic ${inelastic.optimum.priceCents}`,
  );
});

test("no accept data falls back to a 100% reference rate over the payers", () => {
  // A brand-new cohort with paid students but no recorded accepted pool must
  // not divide by zero or invent demand: pool collapses to the payers.
  const m = buildRevenueModel({
    referencePriceCents: 13000,
    referenceConversions: 8,
    acceptedPool: 0,
    capacity: 50,
    elasticity: -1.2,
  });
  assert.equal(m.assumptions.referenceRate, 1);
  assert.equal(m.assumptions.acceptedPool, 8);
  // At the reference price the anchored quantity is the 8 who paid.
  assert.equal(m.referencePoint.students, 8);
});

test("a zero or negative price is handled without NaN", () => {
  assert.equal(projectedStudents(UNDERPRICED, 0), 0);
  assert.equal(projectedStudents(UNDERPRICED, -500), 0);
  const broken = buildRevenueModel({ ...UNDERPRICED, referencePriceCents: 0 });
  for (const p of broken.curve) {
    assert.ok(Number.isFinite(p.revenueCents), "non-finite revenue");
  }
});

test("the scan range brackets the reference price", () => {
  const m = buildRevenueModel(UNDERPRICED);
  assert.ok(m.assumptions.minPriceCents < UNDERPRICED.referencePriceCents);
  assert.ok(m.assumptions.maxPriceCents > UNDERPRICED.referencePriceCents);
});
