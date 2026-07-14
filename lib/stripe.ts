import Stripe from "stripe";

// Lazily constructed so that merely importing `stripe` doesn't instantiate the
// SDK at module-load time. The Stripe constructor throws when STRIPE_SECRET_KEY
// is absent, which crashed `next build`'s page-data collection (and any env-less
// CI/preview build) even for routes that never call Stripe. The client is built
// on first real property access instead; all call sites keep using `stripe.x`.
let client: Stripe | null = null;

function getStripe(): Stripe {
  if (!client) {
    client = new Stripe(process.env.STRIPE_SECRET_KEY!, {
      apiVersion: "2025-02-24.acacia",
      typescript: true,
    });
  }
  return client;
}

export const stripe: Stripe = new Proxy({} as Stripe, {
  get(_target, prop, receiver) {
    const value = Reflect.get(getStripe(), prop, receiver);
    return typeof value === "function" ? value.bind(getStripe()) : value;
  },
});
