import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PROMO_ENDS_AT,
  PROMO_PERCENT,
  PROMO_LIST_PRICE_CENTS,
  PROMO_SALE_PRICE_CENTS,
  listPriceCents,
  activePromo,
  promoPriceCents,
  promoTitle,
  promoMetaDescription,
  resolvePromoConfig,
  isDefaultPromoConfig,
  DEFAULT_PROMO_CONFIG,
  type PromoConfig,
} from "./promo.ts";

// A promotion is the rare feature whose failure mode is legal rather than
// visual: advertise a discount the checkout does not honour, or keep
// advertising one after it ends, and the bug is a false price rather than a
// broken page. Nothing here touches a database or a network, because the
// module deliberately doesn't.

const DURING = new Date("2026-09-05T12:00:00-04:00");
const LAST_MINUTE = new Date("2026-09-09T23:59:00-04:00");
const AFTER = new Date("2026-09-10T00:00:30-04:00");

// The two list prices the site actually charges (lib/pricing.ts).
const US_LIST = 12999;
const IN_LIST = 11500;

test("the promo runs through the last minute of September 9, Eastern", () => {
  assert.ok(activePromo(DURING), "should be live mid-sale");
  assert.ok(
    activePromo(LAST_MINUTE),
    "11:59 PM Eastern on the 9th is still the 9th — a UTC deadline would " +
      "have cut this off at 8 PM and killed the last evening of the push",
  );
});

test("the promo is over immediately after its deadline", () => {
  assert.equal(activePromo(AFTER), null);
});

test("expiry makes every price revert with no cleanup", () => {
  // The whole design rests on this: after the deadline the discount function
  // is the identity, so nothing has to be un-edited by hand.
  assert.equal(promoPriceCents(US_LIST, AFTER), US_LIST);
  assert.equal(promoPriceCents(IN_LIST, AFTER), IN_LIST);
});

test("the discount reaches every region proportionally", () => {
  // Applied on top of the regional table rather than inside it, so one sale
  // discounts both without anyone hand-syncing lib/pricing.ts. A regression
  // here is what made India briefly more expensive than the U.S.
  assert.equal(promoPriceCents(US_LIST, DURING), 11700);
  assert.equal(promoPriceCents(IN_LIST, DURING), 10400);
  assert.ok(
    promoPriceCents(IN_LIST, DURING) < promoPriceCents(US_LIST, DURING),
    "the PPP-adjusted region must never cost more than the base region",
  );
});

test("a discounted price is always a whole dollar", () => {
  // 10% off $129.99 is $116.991. Billing that literally puts "$116.99" on a
  // card statement under a headline promising $117.
  //
  // Only prices the promo actually discounts are covered: a base at or below
  // the guard's floor is returned untouched, cents and all, because passing it
  // through unchanged is the entire point of the guard.
  for (const list of [US_LIST, IN_LIST, 9700, 13000]) {
    assert.ok(list > PROMO_SALE_PRICE_CENTS, `${list} is below the floor`);
    assert.equal(
      promoPriceCents(list, DURING) % 100,
      0,
      `${list} produced a fractional-dollar sale price`,
    );
  }
});

test("a price below the floor is passed through exactly, cents included", () => {
  assert.equal(promoPriceCents(4999, DURING), 4999);
});

test("the discount never inverts or exceeds the price", () => {
  for (const list of [0, 1, 100, 4999, 12999, 50000]) {
    const sale = promoPriceCents(list, DURING);
    assert.ok(sale >= 0, `${list} produced a negative price`);
    assert.ok(sale <= list, `${list} produced a sale price ABOVE list`);
  }
});

test("the title fits inside what Google renders", () => {
  const promo = activePromo(DURING)!;
  const title = promoTitle(promo);
  // Google displays roughly the first 60 characters. The version this replaced
  // was 83 with the offer starting at 48 — entirely past the cutoff, so the
  // sale would never have been shown at all.
  assert.ok(
    [...title].length <= 60,
    `title is ${[...title].length} chars: ${title}`,
  );
  // The brand leads because this title answers the query "batch0", and Google
  // keeps titles whose opening words match the query far more readily than
  // ones that open on a discount. The offer still has to be in there, and
  // still has to land inside the visible window.
  assert.ok(title.startsWith("batch0"), "a brand query wants the brand first");
  assert.ok(
    title.includes(`${PROMO_PERCENT}% Off`),
    "the offer must survive in the title",
  );
  assert.ok(
    [...title].indexOf("%") < 60,
    "the offer must fall inside what Google renders",
  );
});

