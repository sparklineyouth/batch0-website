import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";

const migration = await readFile(new URL("../supabase/migrations/0082_recovery_followups.sql", import.meta.url), "utf8");
const reminder = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const receipt = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const application = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const automation = "63c50182-e879-4dcc-bccf-3a5b2c34e343";
async function setup() {
  const db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth;
    create function auth.role() returns text language sql as $$select current_setting('request.jwt.claim.role',true)$$;
    grant usage on schema auth to authenticated,service_role;
    create table applications(id uuid primary key);
    create table email_templates(id uuid primary key,key text,version integer,subject text,preheader text,body_html text,cta_label text,cta_url text,variables jsonb,updated_at timestamptz);
    create table email_template_versions(template_id uuid,version integer,subject text,preheader text,body_html text,cta_label text,cta_url text,variables jsonb,unique(template_id,version));
    create table email_automations(id uuid primary key,enabled boolean,trigger_type text,schedule_cron text,name text,description text,audience jsonb,dedupe_window_hours integer,updated_at timestamptz);
    create table email_outbox(id uuid primary key default gen_random_uuid(),template_id uuid,status text,last_error text,updated_at timestamptz);
  `);
  await db.query("insert into applications values($1)", [application]);
  await db.query("insert into email_templates(id,key,version,subject) values($1,'nudge.unpaid',2,'Old nudge'),($2,'payment.receipt',4,'Your receipt')", [reminder,receipt]);
  await db.query("insert into email_automations(id,enabled,trigger_type,schedule_cron) values($1,true,'schedule','0 9 * * *')", [automation]);
  for (const status of ["pending","failed","sent","sending"]) {
    await db.query("insert into email_outbox(template_id,status) values($1,$2),($3,$2)", [reminder,status,receipt]);
  }
  return db;
}

test("recovery migration pauses the old campaign and skips only unsent payment reminders", async () => {
  const db = await setup();
  try {
    await db.exec(migration);
    const campaign = (await db.query<any>("select * from email_automations")).rows[0];
    assert.equal(campaign.enabled, false);
    assert.equal(campaign.trigger_type, "manual");
    assert.equal(campaign.schedule_cron, null);
    assert.equal(campaign.dedupe_window_hours, 72);
    const nudges = (await db.query<any>("select status from email_outbox where template_id=$1 order by status", [reminder])).rows.map(row => row.status);
    assert.deepEqual(nudges, ["sending","sent","skipped","skipped"]);
    const receipts = (await db.query<any>("select status from email_outbox where template_id=$1 order by status", [receipt])).rows.map(row => row.status);
    assert.deepEqual(receipts, ["failed","pending","sending","sent"]);
    const version = (await db.query<any>("select * from email_template_versions")).rows[0];
    assert.equal(version.subject, "Old nudge");
    assert.equal(version.version, 2);
    await db.exec(migration);
    assert.equal((await db.query<any>("select version from email_templates where id=$1", [reminder])).rows[0].version, 3);
    assert.equal((await db.query<any>("select count(*)::int n from email_outbox")).rows[0].n, 8, "migration never enqueues or sends mail");
  } finally { await db.close(); }
});

test("staff notes are private and applicants cannot set or clear staff follow-up pauses", async () => {
  const db = await setup();
  try {
    await db.exec(migration);
    await db.query("insert into recovery_followups(application_id,note) values($1,'Private synthetic test note')", [application]);
    await db.query("update applications set followup_paused=true where id=$1", [application]);
    await db.exec("grant select,insert,update on applications to authenticated; set role authenticated; set request.jwt.claim.role='authenticated'");
    await assert.rejects(db.query("select * from recovery_followups"), /permission denied/);
    await assert.rejects(db.query("insert into recovery_followups(application_id,note) values($1,'forged')", [application]), /permission denied/);
    await db.query("update applications set followup_paused=false where id=$1", [application]);
    assert.equal((await db.query<any>("select followup_paused from applications where id=$1", [application])).rows[0].followup_paused, true);
    const inserted = (await db.query<any>("insert into applications(id,followup_paused) values(gen_random_uuid(),true) returning followup_paused")).rows[0];
    assert.equal(inserted.followup_paused, false);
    await db.exec("reset role; set request.jwt.claim.role='service_role'; set role service_role");
    assert.equal((await db.query<any>("select note from recovery_followups")).rows[0].note, "Private synthetic test note");
  } finally { await db.close(); }
});
