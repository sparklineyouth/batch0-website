import type { SupabaseClient } from "@supabase/supabase-js";
import { stripe } from "@/lib/stripe";

type ProfileInput = {
  id: string;
  email: string | null;
  full_name: string | null;
  stripe_customer_id: string | null;
};

/**
 * Returns the Stripe customer ID to charge for this profile, creating and
 * persisting one when none is stored.
 *
 * A stored ID is trusted as-is — no pre-validating `customers.retrieve`.
 * That round trip (~200-400ms) would sit on every checkout click to guard
 * a rare state: a stored ID only goes stale through Stripe-mode drift
 * (test and live don't share customer IDs) or a hand-deletion in the
 * dashboard. Both surface as `resource_missing` on the caller's next
 * Stripe call, which the checkout routes report via stripeErrorMessage()
 * below, and which the portal route heals by nulling
 * `profiles.stripe_customer_id` so a later payment re-creates it.
 */
export async function getOrCreateStripeCustomer(
  admin: SupabaseClient,
  profile: ProfileInput,
  fallbackEmail: string | null | undefined,
): Promise<string> {
  if (profile.stripe_customer_id) {
    return profile.stripe_customer_id;
  }

  const customer = await stripe.customers.create({
    email: profile.email ?? fallbackEmail ?? undefined,
    name: profile.full_name ?? undefined,
    metadata: { supabase_user_id: profile.id },
  });

  await admin
    .from("profiles")
    .update({ stripe_customer_id: customer.id })
    .eq("id", profile.id);

  return customer.id;
}

/**
 * Turn a Stripe SDK error into a user-readable message. Falls back to a
 * generic string so we never leak raw internals to end users, but logs
 * the full error for server-side debugging.
 */
export function stripeErrorMessage(err: unknown): string {
  const e = err as { code?: string; message?: string; raw?: { message?: string } };
  const raw = e?.raw?.message ?? e?.message ?? "";
  if (/no such price/i.test(raw)) {
    return "This cohort's Stripe price is from a different Stripe mode (test vs live). Open the cohort in admin and save it to regenerate the price.";
  }
  if (/no such customer/i.test(raw)) {
    return "Your Stripe customer record is from a different Stripe mode. Try again — we'll create a fresh one.";
  }
  if (e?.code === "rate_limit") {
    return "Stripe is rate-limiting requests. Try again in a moment.";
  }
  return "Could not start checkout. Please try again, and contact us if it persists.";
}
