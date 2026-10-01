import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";

/**
 * Migration 0090, executed for real against a throwaway Postgres.
 *
 * Worth the setup cost for the same reason 0084's test is: this is not a column
 * addition. It carries two tables with regex CHECK constraints, a SECURITY
 * DEFINER recount trigger, five policies, and a REVOKE block that closes the
 * ALTER DEFAULT PRIVILEGES hole — none of it verifiable by reading, and all of
 * it pasted into the Supabase SQL editor BY HAND. There is no runner and no CI
 * step between this file and production.
 *
 * It also pins one thing the app cannot survive being wrong about: the names
 * Postgres generates for the foreign keys. support_tickets has TWO FKs to
 * profiles, so lib/support.ts has to disambiguate its PostgREST embeds by
 * constraint name — `profiles!support_tickets_user_id_fkey`. A name that
 * doesn't exist is a 400 on every read of the queue, at runtime, with a clean
 * typecheck and a green build. The assertion below is the only thing standing
 * between a rename and that.
 *
 * As in 0084's test, what this does NOT assert is what the policies decide:
 * PGlite has no GoTrue session, so the auth.uid() stub returns null and every
 * policy evaluates as "signed out". Asserting the privacy rules here would be
 * asserting the stub. lib/support-access.test.ts pins the TypeScript half, and
 * the policy text itself is asserted there by pattern.
 */

const migration = await readFile(
  new URL("../supabase/migrations/0090_support_tickets.sql", import.meta.url),
  "utf8",
);

const USER = "11111111-1111-4111-8111-111111111111";
const STAFF = "22222222-2222-4222-8222-222222222222";

/**
 * The shape 0090 assumes is already there: 0001..0089, reduced to exactly the
 * objects it references. Deliberately minimal — a fuller replica would drift
 * from the real schema without anything noticing.
 */
async function setup() {
  const db = new PGlite();
  await db.exec(`
    create schema if not exists auth;

    do $$ begin
      if not exists (select 1 from pg_roles where rolname = 'anon') then
        create role anon;
      end if;
      if not exists (select 1 from pg_roles where rolname = 'authenticated') then
        create role authenticated;
      end if;
      if not exists (select 1 from pg_roles where rolname = 'service_role') then
        create role service_role;
      end if;
    end $$;

    create or replace function auth.uid() returns uuid language sql stable as $$
      select null::uuid $$;

    -- Supabase grants anon and authenticated full privileges on tables a LATER
    -- migration creates, through ALTER DEFAULT PRIVILEGES. Modelling it is what
    -- makes the revoke assertion mean anything — without these two lines the
    -- roles start with nothing, the revoke takes nothing away, and the test
    -- passes for the wrong reason.
    alter default privileges in schema public grant all on tables to anon, authenticated;

    create table if not exists public.profiles (
      id uuid primary key,
      full_name text,
      email text
    );

    -- 0090 adds an index to this and FKs into it.
    create table if not exists public.payments (
      id uuid primary key default gen_random_uuid(),
      user_id uuid not null references public.profiles(id) on delete cascade,
      stripe_payment_intent_id text,
      amount_cents integer not null,
      status text not null
    );

    -- From 0005_platform_v2.sql:537. 0090 hardens this table, so the fixture
    -- has to have it — and has to have it carrying the default grants above,
    -- which is what makes the hardening assertion mean something.
    create table if not exists public.rate_limits (
      key text primary key,
      window_started_at timestamptz not null default now(),
      count integer not null default 0
    );

    -- The shared updated_at trigger function, from 0001_init.sql:324. 0090
    -- attaches to it and must not define its own.
    create or replace function public.touch_updated_at()
    returns trigger language plpgsql as $$
    begin new.updated_at = now(); return new; end;
    $$;

    -- The role helpers from 0048_custom_roles.sql. 0090's policies call both.
    create or replace function public.is_admin(uid uuid)
    returns boolean language sql stable security definer set search_path = public as $$
      select false $$;

    create or replace function public.has_permission(uid uuid, perm text)
    returns boolean language sql stable security definer set search_path = public as $$
      select false $$;
  `);

  await db.exec(`
    insert into public.profiles (id, full_name, email) values
      ('${USER}', 'Alex Rivera', 'alex@example.com'),
      ('${STAFF}', 'Sam Staff', 'sam@batch0.org');
  `);

  return db;
}

