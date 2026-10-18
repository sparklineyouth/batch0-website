import test from "node:test";
import assert from "node:assert/strict";

// Run with `npm test`. lib/stripe.ts used to build its client at import, and
// `new Stripe(undefined)` throws — so a build, a route or a test that merely
// imported something importing it failed without STRIPE_SECRET_KEY. Now the
// key is read on first use. No network: nothing here calls Stripe.

delete process.env.STRIPE_SECRET_KEY;
const { stripe, getStripe } = await import("./stripe.ts");

test("importing it without a key is fine; only using it says what's missing", () => {
  assert.throws(() => stripe.checkout, /STRIPE_SECRET_KEY isn't set/);
  assert.throws(() => getStripe(), /STRIPE_SECRET_KEY isn't set/);
});

test("with the key set, every caller gets the one real client, made once", () => {
  process.env.STRIPE_SECRET_KEY = "sk_test_not_a_real_key";
  const real = getStripe();
  assert.equal(getStripe(), real, "made once");
  // The resources callers use, as the real client has them.
  for (const r of ["checkout", "customers", "charges", "refunds", "paymentIntents", "prices", "products", "billingPortal", "events", "webhooks"] as const) {
    assert.equal((stripe as any)[r], (real as any)[r], r);
  }
  assert.equal(typeof stripe.checkout.sessions.create, "function");
  assert.equal(typeof stripe.webhooks.constructEvent, "function");
  // A method read off the proxy is bound to the real client.
  const getApiField = (stripe as any).getApiField;
  assert.equal(typeof getApiField, "function");
  assert.equal(getApiField("version"), (real as any).getApiField("version"));
  assert.equal(getApiField("version"), "2025-02-24.acacia");
});
