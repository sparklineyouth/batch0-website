import test from "node:test";
import assert from "node:assert/strict";
import * as nodeModule from "node:module";
import { pathToFileURL, fileURLToPath } from "node:url";
import path from "node:path";
import { hashPayerToken, createPayerToken } from "./payer-token.ts";

// Execute the real service and HTTP handlers with isolated provider doubles.
// No process environment, credentials, Stripe/Supabase network or mail is used.
const root = fileURLToPath(new URL("../", import.meta.url));
const state: any = {};
const applicationId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const userId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const cohortId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const sessionId = "cs_test_mock_parent_checkout_1234567890";
function reset() {
  Object.assign(state, {
    actor: { userId, caps: { review: false } }, user: { id: userId }, allowed: true,
    app: { id: applicationId, user_id: userId, cohort_id: cohortId, status: "accepted", pricing_country: "IN",
      cohort: { id: cohortId, name: "Test cohort", status: "upcoming", starts_on: "2099-01-01", ends_on: "2099-03-01", price_cents: 12999 },
      why_join: "PRIVATE_ESSAY", parent_email: "PRIVATE_EMAIL", },
    reservation: null, payerLink: null, stripeCreates: [], stripeSession: null, attachFailures: 0,
    pass: null, award: null, pricingError: null, fulfillment: { state: "paid", enrollmentBlocked: false },
    attaches: 0, failCreate: false,
  });
}
reset();
const db: any = {
  from(table: string) {
    let action = "select"; let payload: any; const filters: [string,string,any][] = [];
    const result = () => {
      if (table === "enrollments") return { data: null, error: null };
      if (table === "applications") return { data: state.app, error: null };
      if (table === "checkout_reservations") {
        if (action === "update" && state.reservation) Object.assign(state.reservation, payload);
        const r = state.reservation;
        const matches = r && filters.every(([op,key,value]) => op === "eq" ? r[key] === value : op === "gt" ? r[key] > value : true);
        return { data: matches ? r : null, error: null };
      }
      if (table === "payer_links") {
        if (action === "upsert") { state.payerLink = { id: "invitation", ...payload }; return { error: null }; }
        const link = state.payerLink;
        return { data: link && filters.every(([,key,value]) => link[key] === value) ? link : null, error: null };
      }
      if (table === "site_settings") return { data: [], error: state.pricingError };
      if (table === "founder_passes") return { data: state.pass, error: null };
      if (table === "scholarship_applications") return { data: state.award, error: null };
      throw new Error(`Unexpected test table ${table}`);
    };
    const chain: any = { then(resolve: any, reject: any) { return Promise.resolve().then(result).then(resolve,reject); } };
    for (const method of ["select","maybeSingle","single","order","limit"]) chain[method] = () => chain;
    for (const method of ["eq","gt","is","in"]) chain[method] = (key: string, value: any) => { filters.push([method,key,value]); return chain; };
    chain.upsert = (value: any) => { action = "upsert"; payload = value; return chain; };
    chain.update = (value: any) => { action = "update"; payload = value; return chain; };
    return chain;
  },
  async rpc(name: string, args: any) {
    if (name === "reserve_checkout_seat") {
      if (!state.reservation || state.reservation.status === "released") {
        state.reservation = { id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", application_id: applicationId, user_id: userId,
          cohort_id: cohortId, quote: structuredClone(args.p_quote), expires_at: new Date(Date.now()+35*60*1000).toISOString(), stripe_session_id: null, status: "active" };
      }
      return { data: structuredClone(state.reservation), error: null };
    }
    if (name === "attach_checkout_session") {
      if (state.attachFailures-- > 0) return { data: null, error: { message: "Temporary DB outage" } };
      state.reservation.stripe_session_id = args.p_session_id; state.attaches++;
      return { data: null, error: null };
    }
    throw new Error(`Unexpected test RPC ${name}`);
  },
};
const stripeDouble: any = { checkout: { sessions: {
  async create(params: any, options: any) {
    state.stripeCreates.push({ params: structuredClone(params), options: structuredClone(options) });
    if (state.failCreate) throw new Error("Provider unavailable");
    state.stripeSession ??= { id: sessionId, status: "open", url: "https://checkout.stripe.com/c/pay/mock", metadata: params.metadata };
    return structuredClone(state.stripeSession);
  },
  async retrieve(id: string) {
    assert.equal(id, sessionId);
    return structuredClone(state.stripeSession);
  },
} } };
(globalThis as any).__checkoutIntegration = { state, db, stripe: stripeDouble };
const fake = (source: string) => `data:text/javascript,${encodeURIComponent(source)}`;
const hook = (nodeModule as any).registerHooks({ resolve(specifier: string, context: any, next: any) {
  const globals = "const t=globalThis.__checkoutIntegration;";
  const doubles: Record<string,string> = {
    "@/lib/stripe": globals + "export const stripe=t.stripe;",
    "@/lib/env": "export const env={siteUrl:'https://batch0.test'};",
    "@/lib/supabase/admin": globals + "export const createAdminClient=()=>t.db;",
    "@/lib/supabase/server": globals + "export const createClient=async()=>({auth:{getUser:async()=>({data:{user:t.state.user}})}});",
    "@/lib/server-guards": globals + "export async function requireActor(){if(!t.state.actor)throw Error('Not signed in');return t.state.actor;}",
    "@/lib/permissions": "export const can=(caps,key)=>key==='applications.review'&&caps.review===true;",
    "@/lib/rate-limit": globals + "export const checkRateLimit=async()=>({ok:t.state.allowed});export const clientIp=()=> 'test-ip';",
    "@/lib/stripe-fulfillment": globals + "export const fulfillCheckoutSession=async()=>t.state.fulfillment;",
    "next/server": "export const NextResponse={json:(data,options)=>new Response(JSON.stringify(data),{...options,headers:{'Content-Type':'application/json',...options?.headers}})};",
  };
  if (doubles[specifier]) return { url: fake(doubles[specifier]), shortCircuit: true };
  if (specifier.startsWith("@/")) return next(pathToFileURL(path.join(root,specifier.slice(2)+".ts")).href,context);
  return next(specifier,context);
} });
const service = await import("./checkout-service.ts");
const { POST: checkout } = await import("../app/api/stripe/checkout/route.ts");
const { POST: payerLink } = await import("../app/api/stripe/payer-link/route.ts");
const { POST: payerQuote } = await import("../app/api/stripe/payer-quote/route.ts");
const { POST: payerCheckout } = await import("../app/api/stripe/payer-checkout/route.ts");
const { POST: payerStatus } = await import("../app/api/stripe/payer-status/route.ts");
function request(route: string, body: any) {
  return new Request(`https://batch0.test/api/stripe/${route}`, { method: "POST", headers: { "Content-Type": "application/json", Origin: "https://batch0.test" }, body: JSON.stringify(body) });
}
async function invitation() {
  const response = await payerLink(request("payer-link", { applicationId }));
  assert.equal(response.status, 200);
  const body = await response.json();
  return new URL(body.url).hash.slice("#token=".length);
}

