/**
 * Isolated PostgreSQL test for migration 0106_sms_messaging.sql; NEVER connects
 * to the linked Supabase project.
 *
 * Run: npm run test:sms-messaging-db
 * Requires @electric-sql/pglite (dev dependency), or set BATCH0_PGLITE_MODULE
 * to an absolute installed module path.
 *
 * Runs the ACTUAL migration file — twice — on top of the slice of 0001..0102 it
 * references (profiles, the Supabase roles and their default privileges), and
 * asserts the things that only fail in production:
 *
 *  1. The append-only trigger on `messaging_consent_log` refuses every edit to
 *     the evidence AND still permits the one UPDATE the `user_id` foreign key
 *     performs when a profile is deleted. Getting that wrong either lets someone
 *     rewrite what a person agreed to, or makes any student who ever opted in
 *     undeletable — and the second surfaces the first time someone asks to be
 *     removed.
 *  2. `messaging_consent_no_promo_to_students` is the database half of the
 *     rule that keeps marketing off a minor's handset. lib/sms/consent-rules.ts
 *     is the application half; neither is a backup for the other.
 *  3. Supabase grants anon/authenticated `all` on new tables (and EXECUTE on
 *     new functions) through ALTER DEFAULT PRIVILEGES, so 0106's revokes are
 *     load-bearing — modelled below, or the assertions pass for the wrong
 *     reason. Every table is service-role only: RLS on, no policy, no grant.
 *  4. The idempotency keys the composer relies on — sms_outbox.dedupe_key and
 *     sms_campaigns.client_key — are really unique, and still let any number of
 *     rows leave them empty.
 *  5. `messaging_consent.opted_out_by` — who turned a number's texts off, which
 *     decides whether the dashboard may turn them back on — exists even on a
 *     database that ran an earlier draft of the file, and doesn't block
 *     deleting that profile. And the verify query in lib/migration-plan.ts
 *     says ok on the result.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { MIGRATION_CHECKS } from "../lib/migration-plan.ts";

const packagePath = process.env.BATCH0_PGLITE_MODULE;
const moduleName = packagePath ? pathToFileURL(packagePath).href : "@electric-sql/pglite";
const { PGlite } = await import(moduleName);

const MIGRATION = await readFile(
  new URL("../supabase/migrations/0106_sms_messaging.sql", import.meta.url),
  "utf8",
);

const NEW_TABLES = [
  "messaging_consent",
  "messaging_consent_log",
  "sms_outbox",
  "sms_campaigns",
  "sms_events",
  "sms_settings",
];

/**
 * The slice of 0001..0102 that 0106 references: `profiles` for its foreign
 * keys, and the three Supabase roles with the default privileges Supabase
 * really grants them. Deliberately minimal — a fuller replica would drift from
 * the real schema without anything noticing.
 */
const STUBS = `
  do $$ begin
    if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon; end if;
    if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated; end if;
    if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role; end if;
  end $$;
  grant usage on schema public to anon, authenticated, service_role;
  alter default privileges in schema public grant all on tables to anon, authenticated;
  alter default privileges in schema public grant execute on functions to anon, authenticated;
  create table public.profiles (
    id uuid primary key default gen_random_uuid(),
    email text, full_name text, role text not null default 'student'
  );
`;

async function freshDb() {
  const db = new PGlite();
  await db.exec(STUBS);
  await db.exec(MIGRATION);
  return db;
}

async function newProfile(db: any): Promise<string> {
  const { rows } = await db.query(
    "insert into public.profiles (email) values ('student@example.test') returning id",
  );
  return rows[0].id as string;
}

async function grantRow(db: any, userId: string | null) {
  await db.query(
    `insert into public.messaging_consent_log
       (phone_e164, user_id, party, action, purposes, consent_text, source, ip, user_agent)
     values ('+16095550123', $1, 'student', 'grant', '{transactional}', 'I agree to texts.',
             'dashboard_phone', '203.0.113.7', 'Mozilla/5.0')`,
    [userId],
  );
}

test("0106 applies cleanly, and a second run changes nothing", async () => {
  const db = new PGlite();
  await db.exec(STUBS);
  await db.exec(MIGRATION);
  await db.query("update public.sms_settings set sms_paused = true, from_number = '+18005550100'");
  // Re-running is the documented recovery path for a half-applied migration,
  // and must not reset a setting an admin already saved.
  await db.exec(MIGRATION);
  const { rows } = await db.query("select count(*)::int as n, bool_and(sms_paused) as paused, max(from_number) as from_number from public.sms_settings");
  assert.deepEqual(rows[0], { n: 1, paused: true, from_number: "+18005550100" });
});

