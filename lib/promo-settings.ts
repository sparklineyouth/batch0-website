import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { resolvePromoConfig, type PromoConfig } from "@/lib/promo";

// The DB bridge for the promotion.
//
// `lib/promo.ts` is deliberately dependency-free (metadata builders import it
// during static generation), so it can compute a price from a `PromoConfig`
// but can't fetch one. This module is the other half: it reads the three
// `promo_*` rows out of `site_settings` and hands back a resolved config.
//
// The marketing site does NOT use this — `lib/site-config.ts` already loads
// the full settings record and resolves the promo inline, so a marketing page
// costs no extra round-trip. This exists for the code paths that charge a card
// or quote a price WITHOUT going through site-config: the Stripe checkout
// route, the two dashboard payment pages, and the acceptance email. Each must
// read the same admin-set promo so the number quoted is the number billed.
//
// Reads through the service-role (no-store) client, so it must only be called
// from dynamic server contexts — never a statically generated route.

const PROMO_KEYS = ["promo_enabled", "promo_percent", "promo_ends_at"] as const;

/**
 * Resolve the admin-set promotion from `site_settings`.
 *
 * Never throws: a Supabase error or missing rows falls through
 * `resolvePromoConfig`, which returns the seed config — so a failed read keeps
 * the site on the same promo the marketing pages would show, rather than
 * silently zeroing the discount at checkout.
 */
export async function loadPromoConfig(): Promise<PromoConfig> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("site_settings")
    .select("key, value")
    .in("key", PROMO_KEYS as unknown as string[]);

  const raw: Record<string, unknown> = {};
  for (const row of data ?? []) raw[row.key] = row.value;

  return resolvePromoConfig({
    promo_enabled: raw.promo_enabled,
    promo_percent: raw.promo_percent,
    promo_ends_at: raw.promo_ends_at,
  });
}
