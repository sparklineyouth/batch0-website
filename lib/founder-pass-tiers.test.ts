import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PASS_TIERS,
  DEFAULT_TIER,
  passTier,
  isPassTierKey,
  tuitionDiscountCents,
  grantOf,
  grantDiscountCents,
  grantDiscountLabel,
  grantPerkLines,
  normalizeDiscountCents,
  parseDollarsToCents,
  formatCents,
  passKind,
  grantAutoAdmits,
  AUTO_ADMIT_LINE,
} from "./founder-pass-tiers.ts";

// What a founder pass is worth is the one number in this app that is decided
// once, by hand, and then billed silently months later — the holder never sees
// it quoted again before Stripe charges them. So the arithmetic below is worth
// pinning: a regression here does not throw, it just takes the wrong amount off
// someone's tuition and nobody finds out.
//
// Pure module (see the DEPENDENCY-FREE note at the top of the source), so this
// runs under `npm test` with no database and no environment.

const US = 13000; // the cohort default the accepted page falls back to
const IN = 11500; // the India override in lib/pricing.ts

// ---------------------------------------------------------------------------
// The roster
// ---------------------------------------------------------------------------

test("every tier's discount resolves against a real price", () => {
  for (const tier of PASS_TIERS) {
    const off = tuitionDiscountCents(tier, US);
    assert.ok(off >= 0, `${tier.key} took a negative amount off`);
    assert.ok(off <= US, `${tier.key} took more off than the bill`);
  }
});

test("a tier can never promise something the product doesn't do", () => {
  for (const tier of PASS_TIERS) {
    assert.ok(tier.decisionTargetDays >= 1, `${tier.key} promises a same-day decision`);
    assert.ok(tier.feedbackCredits >= 1, `${tier.key} carries no feedback credit`);
    assert.ok(tier.label.length > 0);
    assert.ok(tier.blurb.length > 0);
  }
});

test("standard is the default, and it is the pass a printed card carries", () => {
  assert.equal(DEFAULT_TIER.key, "standard");
  assert.equal(DEFAULT_TIER.tuitionDiscount, 3000);
});

test("an absent or unknown tier key resolves to standard, never to nothing", () => {
  // Load-bearing: rows written before migration 0055 have no tier at all, and a
  // row written by a future deploy could name one this build has never heard
  // of. Neither may make a holder's pass evaporate.
  assert.equal(passTier(null).key, "standard");
  assert.equal(passTier(undefined).key, "standard");
  assert.equal(passTier("").key, "standard");
  assert.equal(passTier("platinum").key, "standard");
  assert.equal(passTier("founding").key, "founding");
});

test("isPassTierKey agrees with the roster", () => {
  for (const t of PASS_TIERS) assert.ok(isPassTierKey(t.key));
  assert.equal(isPassTierKey("platinum"), false);
});

// ---------------------------------------------------------------------------
// Full ride — the case where the regional price is the whole point
// ---------------------------------------------------------------------------

test("a full ride waives the REGIONAL price, not the US list price", () => {
  const fullRide = passTier("full_ride");
  assert.equal(tuitionDiscountCents(fullRide, US), US);
  assert.equal(tuitionDiscountCents(fullRide, IN), IN);
  // The point of resolving against the regional amount: whatever the applicant
  // would have been billed, they are billed nothing.
  assert.equal(IN - tuitionDiscountCents(fullRide, IN), 0);
});

test("a flat tier discount is clamped to the bill", () => {
  const founding = passTier("founding"); // $60
  assert.equal(tuitionDiscountCents(founding, 4000), 4000);
  assert.equal(4000 - tuitionDiscountCents(founding, 4000), 0);
});

// ---------------------------------------------------------------------------
// Overrides — blank vs zero, and never a refund
// ---------------------------------------------------------------------------

test("a hand-set override beats the tier, including beating a full ride", () => {
  const grant = grantOf(passTier("full_ride"), 4500);
  assert.equal(grantDiscountCents(grant, US), 4500);
});