test("the consent ledger refuses every edit to the evidence", async () => {
  const db = await freshDb();
  await grantRow(db, await newProfile(db));
  for (const stmt of [
    "update public.messaging_consent_log set consent_text = 'tampered'",
    "update public.messaging_consent_log set phone_e164 = '+15550000000'",
    "update public.messaging_consent_log set created_at = now() - interval '1 year'",
    "update public.messaging_consent_log set action = 'revoke'",
    "update public.messaging_consent_log set ip = null",
    // Nulling user_id is the FK's own move — but not alongside another change.
    "update public.messaging_consent_log set user_id = null, consent_text = 'tampered'",
    "delete from public.messaging_consent_log",
  ]) {
    await assert.rejects(() => db.query(stmt), /append-only/, `ledger allowed: ${stmt}`);
  }
});

test("deleting a profile succeeds, nulls user_id, and leaves the evidence intact", async () => {
  // `on delete set null` is performed as an UPDATE, so a trigger that refused
  // every UPDATE would make this profile undeletable.
  const db = await freshDb();
  const userId = await newProfile(db);
  await grantRow(db, userId);
  await db.query(
    "insert into public.messaging_consent (phone_e164, user_id, party, transactional) values ('+16095550123', $1, 'student', true)",
    [userId],
  );
  await db.query(
    "insert into public.sms_outbox (to_phone, user_id, purpose, body) values ('+16095550123', $1, 'transactional', 'hi')",
    [userId],
  );

  await db.query("delete from public.profiles where id = $1", [userId]);

  const { rows } = await db.query(
    "select user_id, consent_text, phone_e164, ip from public.messaging_consent_log",
  );
  assert.deepEqual(rows, [
    { user_id: null, consent_text: "I agree to texts.", phone_e164: "+16095550123", ip: "203.0.113.7" },
  ]);
  const { rows: consent } = await db.query("select user_id, transactional from public.messaging_consent");
  assert.deepEqual(consent, [{ user_id: null, transactional: true }], "the consent outlives the account");
  const { rows: outbox } = await db.query("select user_id from public.sms_outbox");
  assert.deepEqual(outbox, [{ user_id: null }]);
});

test("a student's number cannot carry promotional consent", async () => {
  const db = await freshDb();
  await assert.rejects(
    () =>
      db.query(
        "insert into public.messaging_consent (phone_e164, party, promotional) values ('+16095550999','student',true)",
      ),
    /messaging_consent_no_promo_to_students/,
  );
  // An update that relabels a promotional number as a student's is refused too.
  await db.query(
    "insert into public.messaging_consent (phone_e164, party, promotional) values ('+16095550999','parent',true)",
  );
  await assert.rejects(
    () => db.query("update public.messaging_consent set party = 'student' where phone_e164 = '+16095550999'"),
    /messaging_consent_no_promo_to_students/,
  );
  await db.query(
    "insert into public.messaging_consent (phone_e164, party, transactional) values ('+16095550888','student',true)",
  );
});

test("numbers must be E.164 wherever they're stored", async () => {
  const db = await freshDb();
  for (const bad of ["6095550123", "+0609555012", "not a number", "+1", "+1 609 555 0123"]) {
    await assert.rejects(
      () => db.query("insert into public.messaging_consent (phone_e164, party) values ($1, 'unknown')", [bad]),
      /violates check constraint/,
      `messaging_consent accepted ${bad}`,
    );
    await assert.rejects(
      () => db.query("insert into public.sms_outbox (to_phone, purpose, body) values ($1, 'transactional', 'x')", [bad]),
      /violates check constraint/,
      `sms_outbox accepted ${bad}`,
    );
  }
  await assert.rejects(
    () => db.query("update public.sms_settings set from_number = '8005550100'"),
    /violates check constraint/,
  );
});

test("RLS is on, there are no policies, and the browser roles hold nothing", async () => {
  const db = await freshDb();

  const { rows: rls } = await db.query(
    "select relname, relrowsecurity from pg_class where relnamespace = 'public'::regnamespace and relname = any($1::text[])",
    [NEW_TABLES],
  );
  assert.equal(rls.length, NEW_TABLES.length, "a table is missing entirely");
  for (const r of rls as any[]) assert.equal(r.relrowsecurity, true, `RLS is off for ${r.relname}`);

  const { rows: policies } = await db.query(
    "select tablename, policyname from pg_policies where schemaname = 'public' and tablename = any($1::text[])",
    [NEW_TABLES],
  );
  assert.deepEqual(policies, [], "every read and write goes through the service role");

  const { rows: grants } = await db.query(
    `select table_name, grantee, privilege_type from information_schema.role_table_grants
      where grantee in ('anon','authenticated') and table_name = any($1::text[])`,
    [NEW_TABLES],
  );
  assert.deepEqual(grants, [], `anon/authenticated hold grants they should not: ${JSON.stringify(grants)}`);

  const { rows: service } = await db.query(
    `select count(distinct table_name)::int as n from information_schema.role_table_grants
      where grantee = 'service_role' and privilege_type = 'INSERT' and table_name = any($1::text[])`,
    [NEW_TABLES],
  );
  assert.equal(service[0].n, NEW_TABLES.length, "the server actions can't write without these");

  const { rows: fn } = await db.query(
    `select has_function_privilege('anon', 'public.messaging_consent_log_is_append_only()', 'execute') as anon,
            has_function_privilege('authenticated', 'public.messaging_consent_log_is_append_only()', 'execute') as authed`,
  );
  assert.deepEqual(fn[0], { anon: false, authed: false });
});

