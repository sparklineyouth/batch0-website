import { test } from "node:test";
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import { PAYMENT_FRAGMENT_SCRIPT, isPrivatePaymentPath, payerReturnStatus } from "./payment-privacy.ts";

test("payer bearer token is removed before analytics and kept only in memory", () => {
  const token = "a".repeat(43);
  const calls: unknown[][] = [];
  const window: Record<string, unknown> = {};
  runInNewContext(PAYMENT_FRAGMENT_SCRIPT, {
    window, URLSearchParams,
    location: { pathname: "/pay", search: "", hash: `#token=${token}` },
    history: { state: null, replaceState: (...args: unknown[]) => calls.push(args) },
  });
  assert.equal(window.__batch0PayerToken, token);
  assert.equal(window["ga-disable-G-C51DMRB6YE"], true);
  assert.deepEqual(calls, [[null, "", "/pay"]]);
});
test("Stripe session survives URL cleanup but arbitrary fragments do not", () => {
  for (const session of ["cs_test_abc123", "cs_live_abc123", "bad-session"]) {
    const window: Record<string, unknown> = {};
    runInNewContext(PAYMENT_FRAGMENT_SCRIPT, {
      window, URLSearchParams,
      location: { pathname: "/pay/", search: "", hash: `#session_id=${session}` },
      history: { state: null, replaceState: () => {} },
    });
    assert.equal(window.__batch0CheckoutSession, session.startsWith("cs_") ? session : undefined);
  }
});
test("the payment privacy boundary does not swallow unrelated paths", () => {
  assert.equal(isPrivatePaymentPath("/pay"), true);
  assert.equal(isPrivatePaymentPath("/pay/"), true);
  assert.equal(isPrivatePaymentPath("/payments"), false);
  assert.equal(isPrivatePaymentPath("/parents"), false);
  assert.equal(isPrivatePaymentPath(null), false);
});

test("spoofed success query cannot confirm a payment", () => {
  for (const forged of ["confirmed", "review", "paid", null]) assert.equal(payerReturnStatus(forged), "");
  assert.equal(payerReturnStatus("complete"), "pending");
  assert.equal(payerReturnStatus("canceled"), "canceled");
});
