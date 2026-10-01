import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import {
  PAYMENT_FRAGMENT_SCRIPT,
  SECRET_URL_ANALYTICS_SCRIPT,
  isAnalyticsBlockedPath,
  isPrivatePaymentPath,
  isSecretUrlPath,
  payerReturnStatus,
  redactSecretUrls,
} from "./payment-privacy.ts";

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

const SUPPORT_TOKEN = "s".repeat(43);
const DEMO_DAY_TOKEN = "d".repeat(32);
const NEAR_MISSES = ["/support", "/support/t", "/support/team", "/support/tickets/x", "/dashboard/support/B0-7K2M9Q",
  "/demo-day", "/demo-day/ticket", "/demo-day/tickets/x", "/pay", "/"];

test("a secret URL is a token page, matched by prefix, and nothing near one", () => {
  for (const path of [`/support/t/${SUPPORT_TOKEN}`, `/support/t/${SUPPORT_TOKEN}/files/1`, `/demo-day/ticket/${DEMO_DAY_TOKEN}`]) {
    assert.equal(isSecretUrlPath(path), true, path);
    assert.equal(isAnalyticsBlockedPath(path), true, path);
  }
  for (const path of [...NEAR_MISSES, null]) assert.equal(isSecretUrlPath(path), false, String(path));
  assert.equal(isAnalyticsBlockedPath("/pay"), true);
  assert.equal(isAnalyticsBlockedPath("/payments"), false);
});

test("GA is switched off before any GA code on exactly the secret-URL pages", () => {
  const paths = [`/support/t/${SUPPORT_TOKEN}`, `/support/t/${SUPPORT_TOKEN}/files/1`, `/demo-day/ticket/${DEMO_DAY_TOKEN}`, ...NEAR_MISSES];
  for (const pathname of paths) {
    const window: Record<string, unknown> = {};
    runInNewContext(SECRET_URL_ANALYTICS_SCRIPT, { window, location: { pathname, search: "", hash: "" } });
    assert.equal(window["ga-disable-G-C51DMRB6YE"] === true, isSecretUrlPath(pathname), pathname);
  }
});

test("both early scripts disable the GA property the layout actually loads", () => {
  const layout = readFileSync(new URL("../app/layout.tsx", import.meta.url), "utf8");
  const id = layout.match(/const GA_MEASUREMENT_ID = "(G-[A-Z0-9]+)"/)?.[1];
  assert.ok(id, "app/layout.tsx still declares GA_MEASUREMENT_ID");
  for (const script of [PAYMENT_FRAGMENT_SCRIPT, SECRET_URL_ANALYTICS_SCRIPT]) {
    assert.ok(script.includes(`window['ga-disable-${id}']=true`), script.slice(0, 60));
  }
});

test("Sentry data loses every secret-URL token and keeps everything else", () => {
  assert.equal(redactSecretUrls(`https://batch0.org/support/t/${SUPPORT_TOKEN}?x=1#y`), "https://batch0.org/support/t/[token]?x=1#y");
  assert.equal(redactSecretUrls(`GET /demo-day/ticket/${DEMO_DAY_TOKEN}`), "GET /demo-day/ticket/[token]");
  assert.equal(
    redactSecretUrls(`/support/t/${SUPPORT_TOKEN}/files/0b5f3c1e-7a8d-4e2f-9c6b-1d2e3f4a5b6c`),
    "/support/t/[token]/files/0b5f3c1e-7a8d-4e2f-9c6b-1d2e3f4a5b6c",
    "not anchored to the end: the attachment route carries the token too",
  );
  assert.equal(
    redactSecretUrls(`/support?topic=technical&from=%2Fsupport%2Ft%2F${SUPPORT_TOKEN}&digest=1`),
    "/support?topic=technical&from=%2Fsupport%2Ft%2F[token]&digest=1",
    "a path inside a query value is percent-encoded",
  );
  assert.equal(redactSecretUrls("GET /support/t/[token]"), "GET /support/t/[token]", "idempotent");
  for (const kept of NEAR_MISSES) assert.equal(redactSecretUrls(kept), kept);

  const consoleArg = { href: `/support/t/${SUPPORT_TOKEN}` };
  const event = {
    transaction: `/support/t/${SUPPORT_TOKEN}`,
    request: { url: `https://batch0.org/support/t/${SUPPORT_TOKEN}`, headers: { Referer: `https://batch0.org/demo-day/ticket/${DEMO_DAY_TOKEN}` } },
    breadcrumbs: [{ category: "navigation", data: { from: `/support/t/${SUPPORT_TOKEN}`, to: "/" } }, { category: "console", data: { arguments: [consoleArg] } }],
    spans: [{ description: `POST /support/t/${SUPPORT_TOKEN}`, data: { "http.url": `https://batch0.org/support/t/${SUPPORT_TOKEN}` } }],
    level: "error",
  };
  const before = structuredClone(event);
  const scrubbed = redactSecretUrls(event);
  assert.deepEqual(event, before, "never in place: breadcrumb data can be the app's live objects");
  assert.equal(consoleArg.href, `/support/t/${SUPPORT_TOKEN}`);
  const sent = JSON.stringify(scrubbed);
  assert.ok(!sent.includes(SUPPORT_TOKEN) && !sent.includes(DEMO_DAY_TOKEN), sent);
  assert.equal(scrubbed.transaction, "/support/t/[token]");
  assert.equal(scrubbed.level, "error");

  const clean = { request: { url: "https://batch0.org/dashboard" }, breadcrumbs: [{ data: { to: "/" } }] };
  assert.equal(redactSecretUrls(clean), clean, "nothing to scrub: the same object back");
  const shared = { url: `/support/t/${SUPPORT_TOKEN}` };
  const cyclic: Record<string, unknown> = { a: shared, b: shared };
  cyclic.self = cyclic;
  assert.ok(!JSON.stringify(redactSecretUrls({ a: shared, b: shared })).includes(SUPPORT_TOKEN), "a shared object is scrubbed everywhere it appears");
  assert.doesNotThrow(() => redactSecretUrls(cyclic));
});
