import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";

const db = new PGlite();
const user='00000000-0000-4000-8000-000000000001';
const cohort='00000000-0000-4000-8000-000000000002';
const app='00000000-0000-4000-8000-000000000003';
const app2='00000000-0000-4000-8000-000000000004';
before(async () => {
 await db.exec(`create role anon; create role authenticated; create role service_role;
 create table cohorts(id uuid primary key);
 create table applications(id uuid primary key,user_id uuid,cohort_id uuid,status text,paid_at timestamptz,stripe_payment_intent_id text);
 create table enrollments(id uuid primary key default gen_random_uuid(),user_id uuid,cohort_id uuid,application_id uuid,unique(user_id,cohort_id));
 create table payments(id uuid primary key default gen_random_uuid(),user_id uuid,application_id uuid,cohort_id uuid,stripe_session_id text,stripe_payment_intent_id text,amount_cents int,currency text,status text,stripe_receipt_url text,created_at timestamptz default now());
 create table user_charges(id uuid,amount_cents int,status text);
 create table demo_day_tickets(id uuid,amount_cents int,status text);`);
 await db.exec(await readFile(new URL('../supabase/migrations/0080_revenue_ledger.sql',import.meta.url),'utf8'));
});
after(async()=>db.close());
beforeEach(async()=>{
 await db.exec(`truncate payments,enrollments,applications,cohorts; insert into cohorts values('${cohort}'); insert into applications(id,user_id,cohort_id,status) values('${app}','${user}','${cohort}','accepted');`);
});
async function settle(session='cs_first',pi='pi_first',amount=7800,application=app,paidAt:string|null='2026-09-13T16:00:00Z') {
 return (await db.query<any>('select settle_enrollment_payment($1,$2,$3,$4,$5,$6,$7,$8,$9) as result',[session,user,application,cohort,amount,'usd',pi,'https://receipt.example',paidAt])).rows[0].result;
}
async function refund(pi='pi_first',amount=7800,refunded=7800) {
 return (await db.query<any>('select apply_enrollment_refund($1,$2,$3,$4) as result',[pi,amount,refunded,'usd'])).rows[0].result;
}
async function one(sql:string) {return (await db.query<any>(sql)).rows[0];}