test("an over-large override is a full ride, never a refund", () => {
  const grant = grantOf(DEFAULT_TIER, 50000);
  assert.equal(grantDiscountCents(grant, US), US);
  assert.equal(grantDiscountCents(grant, IN), IN);
  assert.ok(US - grantDiscountCents(grant, US) >= 0);
});

test("zero is a real override and is not the same as blank", () => {
  const noDiscount = grantOf(DEFAULT_TIER, 0);
  const useTheTier = grantOf(DEFAULT_TIER, null);
  assert.equal(grantDiscountCents(noDiscount, US), 0);
  assert.equal(grantDiscountCents(useTheTier, US), 3000);
  // And it must say so rather than reading as a bug.
  assert.equal(grantDiscountLabel(noDiscount), "No tuition discount");
  assert.match(grantPerkLines(noDiscount)[0], /No tuition discount on this one/);
});

test("an unusable override falls back to the tier rather than to zero", () => {
  // The dangerous failure is the other direction: coercing a broken input to 0
  // would silently strip a discount someone was promised.
  assert.equal(normalizeDiscountCents(Number.NaN), null);
  assert.equal(normalizeDiscountCents(Number.POSITIVE_INFINITY), null);
  assert.equal(normalizeDiscountCents(-1), null);
  assert.equal(normalizeDiscountCents(undefined), null);
  assert.equal(normalizeDiscountCents(null), null);
  assert.equal(normalizeDiscountCents("45" as unknown as number), null);
  // Whole cents only, so the database never sees a fraction.
  assert.equal(normalizeDiscountCents(1230.4), 1230);
  assert.equal(normalizeDiscountCents(0), 0);
});

test("a grant with no override is exactly its tier", () => {
  for (const tier of PASS_TIERS) {
    assert.equal(
      grantDiscountCents(grantOf(tier), US),
      tuitionDiscountCents(tier, US),
    );
  }
});

// ---------------------------------------------------------------------------
// The admin's dollar box — the one boundary where humans speak dollars
// ---------------------------------------------------------------------------

test("the discount box accepts what people actually type", () => {
  assert.equal(parseDollarsToCents("45"), 4500);
  assert.equal(parseDollarsToCents("45.50"), 4550);
  assert.equal(parseDollarsToCents("$45"), 4500);
  assert.equal(parseDollarsToCents("  $45.50  "), 4550);
  assert.equal(parseDollarsToCents("1,000"), 100000);
  assert.equal(parseDollarsToCents("0"), 0);
});

test("blank means 'use the tier', and so does a typo", () => {
  assert.equal(parseDollarsToCents(""), null);
  assert.equal(parseDollarsToCents("   "), null);
  assert.equal(parseDollarsToCents("free"), null);
  assert.equal(parseDollarsToCents("45.999"), null);
  assert.equal(parseDollarsToCents("-45"), null);
  assert.equal(parseDollarsToCents(undefined as unknown as string), null);
});

test("dollars round-trip through cents without drifting", () => {
  for (const raw of ["30", "45.50", "0", "130"]) {
    const cents = parseDollarsToCents(raw)!;
    assert.equal(formatCents(cents), `$${Number(raw.replace(/[$,]/g, ""))
      .toFixed(cents % 100 === 0 ? 0 : 2)}`);
  }
});

// ---------------------------------------------------------------------------
// The promises — one source for the email, the admin preview and /pass
// ---------------------------------------------------------------------------

test("every grant produces a perk line for every varying term", () => {
  for (const tier of PASS_TIERS) {
    const lines = grantPerkLines(grantOf(tier));
    // Discount, decision clock, feedback credits — always. Early access only
    // when the tier actually carries it.
    assert.ok(lines.length >= 3, `${tier.key} lost a perk line`);
    assert.equal(
      lines.some((l) => /applications are closed/.test(l)),
      tier.earlyAccess === "always",
      `${tier.key} advertises early access it doesn't have, or hides one it does`,
    );
    assert.ok(lines.every((l) => l.trim().length > 0));
  }
});

