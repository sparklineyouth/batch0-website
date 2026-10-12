// The 10%-off tuition promotion.
//
// This module exists so the promo has exactly ONE end date. The previous
// version of this push was a hand-edited string in the root layout with a
// comment asking a human to remember to take it out — which is the failure
// mode where a site advertises an expired sale for a month because nobody
// redeployed. Everything date-dependent reads `activePromo()` instead, so the
// offer disappears from the site on its own.
//
// DEPENDENCY-FREE on purpose: imported by metadata builders that run during
// static generation, so it must not reach for a database or an environment.

/**
 * End of the promotion — 11:59:59 PM Eastern on October 21, 2026.
 *
 * THE ONE DATE. Every deadline string, countdown, title tag, meta description
 * and `priceValidUntil` on the site is now derived from this constant (see
 * `PROMO` and `PROMO_VALID_UNTIL` below), so re-running or extending the promo
 * is a one-line edit here and nothing can disagree with anything else. The
 * previous run had the same date written out by hand in four places — this
 * module, the sale banner's seed label, and two schema literals — which is how
 * a site ends up advertising two different deadlines.
 *
 * Written with an explicit offset rather than a bare date: "until Oct 21" to a
 * U.S. audience means the end of that evening, and a plain `2026-10-22T00:00Z`
 * would have cut the offer off at 8 PM Eastern on the 21st, killing the last
 * night of a deadline-driven push. -04:00 is correct for October 21 — U.S. DST
 * does not end until November 1, 2026.
 */
export const PROMO_ENDS_AT = "2026-10-21T23:59:59-04:00";

/** Percentage off the list price. Display only — see the note in `Promo`. */
export const PROMO_PERCENT = 10;

/**
 * What the discount covers, in prose, for copy that has room to say it.
 *
 * The promo has always been site-wide — it discounts whatever cohort is
 * currently being sold, because `promoPriceCents()` is applied to the active
 * cohort's price whatever that row happens to be. But nothing on the site ever
 * SAID so, and "10% off tuition" with no scope reads like it might be one
 * cohort, one region, or a coupon someone else got. Naming the cohorts is what
 * makes the offer legible to a reader — and to a search engine or an assistant
 * summarising the page, which can only repeat a claim the page actually makes.
 *
 * Deliberately not built from cohort rows. The fall and winter cohorts are the
 * two that exist (Fall 2026 and Winter 2026, Dec 14 → Feb 12), and a label
 * assembled from whichever row `getSiteConfig` happens to pick would name just
 * one of them — which would be narrower than the offer really is.
 */
export const PROMO_SCOPE = "fall and winter cohorts";

/**
 * schema.org `priceValidUntil` for the Offer node. Exported separately from
 * `activePromo()` because the root layout builds its JSON-LD at module scope,
 * where there is no request and therefore no meaningful "now".
 *
 * DERIVED from `PROMO_ENDS_AT` rather than written out again: this value and
 * the deadline shown to humans have to be the same day, and the previous
 * hand-written pair is exactly the kind of thing that survives a date change
 * by one line. `formatPromoDeadlines` is a hoisted function declaration, so
 * calling it here at module scope is safe despite being defined below.
 */
export const PROMO_VALID_UNTIL = formatPromoDeadlines(PROMO_ENDS_AT).validUntil;

/**
 * The list tuition this promotion was declared against, in cents — the value
 * `cohorts.price_cents` is expected to hold while the sale runs.
 *
 * Used only by the fail-safe in `promoPriceCents()`; the discount itself is
 * computed from whatever base it is handed, so regional prices still get the
 * full percentage. Update it alongside a genuine change to list price.
 */
export const PROMO_LIST_PRICE_CENTS = 12999;

/**
 * The exact value that was written into `cohorts.price_cents` by hand — $78,
 * the sale price of the ORIGINAL 40%-off run of this promo. It is NOT the
 * current sale price (10% off $129.99 is $117); it is a fixed artifact of the
 * database row, and `listPriceCents()` / the double-discount guard both key off
 * it to recognise and repair that row. Do not "update" it to track the current
 * percent — that would stop it matching the 7800 still sitting in the row.
 * Retire it only when the row is set back to list price (12999). See
 * `listPriceCents()`.
 */
export const PROMO_SALE_PRICE_CENTS = 7800;

