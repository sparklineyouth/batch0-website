import { test } from "node:test";
import assert from "node:assert/strict";
import { netRevenueCents, revenueSummary, retainedCents } from "./revenue-ledger.ts";

test("gross includes refunded charges and net subtracts each refund once", () => {
 const actual = revenueSummary([
  {amount_cents:10000,amount_refunded_cents:2000,status:"succeeded",user_id:"a"},
  {amount_cents:5000,status:"refunded",user_id:"b"},
  {amount_cents:9000,status:"failed",user_id:"c"},
  {amount_cents:0,status:"succeeded",user_id:"d"},
  {amount_cents:3000,status:"succeeded",currency:"eur",user_id:"e"},
 ]);
 assert.equal(actual.grossCents,15000);
 assert.equal(actual.refundedCents,7000);
 assert.equal(actual.netCents,8000);
 assert.deepEqual([...actual.payingUsers],["a"]);
 assert.equal(actual.otherCurrencyCount,1);
});
test("multiple payments count a person once; refunded and free places are not paying customers", () => {
 const actual = revenueSummary([
  {amount_cents:7800,status:"succeeded",user_id:"a",application_id:"app",paid_at:"2026-09-13T12:00:00Z"},
  {amount_cents:1000,status:"succeeded",user_id:"a",application_id:"app"},
  {amount_cents:0,status:"succeeded",user_id:"free",application_id:"free"},
 ]);
 assert.equal(actual.payingUsers.size,1); assert.equal(actual.paidApplications.size,1);
 assert.equal(actual.unknownPaidDates,2);
 assert.equal(retainedCents({amount_cents:100,amount_refunded_cents:200,status:"succeeded"}),0);
});

/** A stand-in for the service-role client: each table answers one fixed result. */
function fakeAdmin(tables: Record<string, { data: unknown[] | null; error: unknown }>) {
  return {
    from(table: string) {
      const q = { select: () => q, in: () => q, limit: async () => tables[table] };
      return q;
    },
  } as any;
}

test("the overview number is net USD across tuition, fees and tickets", async () => {
  const cents = await netRevenueCents(fakeAdmin({
    payments: { error: null, data: [
      { amount_cents: 10000, amount_refunded_cents: 2500, status: "succeeded", currency: "usd" },
      { amount_cents: 4000, status: "refunded", currency: "usd" },
      { amount_cents: 9000, status: "succeeded", currency: "eur" },
    ] },
    // Captured amount wins over the quote; a capture in another currency is left out.
    user_charges: { error: null, data: [
      { amount_cents: 1500, captured_amount_cents: 1200, captured_currency: "usd", status: "paid" },
      { amount_cents: 1500, captured_amount_cents: 1400, captured_currency: "gbp", status: "paid" },
    ] },
    demo_day_tickets: { error: null, data: [
      { amount_cents: 2000, amount_refunded_cents: 500, status: "paid" },
    ] },
  }));
  assert.equal(cents, 7500 + 1200 + 1500);
});

test("any failed read makes the overview number unavailable, not $0", async () => {
  const ok = { data: [], error: null };
  const cents = await netRevenueCents(fakeAdmin({
    payments: ok, user_charges: ok, demo_day_tickets: { data: null, error: { message: "boom" } },
  }));
  assert.equal(cents, null);
});