test("a full ride never quotes a dollar figure it can't know", () => {
  // Quoting "$130 off" would be wrong for anyone on a regional price, and the
  // perk is the waiver, not the amount.
  const lines = grantPerkLines(grantOf(passTier("full_ride")));
  assert.match(lines[0], /waived in full/);
  assert.ok(!/\$/.test(lines[0]));
  assert.equal(grantDiscountLabel(grantOf(passTier("full_ride"))), "Tuition waived in full");
});

test("an override's perk line quotes the override, not the tier", () => {
  const lines = grantPerkLines(grantOf(passTier("full_ride"), 4500));
  assert.match(lines[0], /\$45 off tuition/);
  assert.ok(!/waived in full/.test(lines[0]));
});

// ---------------------------------------------------------------------------
// Auto-admit — a property of HOW the pass was issued, not of its tier
// ---------------------------------------------------------------------------

test("passKind defaults to card for anything it doesn't recognise", () => {
  // The conservative floor, and load-bearing: a row from before migration 0054
  // has no kind at all, and reading it as "virtual" would hand out a seat.
  assert.equal(passKind("virtual"), "virtual");
  assert.equal(passKind("card"), "card");
  assert.equal(passKind(null), "card");
  assert.equal(passKind(undefined), "card");
  assert.equal(passKind(""), "card");
  assert.equal(passKind("VIRTUAL"), "card");
  assert.equal(passKind("some_future_kind"), "card");
});

test("a grant defaults to a printed card, which never auto-admits", () => {
  assert.equal(grantOf(DEFAULT_TIER).kind, "card");
  assert.equal(grantAutoAdmits(grantOf(DEFAULT_TIER)), false);
});

test("every virtual pass auto-admits, at every tier", () => {
  // "As a general thing" — the perk belongs to the delivery channel, so a
  // standard virtual pass carries it exactly as a full ride does. A new tier
  // added to the roster inherits it without anyone remembering to.
  for (const tier of PASS_TIERS) {
    assert.equal(grantAutoAdmits(grantOf(tier, null, "virtual")), true, tier.key);
    assert.equal(grantAutoAdmits(grantOf(tier, null, "card")), false, tier.key);
  }
});

test("an auto-admitting pass advertises the seat instead of a decision clock", () => {
  // Two promises about the same moment. Printing "you're in on submit" next to
  // "we aim to decide within 2 business days" reads as a contradiction, or as
  // a wait that isn't real.
  for (const tier of PASS_TIERS) {
    const lines = grantPerkLines(grantOf(tier, null, "virtual"));
    assert.ok(lines.includes(AUTO_ADMIT_LINE), `${tier.key} lost the auto-admit line`);
    assert.ok(
      !lines.some((l) => /business day/.test(l)),
      `${tier.key} promises a decision target it will never use`,
    );
  }
});

test("a printed card keeps its decision clock and never mentions auto-admit", () => {
  for (const tier of PASS_TIERS) {
    const lines = grantPerkLines(grantOf(tier, null, "card"));
    assert.ok(!lines.includes(AUTO_ADMIT_LINE), `${tier.key} advertises a seat it can't give`);
    assert.ok(
      lines.some((l) => /business day/.test(l)),
      `${tier.key} lost its decision target`,
    );
  }
});

test("auto-admit doesn't disturb the discount or the credits lines", () => {
  const card = grantPerkLines(grantOf(passTier("full_ride"), null, "card"));
  const virtual = grantPerkLines(grantOf(passTier("full_ride"), null, "virtual"));
  assert.equal(card.length, virtual.length);
  assert.equal(card[0], virtual[0]); // discount
  assert.equal(card[2], virtual[2]); // feedback credits
  assert.notEqual(card[1], virtual[1]); // clock vs. seat
});

test("formatCents shows cents only when there are cents", () => {
  assert.equal(formatCents(3000), "$30");
  assert.equal(formatCents(0), "$0");
  assert.equal(formatCents(4550), "$45.50");
});