test("the meta description quotes two different prices", () => {
  const promo = activePromo(DURING)!;
  const desc = promoMetaDescription(promo, "$117", "$130");
  // Regression: this once rendered "tuition is $130, not $130" because the
  // sale price was read from a field holding the LIST price. Typechecking
  // cannot catch it — both arguments are strings.
  assert.match(desc, /\$117, not \$130/);
  assert.ok(
    [...desc].length <= 160,
    `description is ${[...desc].length} chars and will be truncated`,
  );
});

test("the deadline constant carries an explicit timezone offset", () => {
  // A bare date would be parsed as UTC and silently move the deadline.
  assert.match(PROMO_ENDS_AT, /[+-]\d{2}:\d{2}$/);
  assert.ok(!Number.isNaN(new Date(PROMO_ENDS_AT).getTime()));
});


// ---------------------------------------------------------------------------
// The double-discount guard
// ---------------------------------------------------------------------------

test("the row's hand-entered $78 value is not discounted a second time", () => {
  // The regression this exists for: cohorts.price_cents is meant to hold LIST
  // price, someone entered the $78 sale price of the original 40% run in the
  // admin form instead, and the site discounted it again — billing $47 under a
  // headline promising $78. The guard keys off that fixed $78 artifact, so a
  // base at (or below) it is charged as-is rather than cut again.
  assert.equal(
    promoPriceCents(PROMO_SALE_PRICE_CENTS, DURING),
    PROMO_SALE_PRICE_CENTS,
    "the bad-row value must pass through untouched, not take a second cut",
  );
});

test("the guard's floor is the fixed $78 value, not the current sale price", () => {
  // Deliberately NOT the $117 the promo now charges. At 10% that price sits
  // ABOVE India's $115 list, so a floor at the sale price would swallow a real
  // regional discount (see the regional test below). Keying off the stable $78
  // artifact keeps the floor low enough that every genuine price is discounted.
  assert.equal(promoPriceCents(PROMO_SALE_PRICE_CENTS, DURING), 7800);
  // A dollar above the floor is a genuine price and gets the promo.
  assert.equal(promoPriceCents(7900, DURING), 7100);
});

test("the guard errs toward list price, never toward a partial discount", () => {
  // A cohort genuinely priced at or below the $78 floor does not receive the
  // promo. That is the deliberate tradeoff: charging list is recoverable,
  // charging a discount off a number that may already be one is not.
  const belowFloor = 5000;
  assert.equal(promoPriceCents(belowFloor, DURING), belowFloor);
});

test("the guard never blocks a legitimate regional discount", () => {
  // India's $115 list sits above the $78 floor, so it must still be discounted
  // in full — the guard must not quietly cancel regional pricing. This is the
  // case that broke when the floor tracked the sale price: at 10% the $117
  // sale price is above $115, and India would have lost its discount.
  assert.equal(promoPriceCents(IN_LIST, DURING), 10400);
  assert.ok(promoPriceCents(IN_LIST, DURING) < IN_LIST);
});


// ---------------------------------------------------------------------------
// Reading back a row that was hand-set to the sale price
// ---------------------------------------------------------------------------

test("a row holding the sale price is read as the list price it came from", () => {
  assert.equal(listPriceCents(PROMO_SALE_PRICE_CENTS), PROMO_LIST_PRICE_CENTS);
});

test("every other price is passed through untouched", () => {
  for (const cents of [US_LIST, IN_LIST, 13000, 5000, 0]) {
    assert.equal(listPriceCents(cents), cents);
  }
});

test("the bad row charges $117 during the sale and $130 after it", () => {
  // The whole point. cohorts.price_cents holds 7800 — the $78 the row was
  // hand-set to. Normalising it back to list ($130) means the site is correct
  // in both states with no database edit at all: $117 (10% off) while the sale
  // runs, $130 the moment it ends.
  const row = PROMO_SALE_PRICE_CENTS;
  assert.equal(promoPriceCents(listPriceCents(row), DURING), 11700);
  assert.equal(promoPriceCents(listPriceCents(row), AFTER), 12999);
});

test("a correct row behaves identically, so repairing the data changes nothing", () => {
  // Once cohorts.price_cents goes back to 12999 this normalisation becomes a
  // no-op rather than a behaviour change — which is what makes it safe to
  // delete later.
  const good = PROMO_LIST_PRICE_CENTS;
  assert.equal(
    promoPriceCents(listPriceCents(good), DURING),
    promoPriceCents(listPriceCents(PROMO_SALE_PRICE_CENTS), DURING),
  );
  assert.equal(
    promoPriceCents(listPriceCents(good), AFTER),
    promoPriceCents(listPriceCents(PROMO_SALE_PRICE_CENTS), AFTER),
  );
});