async function applied() {
  const db = await setup();
  await db.exec(migration);
  return db;
}

// ---------------------------------------------------------------------------
// It applies, and it applies twice
// ---------------------------------------------------------------------------

test("migration 0090 applies to a 0089-shaped database", async () => {
  const db = await applied();
  const { rows } = await db.query<{ table_name: string }>(
    `select table_name from information_schema.tables
     where table_schema = 'public' and table_name like 'support%' order by table_name`,
  );
  assert.deepEqual(
    rows.map((r) => r.table_name),
    ["support_ticket_replies", "support_tickets"],
  );
  await db.close();
});

test("migration 0090 is safe to run a second time", async () => {
  // The header claims idempotency, and the real deploy path is a human pasting
  // it into the SQL editor — where "did that go through?" is answered by
  // running it again.
  const db = await applied();
  await db.exec(migration);
  const { rows } = await db.query<{ n: number }>(
    `select count(*)::int as n from public.support_tickets`,
  );
  assert.equal(rows[0].n, 0);
  await db.close();
});

// ---------------------------------------------------------------------------
// The FK names lib/support.ts embeds on
// ---------------------------------------------------------------------------

test("the foreign keys are named exactly what the PostgREST embeds expect", async () => {
  // These four strings appear verbatim in TICKET_SELECT and REPLY_SELECT in
  // lib/support.ts. A mismatch is a runtime 400 on every queue read, invisible
  // to tsc and to next build.
  const db = await applied();
  const { rows } = await db.query<{ conname: string }>(
    `select conname from pg_constraint
     where contype = 'f'
       and conrelid in ('public.support_tickets'::regclass,
                        'public.support_ticket_replies'::regclass)
     order by conname`,
  );
  const names = rows.map((r) => r.conname);
  for (const expected of [
    "support_tickets_user_id_fkey",
    "support_tickets_assigned_to_fkey",
    "support_tickets_payment_id_fkey",
    "support_ticket_replies_author_id_fkey",
    "support_ticket_replies_ticket_id_fkey",
  ]) {
    assert.ok(
      names.includes(expected),
      `${expected} must exist — lib/support.ts embeds on it. Found: ${names.join(", ")}`,
    );
  }
  await db.close();
});

// ---------------------------------------------------------------------------
// The constraints actually constrain
// ---------------------------------------------------------------------------

async function insertTicket(
  db: PGlite,
  over: Partial<Record<string, string>> = {},
) {
  const v = {
    reference: "B0-4F2A-9C7K",
    token: "a".repeat(43),
    category: "refund",
    subject: "Refund for tuition",
    body: "I paid yesterday and would like a refund please, thank you.",
    ...over,
  };
  const { rows } = await db.query<{ id: string }>(
    `insert into public.support_tickets
       (reference, token, user_id, requester_email, requester_name, category, subject, body)
     values ($1, $2, $3, 'alex@example.com', 'Alex Rivera', $4, $5, $6)
     returning id`,
    [v.reference, v.token, USER, v.category, v.subject, v.body],
  );
  return rows[0].id;
}

test("a ticket inserts with the defaults the queue depends on", async () => {
  const db = await applied();
  const id = await insertTicket(db);
  const { rows } = await db.query<{
    status: string;
    needs_reply: boolean;
    reply_count: number;
  }>(
    `select status, needs_reply, reply_count from public.support_tickets where id = $1`,
    [id],
  );
  // A brand-new ticket is by definition waiting on us; the queue is
  // `where needs_reply` and nothing else.
  assert.equal(rows[0].status, "open");
  assert.equal(rows[0].needs_reply, true);
  assert.equal(rows[0].reply_count, 0);
  await db.close();
});