/**
 * The LIST price for a cohort row, repairing one known-bad value.
 *
 * `cohorts.price_cents` is supposed to hold list price. During this promo it
 * was set to the SALE price by hand instead, which made the site discount an
 * already-discounted number. `promoPriceCents()` stops that from producing $47
 * — but a guard alone is not enough, because it only fixes the price WHILE the
 * sale runs. On September 10 the promo stops discounting anything, the row
 * still says 7800, and the price silently stays $78 forever instead of
 * reverting to $130. That is the failure this function exists to prevent, and
 * it is the one nobody would notice, because it looks like nothing happened.
 *
 * So a row holding exactly the sale price is read as the list price it was
 * derived from. The site is then correct in BOTH states with no database edit:
 * $78 while the sale runs, $130 the moment it ends.
 *
 * SCOPE, and when to delete this. This is data repair living in code, and it
 * carries one real cost: a cohort deliberately priced at exactly $78 would be
 * read as $130. That ambiguity is exactly what the bad row created, and it is
 * resolved in favour of the overwhelmingly likelier case. Once
 * `cohorts.price_cents` is back to 12999, this function is dead weight —
 * delete it, and the tests named for it, along with the promo itself.
 */
export function listPriceCents(rowCents: number): number {
  return rowCents === PROMO_SALE_PRICE_CENTS ? PROMO_LIST_PRICE_CENTS : rowCents;
}

/**
 * Whether a `cohorts.price_cents` row already holds list price — i.e.
 * `listPriceCents()` did not have to repair it.
 *
 * The fixed Stripe Price object (`syncStripePrice` in the cohorts admin) is
 * created from `price_cents` AS-IS, so it only reflects list price when this is
 * true. When the row is the known $78 sale-price artifact, that Price object is
 * stale ($78), and the checkout route must NOT bill it — it has to fall through
 * to the ad-hoc `price_data` path, which charges the repaired list price. This
 * is why expiry alone left checkout charging $78 under a $130 headline: the row
 * was repaired everywhere the price is COMPUTED, but the fixed Stripe Price was
 * built from the bad row and never revisited.
 *
 * Retire alongside `listPriceCents()` once the row is back to 12999.
 */
export function rowHoldsListPrice(rowCents: number): boolean {
  return listPriceCents(rowCents) === rowCents;
}

export type Promo = {
  percent: number;
  /** "Sept 9" — the deadline, for a title tag with ~60 characters to spend. */
  shortDeadline: string;
  /** "September 9" — the deadline where there is room to spell it out. */
  longDeadline: string;
  /** "2026-09-09" — schema.org `priceValidUntil` format. */
  validUntil: string;
};

// Derived from the one date rather than transcribed from it. The previous
// version hardcoded "Sept 9" / "September 9" / "2026-09-09" here, three
// strings that had to be hand-updated in lockstep with PROMO_ENDS_AT; moving
// the deadline and forgetting one of them would have shown a countdown to one
// date under a headline naming another. `formatPromoDeadlines` already does
// exactly this for admin-set promos, so the seed now goes through the same
// code path and renders in the same timezone.
const SEED_DEADLINES = formatPromoDeadlines(PROMO_ENDS_AT);

const PROMO: Promo = {
  percent: PROMO_PERCENT,
  shortDeadline: SEED_DEADLINES.short,
  longDeadline: SEED_DEADLINES.long,
  validUntil: SEED_DEADLINES.validUntil,
};

/**
 * The admin-editable shape of the promotion.
 *
 * The constants above (`PROMO_PERCENT`, `PROMO_ENDS_AT`) are now the SEED for
 * this — the value the site runs on until an admin changes it at
 * /admin/pricing. Once /admin/pricing writes a `promo_*` row into
 * `site_settings`, `resolvePromoConfig()` turns those rows into one of these,
 * and every price surface reads through the config-aware overloads below.
 *
 * This type carries no dates-as-strings magic and no DB access: this module
 * stays dependency-free (it is imported by metadata builders that run during
 * static generation), so the DB read lives in `lib/promo-settings.ts` and the
 * marketing loader, and hands the plain object here.
 */
export type PromoConfig = {
  /** Master switch. When false, no promo runs regardless of percent/date. */
  enabled: boolean;
  /** Whole-number percent off list price, 0–90. 0 means no discount. */
  percent: number;
  /**
   * ISO instant the sale ends, or null for an open-ended promo with no
   * deadline. A null deadline drops every "ends <date>" label to "".
   */
  endsAt: string | null;
};

