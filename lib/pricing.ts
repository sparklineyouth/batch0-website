// Regional pricing for batch0 tuition.
//
// All amounts are billed in USD. We adjust the USD price by detected
// country so that purchasing-power differences don't price out applicants
// in lower-income regions. The cohort row's `price_cents` is the default
// (charged to anyone we don't have an override for). Overrides are listed
// below — keep this table small and explicit.
//
// Detection uses the request country header set by Vercel
// (`x-vercel-ip-country`). If you front the site with Cloudflare or
// another CDN, `cf-ipcountry` is also honored. When neither is present
// (local dev, missing header) we fall back to the default price.

// The U.S. base tuition in cents — the single source of truth for the
// default price. Used as the fallback everywhere a cohort row's `price_cents`
// is missing, and mirrored by the fallback cohort in lib/site-config.ts, so
// $130 is stated in exactly one place.
export const DEFAULT_PRICE_CENTS = 13000;

const PRICE_OVERRIDES_CENTS: Record<string, number> = {
  // India — PPP-adjusted vs. the U.S. base.
  IN: 11500,
};

export type RegionalPrice = {
  /** The price the visitor will actually be charged, in cents (USD). */
  amountCents: number;
  /** Country ISO-3166-1 alpha-2 we resolved, or null if undetected. */
  country: string | null;
  /** True when an override applied (i.e. price differs from base). */
  isRegional: boolean;
};

export function getCountryFromHeaders(h: Headers): string | null {
  const raw =
    h.get("x-vercel-ip-country") ??
    h.get("cf-ipcountry") ??
    h.get("x-country") ??
    null;
  if (!raw) return null;
  const cc = raw.trim().toUpperCase();
  // Some CDNs send "XX" / "T1" for unknown / Tor exits. Treat them as
  // missing rather than as a literal country code.
  if (cc.length !== 2 || cc === "XX" || cc === "T1") return null;
  return cc;
}

export function getRegionalPrice(
  baseCents: number,
  countryCode: string | null,
): RegionalPrice {
  if (!countryCode) {
    return { amountCents: baseCents, country: null, isRegional: false };
  }
  const override = PRICE_OVERRIDES_CENTS[countryCode];
  if (typeof override === "number" && override !== baseCents) {
    return { amountCents: override, country: countryCode, isRegional: true };
  }
  return { amountCents: baseCents, country: countryCode, isRegional: false };
}