test('captured $78 replaces stale $129.99 quote and uses actual success date',async()=>{
 await db.query(`insert into payments(user_id,application_id,cohort_id,stripe_session_id,amount_cents,currency,status,created_at) values($1,$2,$3,'cs_first',12999,'usd','pending','2026-09-01T00:00:00Z')`,[user,app,cohort]);
 assert.equal((await settle()).newly_enrolled,true);
 assert.equal((await settle()).newly_enrolled,false);
 const p=await one('select *,paid_at::text as date from payments');
 assert.equal(p.amount_cents,7800); assert.match(p.date,/2026-09-13/);
 assert.equal((await one('select count(*)::int n from payments')).n,1);
});
test('unknown historical success date stays unknown until evidence arrives',async()=>{
 await settle('cs_first','pi_first',7800,app,null);
 assert.equal((await one('select paid_at from payments')).paid_at,null);
 await settle(); assert.ok((await one('select paid_at from payments')).paid_at);
});
test('partial and out-of-order refunds keep access and monotone refund totals',async()=>{
 await settle(); await refund('pi_first',7800,2000); await refund('pi_first',7800,1000);
 const p=await one('select * from payments');assert.equal(p.status,'succeeded');assert.equal(p.amount_refunded_cents,2000);
 assert.equal((await one('select count(*)::int n from enrollments')).n,1);
});
test('full refund withdraws and removes access even if old admin pre-marked refunded',async()=>{
 await settle(); await db.exec("update payments set status='refunded'");
 await refund(); await refund();
 assert.equal((await one('select status from applications')).status,'withdrawn');
 assert.equal((await one('select count(*)::int n from enrollments')).n,0);
 assert.equal((await settle()).blocked,true);
 assert.equal((await one('select count(*)::int n from enrollments')).n,0);
});
test('old payment refund retains a replacement payment for the same application',async()=>{
 await settle(); await settle('cs_second','pi_second',12999);await refund();await refund();
 assert.equal((await one('select count(*)::int n from enrollments')).n,1);
 const a=await one('select * from applications');assert.equal(a.status,'enrolled');assert.equal(a.stripe_payment_intent_id,'pi_second');
});
test('replacement payment under a different application keeps its seat',async()=>{
 await settle(); await db.query("insert into applications(id,user_id,cohort_id,status) values($1,$2,$3,'accepted')",[app2,user,cohort]);
 await settle('cs_second','pi_second',12999,app2); await refund();
 assert.equal((await one('select application_id from enrollments')).application_id,app2);
 assert.equal((await one(`select status from applications where id='${app}'`)).status,'withdrawn');
});
test('a captured but blocked replacement cannot preserve access after full refund',async()=>{
 await settle(); await db.query("insert into applications(id,user_id,cohort_id,status) values($1,$2,$3,'withdrawn')",[app2,user,cohort]);
 assert.equal((await settle('cs_blocked','pi_blocked',12999,app2)).blocked,true);
 await refund();
 assert.equal((await one('select count(*)::int n from enrollments')).n,0);
 assert.equal((await one(`select status from applications where id='${app}'`)).status,'withdrawn');
 assert.equal((await one("select status from payments where stripe_payment_intent_id='pi_blocked'")).status,'succeeded','money still needs staff resolution');
});
test('withdrawn application payment is recorded for recovery without re-enrollment',async()=>{
 await db.exec("update applications set status='withdrawn'");const result=await settle();
 assert.equal(result.blocked,true);assert.equal((await one('select status from payments')).status,'succeeded');
 assert.equal((await one('select count(*)::int n from enrollments')).n,0);
});
test('service-only RPC refuses mismatched application identity',async()=>{
 await assert.rejects(db.query('select settle_enrollment_payment($1,$2,$3,$4,$5,$6,$7,$8,$9)',['cs_wrong',app2,app,cohort,100,'usd','pi_wrong',null,null]),/identity mismatch/);
 assert.equal((await one('select count(*)::int n from payments')).n,0);
 const perms=await one("select has_function_privilege('authenticated','settle_enrollment_payment(text,uuid,uuid,uuid,integer,text,text,text,timestamptz,uuid,integer)','EXECUTE') allowed");assert.equal(perms.allowed,false);
});

test('refund observed before completion records money but never grants access',async()=>{
 const result=await db.query<any>('select settle_enrollment_payment($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) as result',['cs_refunded',user,app,cohort,7800,'usd','pi_refunded',null,'2026-09-13T16:00:00Z',null,7800]);
 assert.equal(result.rows[0].result.blocked,true);
 assert.equal((await one('select count(*)::int n from enrollments')).n,0);
 assert.equal((await one('select status from payments')).status,'refunded');
});
test('refund recovery wins over a completion using an earlier zero-refund snapshot',async()=>{
 // Completion fetched the pre-refund charge, but the refund webhook wins
 // the DB race before this pending row has a payment-intent ID.
 await db.query("insert into payments(user_id,application_id,cohort_id,stripe_session_id,amount_cents,currency,status) values($1,$2,$3,'cs_first',12999,'usd','pending')",[user,app,cohort]);
 assert.equal((await refund()).matched,false);
 // Webhook recovers the real Checkout session with the current refund.
 await db.query('select settle_enrollment_payment($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',['cs_first',user,app,cohort,7800,'usd','pi_first',null,'2026-09-13T16:00:00Z',null,7800]);
 await refund();
 assert.equal((await settle()).blocked,true,'old snapshot cannot reverse the refund');
 assert.equal((await one('select count(*)::int n from enrollments')).n,0);
 assert.equal((await one('select amount_refunded_cents from payments')).amount_refunded_cents,7800);
});