/** The seed promo — what the site runs on before any admin override. */
export const DEFAULT_PROMO_CONFIG: PromoConfig = {
  enabled: true,
  percent: PROMO_PERCENT,
  endsAt: PROMO_ENDS_AT,
};

/** True when a config is byte-for-byte the seed, so we can use the legacy path. */
export function isDefaultPromoConfig(c: PromoConfig): boolean {
  return (
    c.enabled === DEFAULT_PROMO_CONFIG.enabled &&
    c.percent === DEFAULT_PROMO_CONFIG.percent &&
    c.endsAt === DEFAULT_PROMO_CONFIG.endsAt
  );
}

/**
 * Turn raw `site_settings` values into a validated `PromoConfig`.
 *
 * Every field falls back to the seed when absent or malformed, so a missing
 * row, a half-written one, or a bad hand-edit can never take the site to a
 * nonsensical price. `percent` is clamped to 0–90 and rounded: a promo over
 * 90% off is almost always a fat-fingered "9" that meant 9, and clamping is
 * safer than charging near-zero. A `null` end date is honored (open-ended);
 * only `undefined`/absent falls back to the seed deadline.
 */
export function resolvePromoConfig(raw: {
  promo_enabled?: unknown;
  promo_percent?: unknown;
  promo_ends_at?: unknown;
}): PromoConfig {
  const enabled =
    typeof raw.promo_enabled === "boolean"
      ? raw.promo_enabled
      : DEFAULT_PROMO_CONFIG.enabled;

  let percent = DEFAULT_PROMO_CONFIG.percent;
  const rawPercent =
    typeof raw.promo_percent === "number"
      ? raw.promo_percent
      : typeof raw.promo_percent === "string" && raw.promo_percent.trim()
        ? Number(raw.promo_percent)
        : NaN;
  if (Number.isFinite(rawPercent)) {
    percent = Math.max(0, Math.min(90, Math.round(rawPercent)));
  }

  let endsAt: string | null = DEFAULT_PROMO_CONFIG.endsAt;
  if (raw.promo_ends_at === null) {
    endsAt = null;
  } else if (typeof raw.promo_ends_at === "string" && raw.promo_ends_at.trim()) {
    endsAt = Number.isNaN(new Date(raw.promo_ends_at).getTime())
      ? DEFAULT_PROMO_CONFIG.endsAt
      : raw.promo_ends_at;
  }

  return { enabled, percent, endsAt };
}

/**
 * Deadline labels derived from an admin-set end date, in the brand's timezone.
 *
 * Formatted in America/New_York rather than UTC on purpose: `endsAt` is an
 * instant like `2026-09-09T23:59:59-04:00`, whose UTC calendar date is already
 * the 10th. The seed strings ("Sept 9") were hand-written against Eastern, and
 * this keeps an admin-picked date reading as the day they picked. A null or
 * unparseable date yields empty labels, which the UI renders as a promo with
 * no deadline.
 */
export function formatPromoDeadlines(endsAt: string | null): {
  short: string;
  long: string;
  validUntil: string;
} {
  if (!endsAt) return { short: "", long: "", validUntil: "" };
  const d = new Date(endsAt);
  if (Number.isNaN(d.getTime())) return { short: "", long: "", validUntil: "" };
  const tz = "America/New_York";
  return {
    short: d.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      timeZone: tz,
    }),
    long: d.toLocaleDateString("en-US", {
      month: "long",
      day: "numeric",
      timeZone: tz,
    }),
    // en-CA renders YYYY-MM-DD, the schema.org priceValidUntil format.
    validUntil: d.toLocaleDateString("en-CA", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      timeZone: tz,
    }),
  };
}

/**
 * The promo if it is still running, otherwise null.
 *
 * IMPORTANT: this governs what the site *advertises*, not what Stripe charges.
 * The amount billed comes from the `cohorts.price_cents` row, which does not
 * revert on its own — when this returns null the marketing copy goes back to
 * list price, but the cohort row must be set back to 12999 by hand in
 * /admin/cohorts or checkout will keep charging the sale price.
 *
 * `config` is the admin-editable promo (from `site_settings`). Omitted — or
 * exactly equal to the seed — it takes the legacy path with the hand-written
 * "Sept 9" strings, so nothing about the site changes until an admin actually
 * edits the promo at /admin/pricing.
 */