test("student and parent share one Stripe checkout; client amount and parent region cannot override the student's quote", async () => {
  reset(); const token = await invitation();
  const parent = await payerCheckout(request("payer-checkout", { token, amountCents: 1, country: "US" }));
  const student = await checkout(request("checkout", { applicationId, amountCents: 1 }));
  assert.equal(parent.status, 200); assert.equal(student.status, 200);
  assert.deepEqual(await parent.json(), await student.json());
  assert.equal(state.stripeCreates.length, 1);
  const params = state.stripeCreates[0].params;
  assert.equal(params.line_items[0].price_data.unit_amount, 11500);
  assert.equal(params.customer, undefined); assert.equal(params.customer_email, undefined);
  assert.equal(params.metadata.application_id, applicationId);
  assert.equal(params.payment_intent_data.metadata.checkout_reservation_id, state.reservation.id);
  assert.equal(new URL(params.success_url).hash, "#session_id={CHECKOUT_SESSION_ID}");
  assert.equal(new URL(params.success_url).search, "");
});
test("failure after Stripe creation retries the same key and parameters without exposing an unattached checkout", async () => {
  reset(); state.attachFailures = 1;
  const first = await checkout(request("checkout", { applicationId }));
  assert.equal(first.status, 503); assert.equal((await first.json()).url, undefined);
  state.app.cohort.name = "Renamed after Stripe created the session";
  const retry = await checkout(request("checkout", { applicationId }));
  assert.equal(retry.status, 200); assert.equal(state.stripeCreates.length, 2);
  assert.deepEqual(state.stripeCreates[0], state.stripeCreates[1]);
  assert.equal(state.attaches, 1);
});
test("an uncertain Stripe creation failure keeps the hold and never returns a payment URL", async () => {
  reset(); state.failCreate = true;
  const originalError = console.error; console.error = () => {};
  let response: Response;
  try { response = await checkout(request("checkout", { applicationId })); }
  finally { console.error = originalError; }
  assert.equal(response!.status, 503);
  assert.equal((await response!.json()).url, undefined);
  assert.equal(state.reservation.status, "active");
  assert.equal(state.attaches, 0);
  state.failCreate = false;
  assert.equal((await checkout(request("checkout", { applicationId }))).status, 200);
  assert.deepEqual(state.stripeCreates[0], state.stripeCreates[1]);
});
test("a full scholarship generates a zero-dollar Stripe checkout with the same fulfillment metadata", async () => {
  reset(); state.award = { award_cents: 12999, award_percent: 100, fulfillment: "discount" };
  const response = await checkout(request("checkout", { applicationId }));
  assert.equal(response.status, 200);
  assert.equal(state.stripeCreates[0].params.line_items[0].price_data.unit_amount, 0);
  assert.equal(state.stripeCreates[0].params.metadata.scholarship_discount_cents, "11500");
  assert.equal(state.stripeCreates[0].params.payment_intent_data, undefined);
});
test("a sub-minimum remainder is waived and recorded instead of charging above the promised tuition", async () => {
  reset(); state.award = { award_cents: 11475, award_percent: null, fulfillment: "discount" };
  const response = await checkout(request("checkout", { applicationId }));
  assert.equal(response.status, 200);
  assert.equal(state.stripeCreates[0].params.line_items[0].price_data.unit_amount, 0);
  assert.equal(state.stripeCreates[0].params.metadata.residual_waiver_cents, "25");
});
test("a payment invitation grants no account access or private answers, and regenerated links revoke old tokens", async () => {
  reset(); const oldToken = await invitation(); const token = await invitation();
  assert.notEqual(oldToken, token);
  assert.equal(state.payerLink.token_hash, hashPayerToken(token));
  assert.equal(JSON.stringify(state.payerLink).includes(token), false);
  assert.equal((await payerQuote(request("payer-quote", {token:oldToken}))).status, 410);
  const response = await payerQuote(request("payer-quote", {token}));
  const json = await response.json();
  assert.equal(json.amountCents, 11500); assert.equal(json.cohortId, cohortId);
  assert.equal(JSON.stringify(json).includes("PRIVATE_"), false);
  assert.equal(json.user_id, undefined); assert.equal(json.application_id, undefined);
  assert.equal(response.headers.get("cache-control"), "no-store, private");
});
test("expired, revoked and malformed invitations cannot start Stripe checkout", async () => {
  reset(); const token = await invitation(); state.payerLink.expires_at = "2000-01-01T00:00:00Z";
  assert.equal((await payerCheckout(request("payer-checkout", {token}))).status, 410);
  state.payerLink.expires_at = "2099-01-01T00:00:00Z"; state.app.status = "withdrawn";
  assert.equal((await payerCheckout(request("payer-checkout", {token}))).status, 400);
  assert.equal((await payerCheckout(request("payer-checkout", {token:"malformed"}))).status, 404);
  assert.equal(state.stripeCreates.length, 0);
});
test("ownership is required; permitted staff can create a link but cannot borrow their own pricing region", async () => {
  reset(); state.user = {id:"outsider"};
  assert.equal((await checkout(request("checkout", {applicationId}))).status, 404);
  state.actor = {userId:"staff",caps:{review:false}};
  assert.equal((await payerLink(request("payer-link", {applicationId}))).status, 404);
  state.actor.caps.review = true;
  assert.equal((await payerLink(request("payer-link", {applicationId}))).status, 200);
  assert.equal(state.payerLink.quote.amountCents, 11500);
});
test("unknown status, mismatched metadata and blocked paid enrollment never return a false confirmation", async () => {
  reset(); await checkout(request("checkout", {applicationId}));
  state.fulfillment = {state:"paid",enrollmentBlocked:true};
  const review = await payerStatus(request("payer-status", {sessionId,status:"confirmed"}));
  assert.deepEqual(await review.json(), {status:"review"});
  state.fulfillment = {state:"processing",enrollmentBlocked:false};
  assert.deepEqual(await (await payerStatus(request("payer-status", {sessionId}))).json(), {status:"pending"});
  state.stripeSession.metadata.user_id = "someone-else";
  assert.equal((await payerStatus(request("payer-status", {sessionId}))).status, 404);
});
test("pricing outage and cross-origin requests cannot create a Stripe session", async () => {
  reset(); state.pricingError = {message:"offline"};
  assert.equal((await checkout(request("checkout", {applicationId}))).status, 503);
  assert.equal(state.stripeCreates.length, 0);
  const forged = new Request("https://batch0.test/api/stripe/payer-link", {method:"POST",headers:{"Content-Type":"application/json",Origin:"https://evil.test"},body:JSON.stringify({applicationId})});
  assert.equal((await payerLink(forged)).status, 403);
});

test("Fall checkout stops at Eastern midnight without moving an accepted application to Winter", async t => {
  reset();
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-10-01T03:59:59.999Z") });
  Object.assign(state.app.cohort, { status: "active", starts_on: "2026-09-14", ends_on: "2026-11-13",
    late_entry_until: "2026-09-30T23:59:59.999-04:00", catch_up_plan: "Review Week 1 with the team." });
  await service.checkCheckoutEligibility(db, state.app);
  t.mock.timers.setTime(Date.parse("2026-10-01T04:00:00Z"));
  assert.equal((await checkout(request("checkout", { applicationId }))).status, 409);
  assert.equal((await payerLink(request("payer-link", { applicationId }))).status, 409);
  assert.equal(state.stripeCreates.length, 0);
  assert.equal(state.app.cohort_id, cohortId);
});

test.after(() => { hook.deregister(); delete (globalThis as any).__checkoutIntegration; });