test("the reference CHECK refuses the symbols that get misread aloud", async () => {
  const db = await applied();
  // I, L, O, U, 0 and 1 are excluded so a reference read over the phone can't
  // be mistyped into a different real ticket. The regex is a second copy of
  // the alphabet in lib/support-access.ts, which is why it is asserted here.
  for (const bad of ["B0-4F2I-9C7K", "B0-4F2L-9C7K", "B0-4F2O-9C7K", "B0-4F2U-9C7K", "B0-4F20-9C7K"]) {
    await assert.rejects(
      insertTicket(db, { reference: bad, token: "b".repeat(43) }),
      /violates check constraint/,
      `${bad} should be refused`,
    );
  }
  // And accepts the whole intended alphabet.
  await insertTicket(db, { reference: "B0-ZZZZ-2222", token: "c".repeat(43) });
  await db.close();
});

test("the token CHECK refuses anything that isn't 43 base64url characters", async () => {
  const db = await applied();
  for (const bad of ["a".repeat(42), "a".repeat(44), "a".repeat(42) + "+", "a".repeat(42) + "/"]) {
    await assert.rejects(
      insertTicket(db, { reference: "B0-2222-3333", token: bad }),
      /violates check constraint/,
    );
  }
  await db.close();
});

test("a body too short to answer is refused by the database as well as the form", async () => {
  const db = await applied();
  await assert.rejects(
    insertTicket(db, { body: "help", token: "d".repeat(43) }),
    /violates check constraint/,
  );
  await db.close();
});

test("an unknown category or status cannot be stored", async () => {
  const db = await applied();
  await assert.rejects(
    insertTicket(db, { category: "lawsuit", token: "e".repeat(43) }),
    /violates check constraint/,
  );
  const id = await insertTicket(db, { token: "f".repeat(43) });
  await assert.rejects(
    db.query(`update public.support_tickets set status = 'pending' where id = $1`, [id]),
    /violates check constraint/,
  );
  await db.close();
});

// ---------------------------------------------------------------------------
// The recount trigger
// ---------------------------------------------------------------------------

test("the trigger recounts replies and moves last_activity_at", async () => {
  const db = await applied();
  const id = await insertTicket(db);
  const before = await db.query<{ last_activity_at: Date }>(
    `select last_activity_at from public.support_tickets where id = $1`,
    [id],
  );

  await db.query(
    `insert into public.support_ticket_replies (ticket_id, author_id, is_staff, body)
     values ($1, $2, true, 'Refunded in full.')`,
    [id, STAFF],
  );
  await db.query(
    `insert into public.support_ticket_replies (ticket_id, author_id, is_staff, body)
     values ($1, $2, false, 'Thank you!')`,
    [id, USER],
  );

  const after = await db.query<{ reply_count: number; last_activity_at: Date }>(
    `select reply_count, last_activity_at from public.support_tickets where id = $1`,
    [id],
  );
  assert.equal(after.rows[0].reply_count, 2);
  assert.ok(
    after.rows[0].last_activity_at >= before.rows[0].last_activity_at,
    "the queue sorts on last_activity_at, so a reply has to move it",
  );
  await db.close();
});

test("deleting a reply recounts rather than decrementing", async () => {
  // A full count(*) rather than a -1 is what stops two concurrent inserts
  // losing an increment to a read-then-write race.
  const db = await applied();
  const id = await insertTicket(db);
  const { rows } = await db.query<{ id: string }>(
    `insert into public.support_ticket_replies (ticket_id, author_id, is_staff, body)
     values ($1, $2, true, 'One'), ($1, $2, true, 'Two') returning id`,
    [id, STAFF],
  );
  await db.query(`delete from public.support_ticket_replies where id = $1`, [rows[0].id]);
  const after = await db.query<{ reply_count: number }>(
    `select reply_count from public.support_tickets where id = $1`,
    [id],
  );
  assert.equal(after.rows[0].reply_count, 1);
  await db.close();
});

