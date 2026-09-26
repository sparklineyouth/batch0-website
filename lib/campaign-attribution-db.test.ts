import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { newCampaignCookie, persistCampaignAttribution } from "./campaign-attribution.ts";

const migration = await readFile(new URL("../supabase/migrations/0086_campaign_attribution.sql", import.meta.url), "utf8");
const application = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const second = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const cohort = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

async function setup() {
  const db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated; create role service_role bypassrls;
    create table applications(id uuid primary key, cohort_id uuid, created_at timestamptz default now(), submitted_at timestamptz);
    create table payments(id uuid primary key default gen_random_uuid(), application_id uuid, amount_cents integer, amount_refunded_cents integer default 0, currency text default 'usd', status text);
    grant select on applications, payments to service_role;
  `);
  await db.exec(migration);
  await db.query("insert into applications(id,cohort_id,submitted_at) values($1,$3,now()),($2,$3,null)", [application, second, cohort]);
  return db;
}

async function attach(db: PGlite, id: string, campaign = "batch0_search_2026") {
  const now = new Date(Date.now() - 5_000);
  const cookie = newCampaignCookie(new URL(`https://batch0.org/parents?utm_source=google&utm_medium=cpc&utm_campaign=${campaign}`), undefined, now)!;
  // The same service call used after signup and a successful application save.
  return persistCampaignAttribution({ from() { return { async upsert(row) {
    await db.query("insert into application_attributions(application_id,source,medium,campaign,landing_path,first_touch_at) values($1,$2,$3,$4,$5,$6) on conflict(application_id) do nothing", [row.application_id,row.source,row.medium,row.campaign,row.landing_path,row.first_touch_at]);
    return { error: null };
  } }; } }, id, cookie);
}

test("tagged visit survives signup/application and a parent's different-device payment via application ID", async () => {
  const db = await setup();
  try {
    await attach(db, application);
    await attach(db, application, "batch0_later");
    await attach(db, second);
    // The payer has no visit cookie. Webhook-ledger rows already carry application_id.
    await db.query("insert into payments(application_id,amount_cents,status) values($1,11700,'succeeded'),($1,15099,'pending'),($1,15099,'failed'),($2,0,'succeeded')", [application,second]);
    let row = (await db.query<any>("select * from campaign_attribution_report")).rows[0];
    assert.equal(row.campaign, "batch0_search_2026");
    assert.equal(Number(row.applications_started), 2);
    assert.equal(Number(row.applications_submitted), 1);
    assert.equal(Number(row.paid_applications), 1);
    assert.equal(Number(row.retained_cents), 11700, "actual discounted charge, not list price or pending checkout");
    await db.query("insert into payments(application_id,amount_cents,status,currency) values($1,1000,'succeeded','usd'),($1,8000,'succeeded','inr')", [application]);
    row = (await db.query<any>("select * from campaign_attribution_report")).rows[0];
    assert.equal(Number(row.paid_applications), 1, "multiple paid transactions are still one paid application");
    assert.equal(Number(row.retained_cents), 12700);
    assert.equal(Number(row.other_currency_payments), 1);
    await db.query("update payments set amount_refunded_cents=3000 where amount_cents=11700");
    row = (await db.query<any>("select * from campaign_attribution_report")).rows[0];
    assert.equal(Number(row.refunded_cents), 3000);
    assert.equal(Number(row.retained_cents), 9700);
    await db.query("update payments set status='refunded' where status='succeeded' and amount_cents>0");
    row = (await db.query<any>("select * from campaign_attribution_report")).rows[0];
    assert.equal(Number(row.paid_applications), 0);
    assert.equal(Number(row.retained_cents), 0);
    await db.exec(migration);
    assert.equal((await db.query<any>("select count(*)::int n from application_attributions")).rows[0].n, 2, "migration is repeatable without clearing assignments");
  } finally { await db.close(); }
});

test("later clicks cannot take credit for old applications; stale and future touches are skipped", async () => {
  const db = await setup();
  try {
    await db.query("update applications set created_at=now()-interval '1 day' where id=$1", [application]);
    await attach(db, application);
    for (const time of ["now()+interval '1 hour'", "now()-interval '31 days'"]) {
      await db.query(`insert into application_attributions(application_id,source,medium,campaign,landing_path,first_touch_at) values($1,'google','cpc','batch0_search_2026','/parents',${time})`, [second]);
    }
    assert.equal((await db.query<any>("select count(*)::int n from application_attributions")).rows[0].n, 0);
  } finally { await db.close(); }
});

test("campaign data and revenue report are private; service can insert/read but cannot rewrite source", async () => {
  const db = await setup();
  try {
    for (const role of ["anon", "authenticated"]) {
      await db.exec(`set role ${role}`);
      await assert.rejects(db.query("select * from application_attributions"), /permission denied/);
      await assert.rejects(db.query("select * from campaign_attribution_report"), /permission denied/);
      await assert.rejects(db.query("insert into application_attributions(application_id,source,medium,campaign,landing_path,first_touch_at) values($1,'google','cpc','batch0_fake','/parents',now())", [application]), /permission denied/);
      await db.exec("reset role");
    }
    await db.exec("set role service_role");
    await attach(db, application);
    assert.equal((await db.query<any>("select count(*)::int n from campaign_attribution_report")).rows[0].n, 1);
    await assert.rejects(db.query("update application_attributions set campaign='batch0_rewritten'"), /permission denied/);
    await assert.rejects(db.query("update payments set amount_cents=999999"), /permission denied/);
    await db.exec("reset role");
    await db.query("delete from applications where id=$1", [application]);
    assert.equal((await db.query<any>("select count(*)::int n from application_attributions")).rows[0].n, 0, "source follows application deletion");
  } finally { await db.close(); }
});