test("India keeps its own list price and its own discount", () => {
  // 11500 is not the hand-entered $78 row value, so normalisation must not
  // touch it.
  assert.equal(listPriceCents(IN_LIST), IN_LIST);
  assert.equal(promoPriceCents(listPriceCents(IN_LIST), DURING), 10400);
  assert.equal(promoPriceCents(listPriceCents(IN_LIST), AFTER), IN_LIST);
});


// ---------------------------------------------------------------------------
// The admin-editable promo config (site_settings -> resolvePromoConfig)
// ---------------------------------------------------------------------------

const US_LIST_CFG = 12999;

test("an absent/empty config resolves to the seed and takes the legacy path", () => {
  // The whole backward-compat guarantee: until an admin writes a promo_* row,
  // resolvePromoConfig returns the seed, and the config-aware overloads behave
  // byte-for-byte like the no-arg legacy path.
  const cfg = resolvePromoConfig({});
  assert.deepEqual(cfg, DEFAULT_PROMO_CONFIG);
  assert.ok(isDefaultPromoConfig(cfg));
  assert.equal(promoPriceCents(US_LIST_CFG, DURING, cfg), promoPriceCents(US_LIST_CFG, DURING));
  assert.deepEqual(activePromo(DURING, cfg), activePromo(DURING));
});

test("an admin percent flows through to the charged price", () => {
  const cfg = resolvePromoConfig({ promo_percent: 25 });
  assert.equal(activePromo(DURING, cfg)?.percent, 25);
  // 25% off $129.99, rounded to whole dollars -> $97.
  assert.equal(promoPriceCents(US_LIST_CFG, DURING, cfg), 9700);
});

test("the master switch and a zero percent both turn the promo off", () => {
  const off = resolvePromoConfig({ promo_enabled: false });
  assert.equal(activePromo(DURING, off), null);
  assert.equal(promoPriceCents(US_LIST_CFG, DURING, off), US_LIST_CFG);

  const zero = resolvePromoConfig({ promo_percent: 0 });
  assert.equal(activePromo(DURING, zero), null);
  assert.equal(promoPriceCents(US_LIST_CFG, DURING, zero), US_LIST_CFG);
});

test("percent is clamped to 0-90 and rounded", () => {
  assert.equal(resolvePromoConfig({ promo_percent: 250 }).percent, 90);
  assert.equal(resolvePromoConfig({ promo_percent: -5 }).percent, 0);
  assert.equal(resolvePromoConfig({ promo_percent: 12.6 }).percent, 13);
  assert.equal(resolvePromoConfig({ promo_percent: "20" as unknown }).percent, 20);
});

test("an admin end date governs expiry", () => {
  const cfg: PromoConfig = { enabled: true, percent: 30, endsAt: "2026-10-01T23:59:59-04:00" };
  assert.ok(activePromo(new Date("2026-09-15T12:00:00-04:00"), cfg), "live before the date");
  assert.equal(activePromo(new Date("2026-10-02T00:30:00-04:00"), cfg), null, "dead after the date");
});

test("a null end date is an open-ended promo with no deadline labels", () => {
  const cfg = resolvePromoConfig({ promo_percent: 15, promo_ends_at: null });
  assert.equal(cfg.endsAt, null);
  const promo = activePromo(new Date("2030-01-01T00:00:00Z"), cfg);
  assert.ok(promo, "open-ended promo never expires");
  assert.equal(promo?.longDeadline, "");
  assert.equal(promo?.shortDeadline, "");
  // Title and description drop the deadline clause rather than rendering a gap.
  assert.ok(!promoTitle(promo!).includes("Until"));
  assert.match(promoMetaDescription(promo!, "$110", "$130"), /^15% off: tuition is \$110/);
});

test("a malformed end date falls back to the seed deadline", () => {
  const cfg = resolvePromoConfig({ promo_ends_at: "not-a-date" });
  assert.equal(cfg.endsAt, PROMO_ENDS_AT);
});

test("the double-discount guard still applies under an admin config", () => {
  const cfg = resolvePromoConfig({ promo_percent: 40 });
  // A base at the fixed $78 bad-row value is passed through, not cut again.
  assert.equal(promoPriceCents(PROMO_SALE_PRICE_CENTS, DURING, cfg), PROMO_SALE_PRICE_CENTS);
});
