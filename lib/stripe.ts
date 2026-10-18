import Stripe from "stripe";

let client: Stripe | null = null;

/**
 * The one Stripe client, made on first use.
 *
 * It used to be made at import time, and `new Stripe(undefined)` throws
 * ("Neither apiKey nor config.authenticator provided") — so any page, route or
 * build step that merely imported a module importing this one failed without
 * STRIPE_SECRET_KEY, whether or not it ever charged anyone: a preview without
 * Stripe configured, a local build, a test. Now the key is read the first
 * time something actually talks to Stripe, and only that call fails without
 * it. With the key set, the client is the same one, made the same way.
 */
export function getStripe(): Stripe {
  if (!client) {
    const key = process.env.STRIPE_SECRET_KEY;
    if (!key) throw new Error("STRIPE_SECRET_KEY isn't set, so Stripe can't be reached.");
    client = new Stripe(key, {
      apiVersion: "2025-02-24.acacia",
      typescript: true,
    });
  }
  return client;
}

/**
 * `stripe.checkout.sessions.create(...)` and the rest, unchanged for every
 * caller: each property read goes to getStripe(), so importing this costs
 * nothing until the first call. Methods are bound to the real client, which
 * is what they'd have been called on before.
 */
export const stripe: Stripe = new Proxy({} as Stripe, {
  get(_target, prop) {
    const real = getStripe();
    const value = Reflect.get(real, prop, real);
    return typeof value === "function" ? value.bind(real) : value;
  },
});