export function activePromo(
  now: Date = new Date(),
  config?: PromoConfig,
): Promo | null {
  if (!config || isDefaultPromoConfig(config)) {
    return now.getTime() <= new Date(PROMO_ENDS_AT).getTime() ? PROMO : null;
  }

  if (!config.enabled || config.percent <= 0) return null;
  if (config.endsAt) {
    const end = new Date(config.endsAt).getTime();
    // A NaN end date means the config is malformed; treat it as no deadline
    // rather than instantly expiring (or crashing) the sale.
    if (!Number.isNaN(end) && now.getTime() > end) return null;
  }

  const d = formatPromoDeadlines(config.endsAt);
  return {
    percent: config.percent,
    shortDeadline: d.short,
    longDeadline: d.long,
    validUntil: d.validUntil,
  };
}

/**
 * What this promo charges for a given list price, in cents.
 *
 * Rounded to whole dollars, so the number advertised and the number charged
 * are the same number — the entire point of computing this in one place.
 *
 * Applied on top of regional pricing, never inside it — see lib/pricing.ts.
 * That ordering is what makes the discount reach every region equally
 * ($129.99 -> $117 in the U.S., $115 -> $104 in India) without anyone
 * hand-syncing a table.
 *
 * Returns `baseCents` unchanged once the promo has ended, which is what makes
 * expiry a no-op rather than a cleanup task.
 */
export function promoPriceCents(
  baseCents: number,
  now: Date = new Date(),
  config?: PromoConfig,
): number {
  const promo = activePromo(now, config);
  if (!promo) return baseCents;

  // Fail safe against a list price that has already had the sale applied to
  // it. The cohorts.price_cents row is supposed to hold LIST price, and this
  // function is what discounts it — but the row is hand-edited in an admin
  // form, and someone entering the sale price there instead is not a
  // hypothetical: it happened, and it billed $47 (40% off $78) under a
  // headline promising $78.
  //
  // The threshold is the fixed $78 the row was actually set to
  // (PROMO_SALE_PRICE_CENTS), NOT the current promo's sale price. Earlier this
  // recomputed the sale price from `promo.percent`, which was safe only while
  // that price sat below every real list price — true at 40% ($78), false at
  // 10% ($117), where the "sale price" rises above India's $115 list and the
  // guard would silently cancel a legitimate regional discount. Keying off the
  // stable bad-row value catches exactly the row that needs repairing and
  // leaves every genuine price — U.S. or regional — to be discounted.
  //
  // The tradeoff is deliberate: a cohort genuinely priced at or below $78 does
  // not receive the promo. That errs toward charging list, which is
  // recoverable, over charging a discount off a number that may already be one.
  if (baseCents <= PROMO_SALE_PRICE_CENTS) {
    return baseCents;
  }

  return discount(baseCents, promo.percent);
}

/**
 * Whole-dollar sale price. Rounded because every price the site quotes is
 * whole dollars: 10% off $129.99 is $116.991, and billing that literally would
 * put "$116.99" on a card statement under a headline promising "$117".
 */
function discount(baseCents: number, percent: number): number {
  return Math.round((baseCents * (100 - percent)) / 100 / 100) * 100;
}

/**
 * The homepage <title> while the promo runs.
 *
 * Budgeted under 60 characters, which is roughly what Google renders.
 *
 * The BRAND leads, which reverses the convention in app/layout.tsx, and the
 * reason is query intent. That convention exists for discovery searches, where
 * "batch0" carries no meaning and the page has to be findable by what it is.
 * This title is aimed at the opposite case — someone typing "batch0" — and
 * Google is markedly more willing to keep a title whose opening words match the
 * query it is answering. A title that opens on a discount instead reads as
 * promotional boilerplate, which is one of the documented triggers for Google
 * discarding it and writing its own from the page.
 *
 * So the offer sits second: still inside the visible window, still the first
 * thing after the name being searched for, but no longer the opening claim.
 */
export function promoTitle(promo: Promo): string {
  // An open-ended, admin-set promo has no deadline to name, so the "Until X"
  // clause drops out rather than rendering "Off Until  —".
  return promo.shortDeadline
    ? `batch0 — ${promo.percent}% Off Until ${promo.shortDeadline} — Startup Accelerator`
    : `batch0 — ${promo.percent}% Off Tuition — Startup Accelerator`;
}