test("updated_at is maintained by the shared trigger function", async () => {
  const db = await applied();
  const id = await insertTicket(db);
  const before = await db.query<{ updated_at: Date }>(
    `select updated_at from public.support_tickets where id = $1`,
    [id],
  );
  await db.query(
    `update public.support_tickets set status = 'resolved' where id = $1`,
    [id],
  );
  const after = await db.query<{ updated_at: Date }>(
    `select updated_at from public.support_tickets where id = $1`,
    [id],
  );
  assert.ok(after.rows[0].updated_at >= before.rows[0].updated_at);
  await db.close();
});

// ---------------------------------------------------------------------------
// A ticket outlives its account
// ---------------------------------------------------------------------------

test("deleting a profile leaves the ticket readable instead of destroying it", async () => {
  // The case that forces `on delete set null`: someone files a privacy ticket
  // asking us to delete their account, we honour it, and the record proving we
  // honoured it must survive the deletion it requested. requester_email is the
  // snapshot that keeps the row answerable.
  const db = await applied();
  const id = await insertTicket(db);
  await db.query(
    `insert into public.support_ticket_replies (ticket_id, author_id, is_staff, body)
     values ($1, $2, true, 'Deleted as requested.')`,
    [id, STAFF],
  );

  await db.query(`delete from public.profiles where id = $1`, [USER]);

  const { rows } = await db.query<{
    user_id: string | null;
    requester_email: string;
    reply_count: number;
  }>(
    `select user_id, requester_email, reply_count from public.support_tickets where id = $1`,
    [id],
  );
  assert.equal(rows.length, 1, "the ticket must still exist");
  assert.equal(rows[0].user_id, null);
  assert.equal(rows[0].requester_email, "alex@example.com");
  await db.close();
});

test("deleting a ticket takes its replies with it", async () => {
  const db = await applied();
  const id = await insertTicket(db);
  await db.query(
    `insert into public.support_ticket_replies (ticket_id, author_id, is_staff, body)
     values ($1, $2, true, 'Hello')`,
    [id, STAFF],
  );
  await db.query(`delete from public.support_tickets where id = $1`, [id]);
  const { rows } = await db.query<{ n: number }>(
    `select count(*)::int as n from public.support_ticket_replies`,
  );
  assert.equal(rows[0].n, 0);
  await db.close();
});

// ---------------------------------------------------------------------------
// Lockdown
// ---------------------------------------------------------------------------

test("anon and authenticated hold no privileges on either table", async () => {
  // The revokes are the point of this test. Supabase's ALTER DEFAULT
  // PRIVILEGES (modelled in setup()) would otherwise have granted both roles
  // `all` on tables this migration creates, without the migration saying
  // anything — RLS would still refuse the read, but a grant that contradicts
  // the intent is a landmine for whoever adds a permissive policy next.
  const db = await applied();
  for (const table of ["support_tickets", "support_ticket_replies"]) {
    for (const role of ["anon", "authenticated"]) {
      for (const priv of ["select", "insert", "update", "delete"]) {
        const { rows } = await db.query<{ ok: boolean }>(
          `select has_table_privilege($1, $2, $3) as ok`,
          [role, `public.${table}`, priv],
        );
        assert.equal(
          rows[0].ok,
          false,
          `${role} must not hold ${priv} on ${table}`,
        );
      }
    }
    const { rows } = await db.query<{ ok: boolean }>(
      `select has_table_privilege('service_role', $1, 'insert') as ok`,
      [`public.${table}`],
    );
    assert.equal(rows[0].ok, true, `service_role must retain insert on ${table}`);
  }
  await db.close();
});

