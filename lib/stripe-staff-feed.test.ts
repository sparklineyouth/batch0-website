import test from "node:test";
import assert from "node:assert/strict";
import * as nodeModule from "node:module";
import { pathToFileURL, fileURLToPath } from "node:url";
import path from "node:path";

// Run the real lib/stripe-fulfillment.ts against doubles and count the
// #staff lines: an enrollment or an enrollment refund gets exactly one,
// whichever path records it first — including the silent ones (the daily
// reconcile cron, "Sync from Stripe", an admin refund) — and a replay of
// the same money gets none.

const USER = "00000000-0000-4000-8000-0000000000u1";
const APP = "00000000-0000-4000-8000-0000000000a1";
const COHORT = "00000000-0000-4000-8000-0000000000c1";

const state = {
  feed: [] as string[],
  student: [] as string[], // what reached the student: receipts and notifications
  settlement: { newly_enrolled: true, blocked: false } as Record<string, unknown>,
  refund: { matched: true, changed: true, user_id: USER, full: true } as Record<string, unknown>,
  /** A fee or fine on the same payment intent, or none (an enrollment payment). */
  fine: null as null | { id: string; user_id: string; status: string; amount_refunded_cents: number; kind: string },
  /** Whether this run's conditional write is the first to record the refund. */
  firstToRecord: true,
};
function reset() {
  state.feed = [];
  state.student = [];
  state.settlement = { newly_enrolled: true, blocked: false };
  state.refund = { matched: true, changed: true, user_id: USER, full: true };
  state.fine = null;
  state.firstToRecord = true;
}

const db = {
  rpc: async (fn: string) => {
    if (fn === "settle_enrollment_payment") return { data: state.settlement, error: null };
    if (fn === "apply_enrollment_refund") return { data: state.refund, error: null };
    throw new Error(`unexpected rpc ${fn}`);
  },
  from(table: string) {
    const ops: string[] = [];
    const result = () => {
      if (table === "cohorts") return { data: { name: "Fall 2026", starts_on: "2099-01-01", status: "upcoming" }, error: null };
      if (table === "profiles") return { data: { full_name: "Ada Lovelace", email: "ada@example.com" }, error: null };
      if (table === "user_charges" && state.fine) {
        // update(...).lt(...).select("id"): the claim to record the refund first.
        if (ops.includes("update") && ops.includes("lt")) return { data: state.firstToRecord ? [{ id: state.fine.id }] : [], error: null };
        if (ops.includes("update")) return { data: null, error: null };
        return { data: state.fine, error: null };
      }
      if (table === "user_charges" || table === "demo_day_tickets") return { data: null, error: null };
      if (table === "audit_log") return { count: 0, error: null };
      throw new Error(`unexpected table ${table}`);
    };
    const chain: any = {
      then: (resolve: any, reject: any) => Promise.resolve().then(result).then(resolve, reject),
      maybeSingle: async () => result(),
      single: async () => result(),
    };
    for (const m of ["select", "eq", "update", "lte", "lt", "order", "limit"]) chain[m] = () => (ops.push(m), chain);
    return chain;
  },
};
const charge = (refunded: number) => ({
  id: "ch_1",
  payment_intent: "pi_1",
  amount: 10000,
  amount_captured: 10000,
  amount_refunded: refunded,
  refunded: refunded >= 10000,
  currency: "usd",
  receipt_url: null,
  paid: true,
  captured: true,
  payment_method_details: { type: "card" },
  created: 1_700_000_000,
  refunds: { data: [{ id: "re_1" }] },
});
const stripe = {
  paymentIntents: { retrieve: async () => ({ latest_charge: charge(0) }) },
  charges: { retrieve: async () => charge(0) },
  checkout: { sessions: { list: async () => ({ data: [] }) } },
};
(globalThis as any).__stripeStaffFeed = { state, db, stripe };

const root = fileURLToPath(new URL("../", import.meta.url));
const fake = (source: string) => `data:text/javascript,${encodeURIComponent(source)}`;
(nodeModule as any).registerHooks({
  resolve(specifier: string, context: any, next: any) {
    const g = "const t=globalThis.__stripeStaffFeed;";
    const doubles: Record<string, string> = {
      "@/lib/stripe": g + "export const stripe=t.stripe;",
      "@/lib/supabase/admin": g + "export const createAdminClient=()=>t.db;",
      "@/lib/email/send": g + "export const sendEmail=async()=>{t.state.student.push('email');};",
      "@/lib/email/templates": "export const Templates={paymentReceipt:()=>({subject:'',html:''})};",
      "@/lib/email/dispatch":
        g + "export const sendTemplated=async(k)=>{t.state.student.push(k);};export const emitEmailEvent=async()=>{};",
      "@/lib/notifications": g + "export const notify=async(n)=>{t.state.student.push(n.type);};",
      "@/lib/audit": "export const logAudit=async()=>{};",
      "@/lib/env": "export const env={siteUrl:'https://batch0.test'};",
      "@/lib/chat-post": g + "export const postStaffFeed=async(text)=>{t.state.feed.push(text);};",
      "@/lib/demo-day-tickets":
        "export const findProfileByEmail=async()=>null;export const getDemoDayDetails=async()=>null;export const TICKET_CONFIRMED_TEMPLATE='x';",
    };
    if (specifier in doubles) return { url: fake(doubles[specifier]), shortCircuit: true };
    if (specifier.startsWith("@/")) return next(pathToFileURL(path.join(root, specifier.slice(2) + ".ts")).href, context);
    return next(specifier, context);
  },
});
const { fulfillCheckoutSession, handleChargeRefunded } = await import("./stripe-fulfillment.ts");

