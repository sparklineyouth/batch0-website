import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";

const migration = await readFile(new URL("../supabase/migrations/0081_parent_checkout.sql", import.meta.url), "utf8");
const db = new PGlite();
await db.exec(`
create role anon; create role authenticated; create role service_role;
create table profiles(id uuid primary key);
create table cohorts(id uuid primary key,name text,status text,starts_on date,ends_on date,applications_close_at timestamptz,capacity integer,price_cents integer);
create table applications(id uuid primary key,user_id uuid,cohort_id uuid,status text,paid_at timestamptz,stripe_session_id text,stripe_payment_intent_id text,reviewed_by uuid,reviewed_at timestamptz,review_notes text);
create table enrollments(id uuid primary key default gen_random_uuid(),user_id uuid,cohort_id uuid,application_id uuid,unique(user_id,cohort_id));
create table payments(id uuid primary key default gen_random_uuid(),user_id uuid,application_id uuid,cohort_id uuid,stripe_session_id text,stripe_payment_intent_id text,amount_cents integer,amount_refunded_cents integer not null default 0,currency text,status text,stripe_receipt_url text,paid_at timestamptz,created_at timestamptz default now());
`);
await db.exec(migration);
const cohort = "11111111-1111-4111-8111-111111111111";
const a = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", b = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ua = "aaaaaaaa-0000-4000-8000-000000000000", ub = "bbbbbbbb-0000-4000-8000-000000000000";
const quote = { amountCents: 7800, currency: "usd", country: "US", regionalPricing: false, baseCents: 12999, promoDiscountCents: 0, passDiscountCents: 5199, scholarshipDiscountCents: 0 };
async function reset() {
  await db.exec("truncate payer_links,checkout_reservations,payments,enrollments,applications,cohorts,profiles cascade;");
  await db.query("insert into profiles values($1),($2)", [ua, ub]);
  await db.query("insert into cohorts values($1,'Test cohort','upcoming',current_date+10,current_date+70,now()+interval '5 days',1,12999,null,null)", [cohort]);
  await db.query("insert into applications(id,user_id,cohort_id,status) values($1,$2,$3,'accepted'),($4,$5,$3,'accepted')", [a, ua, cohort, b, ub]);
}
async function reserve(app = a, user = ua) {
  const result = await db.query<{ result: any }>("select reserve_checkout_seat($1,$2,$3::jsonb) result", [app, user, JSON.stringify(quote)]);
  return result.rows[0].result;
}
async function settle(reservation: any, session = "cs_test_parent", amount = 7800, refunded = 0) {
  return (await db.query<{ result: any }>("select settle_enrollment_payment($1,$2,$3,$4,$5,'usd','pi_parent',null,now(),$6,$7) result", [session, ua, a, cohort, amount, reservation.id, refunded])).rows[0].result;
}

test("reservation prevents two accepted students or a manual grant buying the last seat", async () => {
  await reset(); const first = await reserve();
  assert.equal((await reserve()).id, first.id, "double clicks reuse a hold");
  await assert.rejects(reserve(b, ub), /full/);
  await assert.rejects(db.query("insert into enrollments(user_id,cohort_id,application_id) values($1,$2,$3)", [ub, cohort, b]), /full/);
});
test("exact discounted quote survives parent handoff and payment atomically consumes one hold", async () => {
  await reset(); const r = await reserve();
  await db.query("select attach_checkout_session($1,'cs_test_parent')", [r.id]);
  await db.query("select attach_checkout_session($1,'cs_test_parent')", [r.id]);
  assert.equal((await db.query("select * from payments")).rows.length, 1);
  assert.equal((await settle(r)).newly_enrolled, true);
  assert.equal((await settle(r)).newly_enrolled, false);
  assert.equal((await db.query<any>("select amount_cents from payments")).rows[0].amount_cents, 7800);
  assert.equal((await db.query<any>("select status from checkout_reservations")).rows[0].status, "completed");
  assert.equal((await db.query("select * from enrollments")).rows.length, 1);
});
test("unknown reservation or wrong quoted amount records real money but grants no access", async () => {
  await reset(); const r = await reserve();
  await db.query("select attach_checkout_session($1,'cs_test_parent')", [r.id]);
  assert.equal((await settle(r, "cs_test_parent", 9999)).blocked, true);
  assert.equal((await db.query("select * from enrollments")).rows.length, 0);
  assert.equal((await db.query<any>("select amount_cents from payments")).rows[0].amount_cents, 9999);
});
test("revoked application cannot start checkout; a completed payment cannot resurrect access", async () => {
  await reset(); const r = await reserve();
  await db.query("select attach_checkout_session($1,'cs_test_parent')", [r.id]);
  await db.query("update applications set status='withdrawn' where id=$1", [a]);
  await assert.rejects(reserve(), /not ready/);
  assert.equal((await settle(r)).blocked, true);
});
test("a refund observed before fulfillment cannot grant enrollment", async () => {
  await reset(); const r = await reserve();
  await db.query("select attach_checkout_session($1,'cs_test_parent')", [r.id]);
  assert.equal((await settle(r, "cs_test_parent", 7800, 7800)).blocked, true);
  assert.equal((await db.query<any>("select status from payments")).rows[0].status, "refunded");
});
test("deadline is enforced for both checkout and direct application submission", async () => {
  await reset(); await db.query("update cohorts set applications_close_at=now()-interval '1 second'");
  await assert.rejects(reserve(), /deadline/);
  await assert.rejects(db.query("update applications set status='submitted' where id=$1", [a]), /deadline/);
});
test("expired reservations free inventory; a delayed old payment is retained for staff review", async () => {
  await reset(); const r = await reserve();
  await db.query("select attach_checkout_session($1,'cs_test_parent')", [r.id]);
  await db.query("update checkout_reservations set expires_at=now()-interval '1 minute'");
  await reserve(b, ub);
  assert.equal((await settle(r)).blocked, true);
  assert.equal((await db.query("select * from enrollments")).rows.length, 0);
});
test("payer capabilities are unreadable to anonymous and ordinary authenticated roles", async () => {
  await reset();
  await db.exec("set role authenticated");
  await assert.rejects(db.query("select * from payer_links"), /permission denied/);
  await assert.rejects(db.query("select reserve_checkout_seat($1,$2,$3::jsonb)", [a,ua,JSON.stringify(quote)]), /permission denied/);
  await db.exec("reset role");
});

test("an authenticated applicant cannot self-accept or forge payment/reviewer fields", async () => {
  await reset();
  await db.exec("grant insert,select,update on applications to authenticated; set role authenticated");
  try {
    await assert.rejects(db.query("insert into applications(id,user_id,cohort_id,status) values(gen_random_uuid(),$1,$2,'accepted')", [ua,cohort]), /only be changed by staff/);
    const result = await db.query<any>("insert into applications(id,user_id,cohort_id,status,pricing_country,paid_at,review_notes,stripe_session_id) values(gen_random_uuid(),$1,$2,'draft','IN',now(),'admitted','cs_forged') returning *", [ua,cohort]);
    assert.equal(result.rows[0].pricing_country, null);
    assert.equal(result.rows[0].paid_at, null);
    assert.equal(result.rows[0].review_notes, null);
    assert.equal(result.rows[0].stripe_session_id, null);
  } finally { await db.exec("reset role"); }
});
test("staff cannot transfer an application while its payable checkout holds a seat", async () => {
  await reset(); await reserve();
  await assert.rejects(db.query("update applications set cohort_id=null where id=$1", [a]), /active checkout/);
});

test.after(async () => { await db.close(); });