/**
 * The homepage meta description while the promo runs.
 *
 * Replaces the cohort-dates snippet rather than prefixing it: the generated
 * description already spends its ~155 character budget, and Google truncates
 * the tail. The deadline is worth more than the cohort dates for as long as
 * the offer is live.
 */
export function promoMetaDescription(promo: Promo, salePrice: string, listPrice: string): string {
  // "10% off until October 21:" when there's a deadline, "10% off:" for an
  // open-ended admin promo — the colon and prices stay put either way.
  const lead = promo.longDeadline
    ? `${promo.percent}% off until ${promo.longDeadline}`
    : `${promo.percent}% off`;
  // `PROMO_SCOPE` is spent here at the cost of "Free to apply, no equity
  // taken", which the previous version carried. That is the right trade while
  // a sale runs: both of those claims are on the page and in the Offer markup
  // anyway, whereas the SCOPE of a discount is the one fact a searcher cannot
  // infer and the one an assistant will not assert unless we state it. The
  // budget is ~160 characters and this lands at ~149 with real prices.
  return `${lead}: tuition is ${salePrice}, not ${listPrice}, for our ${PROMO_SCOPE}. batch0 is a live, online startup accelerator for high schoolers.`;
}

/**
 * The schema.org `Offer` fields that express a SALE rather than a list price.
 *
 * Why this is a shared helper and not two literals: a sale is the one thing
 * structured data can state that a crawler cannot work out from the page, and
 * it is only legible if `price` (what you pay now), `priceValidUntil` (when
 * that stops being true) and the ListPrice specification (what it was) agree
 * with each other AND with the visible page. /program and / both emit an
 * Offer; building the sale half of both from one function is what keeps the
 * two pages from drifting into advertising different numbers.
 *
 * The `priceSpecification` + `priceType: ListPrice` pattern is the documented
 * way to declare a strikethrough price — `price` alone cannot say "was $130",
 * and a bare `price` of 129.99 during a sale actively contradicts the $117 on
 * the page, which is the kind of mismatch that gets rich results suppressed.
 *
 * `priceValidUntil` is omitted rather than left empty for an open-ended
 * admin-set promo: an empty date string is a validation error, while an absent
 * one simply makes no claim.
 */
export function saleOfferFields(
  promo: Promo,
  listCents: number,
  saleCents: number,
): Record<string, unknown> {
  const usd = (cents: number) => (cents / 100).toFixed(2);
  return {
    price: usd(saleCents),
    priceCurrency: "USD",
    ...(promo.validUntil ? { priceValidUntil: promo.validUntil } : {}),
    priceSpecification: {
      "@type": "UnitPriceSpecification",
      priceType: "https://schema.org/ListPrice",
      price: usd(listCents),
      priceCurrency: "USD",
    },
  };
}

/**
 * One sentence stating the live offer, for prose surfaces: the FAQ answer, the
 * /llms.txt summary, anywhere a full sentence is better than a badge.
 *
 * Says "site-wide" explicitly. That word is doing real work for the audience
 * this is aimed at — an assistant asked "does batch0 have a discount?" answers
 * from sentences it can quote, and "applies site-wide to our fall and winter
 * cohorts" is a complete, quotable answer in a way that a struck-through price
 * in a pricing table is not.
 *
 * Phrased as a STATEMENT, not an answer. It opened with "Yes —", which reads
 * correctly under the FAQ question and absurdly under the /llms.txt heading it
 * also feeds, where there is no question for it to be answering. Callers that
 * are answering a question prepend their own "Yes." — a separate sentence, so
 * neither caller has to re-case the first letter of this one.
 */
export function promoSentence(
  promo: Promo,
  salePrice: string,
  listPrice: string,
): string {
  // The year comes from `promo.validUntil` ("2026-10-21"), never from the seed
  // constant: an admin can set a deadline in a different year at
  // /admin/pricing, and reading PROMO_ENDS_AT here would have printed the
  // seed's year beside their date.
  const year = promo.validUntil.slice(0, 4);
  const deadline = promo.longDeadline
    ? ` The discount runs through ${promo.longDeadline}${year ? `, ${year}` : ""}.`
    : "";
  return (
    `There is a site-wide ${promo.percent}% discount on tuition for our ` +
    `${PROMO_SCOPE}, so tuition is ${salePrice} instead of ${listPrice}.` +
    `${deadline} It applies automatically; there is no code to enter, and it ` +
    `stacks with reduced regional pricing where that applies.`
  );
}