test("a signed-in browser session gets permission denied on every texting table", async () => {
  // The grant is the second lock. Without it, a future permissive policy would
  // open the table; with it, the request fails before RLS is consulted.
  const db = await freshDb();
  await db.exec("set role authenticated");
  for (const t of NEW_TABLES) {
    await assert.rejects(() => db.query(`select * from public.${t}`), /permission denied/, t);
  }
  await db.exec("reset role");
});

test("sms_settings is a seeded singleton with no credentials in it", async () => {
  const db = await freshDb();
  const { rows } = await db.query(
    "select provider, from_number, account_sid, auth_token_encrypted, sms_paused, quiet_start_hour, quiet_end_hour from public.sms_settings",
  );
  assert.deepEqual(rows, [
    {
      provider: "twilio",
      from_number: null,
      account_sid: null,
      auth_token_encrypted: null,
      sms_paused: false,
      quiet_start_hour: 9,
      quiet_end_hour: 20,
    },
  ]);
  await assert.rejects(
    () => db.query("insert into public.sms_settings (id) values (false)"),
    /violates check constraint/,
    "id must be constrained to true, or there can be two answers to 'are sends paused?'",
  );
});

test("the outbox enforces its vocabulary and its dedupe key", async () => {
  const db = await freshDb();
  const insert = (extra = "", values: unknown[] = []) =>
    db.query(
      `insert into public.sms_outbox (to_phone, purpose, body${extra ? `, ${extra}` : ""})
       values ('+16095550123', 'transactional', 'hello'${values.map((_, i) => `, $${i + 1}`).join("")})`,
      values,
    );
  await insert("dedupe_key", ["k1"]);
  await assert.rejects(() => insert("dedupe_key", ["k1"]), /duplicate key/);
  // Any number of rows may leave the key empty.
  await insert();
  await insert();

  await assert.rejects(
    () => insert("status", ["delivered"]),
    /violates check constraint/,
    "'delivered' is a carrier status, not an outbox status — it belongs in sms_events",
  );
  await assert.rejects(
    () => db.query("insert into public.sms_outbox (to_phone, purpose, body) values ('+16095550123', 'marketing', 'x')"),
    /violates check constraint/,
    "purpose is the column the consent gate reads; it cannot accept a free-text value",
  );
});

test("one draft is one campaign: client_key is unique, and optional", async () => {
  const db = await freshDb();
  const insert = (key: string | null) =>
    db.query(
      "insert into public.sms_campaigns (client_key, name, body, purpose) values ($1, 'Kickoff', 'hi', 'transactional')",
      [key],
    );
  await insert("draft-abc12345");
  await assert.rejects(() => insert("draft-abc12345"), /duplicate key/);
  await insert(null);
  await insert(null);
});

test("the verify query passes after 0106, and fails before it", async () => {
  const before = new PGlite();
  await before.exec(STUBS);
  await assert.rejects(() => before.query(MIGRATION_CHECKS["0106"]), /does not exist/);
  const db = await freshDb();
  const { rows } = await db.query(MIGRATION_CHECKS["0106"]);
  assert.deepEqual(rows, [{ ok: true }]);
});

test("opted_out_by is added to a draft-era table, and is nulled when that account is deleted", async () => {
  // A database that ran an earlier draft of this file has the table without
  // the column; `create table if not exists` alone would leave it that way.
  const db = new PGlite();
  await db.exec(STUBS);
  await db.exec(`
    create table public.messaging_consent (
      phone_e164 text primary key,
      user_id uuid references public.profiles(id) on delete set null,
      party text not null,
      transactional boolean not null default false,
      promotional boolean not null default false,
      opted_out_at timestamptz,
      opted_out_source text,
      first_opted_in_at timestamptz,
      last_opted_in_at timestamptz,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
  `);
  await db.exec(MIGRATION);
  const { rows: verify } = await db.query(MIGRATION_CHECKS["0106"]);
  assert.deepEqual(verify, [{ ok: true }]);

  const userId = await newProfile(db);
  await db.query(
    `insert into public.messaging_consent (phone_e164, party, transactional, opted_out_at, opted_out_source, opted_out_by)
     values ('+16095550123', 'student', true, now(), 'dashboard_phone', $1)`,
    [userId],
  );
  await db.query("delete from public.profiles where id = $1", [userId]);
  const { rows } = await db.query("select opted_out_by, opted_out_source from public.messaging_consent");
  // Nobody can be matched to it any more, so only START lifts it now.
  assert.deepEqual(rows, [{ opted_out_by: null, opted_out_source: "dashboard_phone" }]);
});