const session = (cohortId: string | null) =>
  ({
    id: "cs_test_1",
    payment_status: "paid",
    status: "complete",
    payment_intent: "pi_1",
    amount_total: 10000,
    currency: "usd",
    metadata: { application_id: APP, user_id: USER, ...(cohortId ? { cohort_id: cohortId } : {}) },
  }) as any;

const ENROLLED = `Enrolled: **Ada Lovelace** in Fall 2026 · https://batch0.test/admin/students/${USER}`;

test("an enrollment first settled by reconciliation (silent) still reaches #staff, and only #staff", async () => {
  reset();
  await fulfillCheckoutSession(session(COHORT), { silent: true });
  assert.deepEqual(state.feed, [ENROLLED]);
  assert.deepEqual(state.student, [], "no stale welcome for the student");
});

test("the webhook's enrollment reaches the student and #staff once", async () => {
  reset();
  await fulfillCheckoutSession(session(COHORT));
  assert.deepEqual(state.feed, [ENROLLED]);
  assert.ok(state.student.includes("enrolled"));
});

test("a replay of a settled enrollment posts nothing, silent or not", async () => {
  reset();
  state.settlement = { newly_enrolled: false, blocked: false };
  await fulfillCheckoutSession(session(COHORT));
  await fulfillCheckoutSession(session(COHORT), { silent: true });
  assert.deepEqual(state.feed, []);
});

test("a cohort-less payment, whose newly_enrolled reads true on every replay, posts nothing", async () => {
  reset();
  await fulfillCheckoutSession(session(null), { silent: true });
  await fulfillCheckoutSession(session(null), { silent: true });
  assert.deepEqual(state.feed, []);
});

test("a refund from the Stripe dashboard (the webhook) reaches #staff once; a retry finds nothing new", async () => {
  reset();
  await handleChargeRefunded(charge(10000) as any);
  assert.deepEqual(state.feed, ["Enrollment payment refunded to **Ada Lovelace** · https://batch0.test/admin/payments"]);
  assert.ok(state.student.includes("payment_refunded"));
  state.refund = { matched: true, changed: false, user_id: USER, full: true };
  await handleChargeRefunded(charge(10000) as any);
  assert.equal(state.feed.length, 1);
});

test("an admin refund (silent: it tells the student itself) still reaches #staff, once even when its webhook races it", async () => {
  reset();
  // refundPayment / refundLatestPayment record it first…
  await handleChargeRefunded(charge(10000) as any, { silent: true });
  // …then the charge.refunded webhook for the same refund arrives.
  state.refund = { matched: true, changed: false, user_id: USER, full: true };
  await handleChargeRefunded(charge(10000) as any);
  assert.deepEqual(state.feed, ["Enrollment payment refunded to **Ada Lovelace** · https://batch0.test/admin/payments"]);
  assert.ok(!state.student.includes("payment_refunded"), "the webhook found nothing new to tell the student either");
});

test("a partial refund says so", async () => {
  reset();
  state.refund = { matched: true, changed: true, user_id: USER, full: false };
  await handleChargeRefunded(charge(2500) as any, { silent: true });
  assert.deepEqual(state.feed, ["Enrollment payment partly refunded to **Ada Lovelace** · https://batch0.test/admin/payments"]);
});

const FINE_LINE = `Fine refunded to **Ada Lovelace** · https://batch0.test/admin/charges?user=${USER}`;

test("a fine refunded from the Stripe dashboard reaches #staff once", async () => {
  reset();
  state.refund = { matched: false, changed: false };
  state.fine = { id: "uc_1", user_id: USER, status: "paid", amount_refunded_cents: 0, kind: "fine" };
  await handleChargeRefunded(charge(10000) as any);
  assert.deepEqual(state.feed, [FINE_LINE]);
  assert.ok(state.student.includes("charge_refunded"));
});

test("a fine refund someone else recorded first (refundCharge, or the webhook's twin) posts nothing here", async () => {
  reset();
  state.refund = { matched: false, changed: false };
  state.fine = { id: "uc_1", user_id: USER, status: "refunded", amount_refunded_cents: 0, kind: "fine" };
  // The read was stale: the other writer moved the total in between.
  state.firstToRecord = false;
  await handleChargeRefunded(charge(10000) as any);
  assert.deepEqual(state.feed, []);
  assert.ok(!state.student.includes("charge_refunded"));
  // And a total already on record is nothing new at all.
  state.fine = { id: "uc_1", user_id: USER, status: "refunded", amount_refunded_cents: 10000, kind: "fee" };
  state.firstToRecord = true;
  await handleChargeRefunded(charge(10000) as any);
  assert.deepEqual(state.feed, []);
});

test("refundCharge records the total with the same conditional write before it posts", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../app/admin/charges/actions.ts", import.meta.url), "utf8");
  assert.match(src, /update\(\{ amount_refunded_cents: refund\.amount \}\)[\s\S]{0,120}\.lt\("amount_refunded_cents", refund\.amount\)/);
  assert.match(src, /if \(Array\.isArray\(recorded\) && recorded\.length > 0\)[\s\S]{0,300}chargeRefundedLine/);
});