test("row level security is on and there is no insert policy", async () => {
  const db = await applied();
  const { rows: tables } = await db.query<{ relname: string; relrowsecurity: boolean }>(
    `select relname, relrowsecurity from pg_class
     where oid in ('public.support_tickets'::regclass,
                   'public.support_ticket_replies'::regclass)`,
  );
  for (const t of tables) {
    assert.equal(t.relrowsecurity, true, `${t.relname} must have RLS enabled`);
  }

  // Every write goes through the service role in lib/support.ts, which is what
  // lets the server own requester_email, is_staff, is_internal, token and
  // reference. An INSERT policy would mean the browser could choose them.
  const { rows: policies } = await db.query<{ polname: string; polcmd: string }>(
    `select polname, polcmd::text as polcmd from pg_policy
     where polrelid in ('public.support_tickets'::regclass,
                        'public.support_ticket_replies'::regclass)`,
  );
  assert.ok(policies.length > 0, "the policies must exist");
  for (const p of policies) {
    assert.notEqual(
      p.polcmd,
      "a", // pg_policy.polcmd: 'a' = INSERT, '*' = ALL, 'r' = SELECT
      `${p.polname} is an INSERT policy; writes are server-only by design`,
    );
  }
  // The two SELECT policies are what make a requester's own ticket readable
  // and a stranger's not, so their absence would be a silent lockout.
  assert.equal(
    policies.filter((p) => p.polcmd === "r").length,
    2,
    "both tables need a SELECT policy",
  );
  await db.close();
});

test("the pre-existing rate_limits hole is closed", async () => {
  // Not part of this feature, and asserted here because this feature writes to
  // that table. rate_limits (migration 0005) had no RLS, no policy and no
  // revoke, and its primary key is the rate-limit key in plaintext — the
  // password-reset flow keys on the user's email address, so with Supabase's
  // default grant an authenticated browser client could enumerate the address
  // of everyone who recently asked for a reset.
  const db = await setup();
  // With the default privileges modelled in setup(), the hole is real first.
  const before = await db.query<{ ok: boolean }>(
    `select has_table_privilege('authenticated', 'public.rate_limits', 'select') as ok`,
  );
  assert.equal(before.rows[0].ok, true, "the hole this closes must exist first");

  await db.exec(migration);

  for (const role of ["anon", "authenticated"]) {
    const { rows } = await db.query<{ ok: boolean }>(
      `select has_table_privilege($1, 'public.rate_limits', 'select') as ok`,
      [role],
    );
    assert.equal(rows[0].ok, false, `${role} must not be able to read rate_limits`);
  }
  const { rows: rls } = await db.query<{ relrowsecurity: boolean }>(
    `select relrowsecurity from pg_class where oid = 'public.rate_limits'::regclass`,
  );
  assert.equal(rls[0].relrowsecurity, true);
  // checkRateLimit reaches it through createAdminClient, so the service role
  // must keep working.
  const { rows: svc } = await db.query<{ ok: boolean }>(
    `select has_table_privilege('service_role', 'public.rate_limits', 'insert') as ok`,
  );
  assert.equal(svc[0].ok, true, "checkRateLimit runs as the service role");
  await db.close();
});

test("the payments index the refund lookup needs exists", async () => {
  // A pasted pi_… is the likeliest identifier on a refund ticket and had no
  // index before this migration; without it, resolving one ticket sequentially
  // scans the tuition ledger.
  const db = await applied();
  const { rows } = await db.query<{ indexname: string }>(
    `select indexname from pg_indexes
     where schemaname = 'public' and indexname = 'payments_stripe_payment_intent_id_idx'`,
  );
  assert.equal(rows.length, 1);
  await db.close();
});

test("the queue index is partial, matching the query that uses it", async () => {
  const db = await applied();
  const { rows } = await db.query<{ indexdef: string }>(
    `select indexdef from pg_indexes
     where schemaname = 'public' and indexname = 'support_tickets_queue_idx'`,
  );
  assert.equal(rows.length, 1);
  assert.match(rows[0].indexdef, /WHERE needs_reply/i);
  await db.close();
});
