import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";

/**
 * Migration 0090, executed for real against a throwaway Postgres — applied,
 * re-applied, applied over an earlier draft of itself, and queried AS signed-in
 * users so the policies' decisions are asserted, not just their syntax.
 *
 * Worth the setup cost for the same reason 0084's test is: this is not a column
 * addition. It carries three tables with regex and vocabulary CHECKs, a
 * SECURITY DEFINER recount trigger with visibility rules built in, six
 * policies including a confidentiality rule, a storage bucket, and two fixes
 * to tables it doesn't own — none of it verifiable by reading.
 *
 * It also pins the names Postgres generates for the foreign keys.
 * support_tickets has THREE FKs to profiles, so lib/support.ts has to
 * disambiguate its PostgREST embeds by constraint name —
 * `profiles!support_tickets_user_id_fkey`. A name that doesn't exist is a 400
 * on every read of the queue, at runtime, with a clean typecheck and a green
 * build.
 *
 * auth.uid() reads a session setting (the dm-migration-db.test.ts idiom), and
 * has_permission()/is_admin() are the real 0048 shape over a small app_roles
 * table, so "a support.view holder without support.sensitive" is a real
 * principal here rather than a stub that always says no.
 */

const migration = await readFile(
  new URL("../supabase/migrations/0090_support_tickets.sql", import.meta.url),
  "utf8",
);

const USER = "11111111-1111-4111-8111-111111111111";
const STAFF = "22222222-2222-4222-8222-222222222222";
const VIEWER = "33333333-3333-4333-8333-333333333333";
const SENIOR = "44444444-4444-4444-8444-444444444444";
const ADMIN = "55555555-5555-4555-8555-555555555555";
const STRANGER = "66666666-6666-4666-8666-666666666666";
const MANAGER = "77777777-7777-4777-8777-777777777777";

/**
 * The shape 0090 assumes is already there: 0001..0089, reduced to exactly the
 * objects it references or alters. Deliberately minimal — a fuller replica
 * would drift from the real schema without anything noticing.
 */
async function setup() {
  const db = new PGlite();
  await db.exec(`
    create schema if not exists auth;
    create schema if not exists storage;

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

    -- The signed-in user, as PostgREST would set it.
    create or replace function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    grant usage on schema auth to anon, authenticated, service_role;
    grant usage on schema public to anon, authenticated, service_role;

    -- Supabase grants anon and authenticated full privileges on tables and
    -- EXECUTE on functions a LATER migration creates, through ALTER DEFAULT
    -- PRIVILEGES. Modelling it is what makes the revoke assertions mean
    -- anything — without these lines the roles start with nothing, the revoke
    -- takes nothing away, and the tests pass for the wrong reason.
    alter default privileges in schema public grant all on tables to anon, authenticated;
    alter default privileges in schema public grant execute on functions to anon, authenticated;

    -- Storage, reduced to what a bucket insert touches (the
    -- hackathons-migration-db.test.ts stub).
    create table storage.buckets (
      id text primary key,
      name text not null,
      public boolean default false,
      file_size_limit bigint,
      allowed_mime_types text[]
    );
    create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text);
    alter table storage.objects enable row level security;

    -- Roles as rows (0048), and the two predicates 0090's policies call, with
    -- their real bodies: true on '*' or the named key.
    create table public.app_roles (slug text primary key, permissions text[] not null default '{}');
    create table if not exists public.profiles (
      id uuid primary key,
      full_name text,
      email text,
      role text not null default 'student'
    );
    create or replace function public.has_permission(uid uuid, perm text)
    returns boolean language sql stable security definer set search_path = public as $$
      select exists (
        select 1 from public.profiles p join public.app_roles r on r.slug = p.role
        where p.id = uid
          and (r.permissions @> array['*']::text[] or r.permissions @> array[perm])
      ) $$;
    create or replace function public.is_admin(uid uuid)
    returns boolean language sql stable security definer set search_path = public as $$
      select exists (
        select 1 from public.profiles p join public.app_roles r on r.slug = p.role
        where p.id = uid and r.permissions @> array['*']::text[]
      ) $$;

    -- 0090 adds an index to this and FKs into it.
    create table if not exists public.payments (
      id uuid primary key default gen_random_uuid(),
      user_id uuid not null references public.profiles(id) on delete cascade,
      stripe_payment_intent_id text,
      amount_cents integer not null,
      status text not null
    );

    -- From 0005_platform_v2.sql:537-572, verbatim in substance. 0090 hardens
    -- both the table and the function, so the fixture has to carry the
    -- default grants above for the hardening assertions to mean something.
    create table if not exists public.rate_limits (
      key text primary key,
      window_started_at timestamptz not null default now(),
      count integer not null default 0
    );
    create or replace function public.rate_limit_check(
      p_key text,
      p_window_seconds integer
    ) returns integer
    language plpgsql
    security definer set search_path = public
    as $fn$
    declare
      v_count integer;
    begin
      insert into public.rate_limits (key, window_started_at, count)
      values (p_key, now(), 1)
      on conflict (key) do update
        set window_started_at = case
              when public.rate_limits.window_started_at < now() - (p_window_seconds || ' seconds')::interval
                then now()
              else public.rate_limits.window_started_at
            end,
            count = case
              when public.rate_limits.window_started_at < now() - (p_window_seconds || ' seconds')::interval
                then 1
              else public.rate_limits.count + 1
            end
      returning count into v_count;
      return v_count;
    end;
    $fn$;

    -- From 0005 (the table) and 0012 (the dedupe column and its PARTIAL
    -- unique index — the shape section 9 of 0090 replaces).
    create table if not exists public.notifications (
      id uuid primary key default gen_random_uuid(),
      user_id uuid not null references public.profiles(id) on delete cascade,
      type text not null,
      title text not null,
      body text,
      link text,
      read_at timestamptz,
      created_at timestamptz not null default now()
    );
    alter table public.notifications add column if not exists dedupe_key text;
    create unique index if not exists notifications_user_dedupe_uniq
      on public.notifications (user_id, dedupe_key)
      where dedupe_key is not null;

    -- The shared updated_at trigger function, from 0001_init.sql:324. 0090
    -- attaches to it and must not define its own.
    create or replace function public.touch_updated_at()
    returns trigger language plpgsql as $$
    begin new.updated_at = now(); return new; end;
    $$;
  `);

  await db.exec(`
    insert into public.app_roles (slug, permissions) values
      ('student', '{student.dashboard}'),
      ('support', '{support.view,support.manage}'),
      ('support-reader', '{support.view}'),
      ('support-senior', '{support.view,support.manage,support.sensitive}'),
      ('support-manager', '{support.manage}'),
      ('admin', '{*}');
    insert into public.profiles (id, full_name, email, role) values
      ('${USER}', 'Alex Rivera', 'alex@example.com', 'student'),
      ('${STAFF}', 'Sam Staff', 'sam@batch0.org', 'support'),
      ('${VIEWER}', 'Vic Viewer', 'vic@batch0.org', 'support-reader'),
      ('${SENIOR}', 'Sen Senior', 'sen@batch0.org', 'support-senior'),
      ('${ADMIN}', 'Ada Admin', 'ada@batch0.org', 'admin'),
      ('${STRANGER}', 'Stu Stranger', 'stu@example.com', 'student'),
      ('${MANAGER}', 'Mo Manager', 'mo@batch0.org', 'support-manager');
  `);

  return db;
}

async function applied() {
  const db = await setup();
  await db.exec(migration);
  return db;
}

/** Run `sql` as a database role (and, for authenticated, as a user), then drop back to the owner. */
async function as<T = any>(
  db: PGlite,
  who: { role: "anon" | "authenticated" | "service_role"; uid?: string },
  sql: string,
  params: unknown[] = [],
) {
  await db.exec(
    `set role ${who.role}; select set_config('request.jwt.claim.sub', '${who.uid ?? ""}', false);`,
  );
  try {
    return await db.query<T>(sql, params);
  } finally {
    await db.exec(`reset role; select set_config('request.jwt.claim.sub', '', false);`);
  }
}

const signedIn = (uid: string) => ({ role: "authenticated" as const, uid });

let tokenSeq = 0;
/** A fresh valid token per insert, so the unique constraint never trips by accident. */
function nextToken() {
  tokenSeq += 1;
  return tokenSeq.toString(36).padStart(43, "t");
}

async function insertTicket(
  db: PGlite,
  over: Partial<Record<string, string | boolean | null>> = {},
) {
  const v = {
    reference: "B0-4F2A-9C7K",
    token: nextToken(),
    category: "refund",
    subject: "Refund for tuition",
    body: "I paid yesterday and would like a refund please, thank you.",
    user_id: USER as string | null,
    sensitive: false,
    ...over,
  };
  const { rows } = await db.query<{ id: string }>(
    `insert into public.support_tickets
       (reference, token, user_id, requester_email, requester_name, category, subject, body, sensitive)
     values ($1, $2, $3, 'alex@example.com', 'Alex Rivera', $4, $5, $6, $7)
     returning id`,
    [v.reference, v.token, v.user_id, v.category, v.subject, v.body, v.sensitive],
  );
  return rows[0].id;
}

async function insertReply(
  db: PGlite,
  ticketId: string,
  r: { author: string | null; isStaff: boolean; isInternal?: boolean; via: string; body?: string },
) {
  const { rows } = await db.query<{ id: string }>(
    `insert into public.support_ticket_replies (ticket_id, author_id, is_staff, is_internal, via, body)
     values ($1, $2, $3, $4, $5, $6) returning id`,
    [ticketId, r.author, r.isStaff, r.isInternal ?? false, r.via, r.body ?? "A message."],
  );
  return rows[0].id;
}

async function ticketRow(db: PGlite, id: string) {
  const { rows } = await db.query<any>(`select * from public.support_tickets where id = $1`, [id]);
  return rows[0];
}

/** Everything about 0090's objects that a second run must leave identical. */
async function catalog(db: PGlite) {
  const q = async (sql: string) => (await db.query<any>(sql)).rows;
  return {
    columns: await q(
      `select table_name, column_name, data_type, is_nullable, column_default
       from information_schema.columns
       where table_schema = 'public' and table_name like 'support%'
       order by table_name, column_name`,
    ),
    constraints: await q(
      `select conrelid::regclass::text as tbl, conname, pg_get_constraintdef(oid) as def
       from pg_constraint
       where conrelid in ('public.support_tickets'::regclass,
                          'public.support_ticket_replies'::regclass,
                          'public.support_ticket_attachments'::regclass)
       order by 1, 2`,
    ),
    indexes: await q(
      `select tablename, indexname, indexdef from pg_indexes
       where schemaname = 'public'
         and (tablename like 'support%'
              or indexname in ('payments_stripe_payment_intent_id_idx',
                               'notifications_user_dedupe_key_idx',
                               'notifications_user_dedupe_uniq'))
       order by 1, 2`,
    ),
    policies: await q(
      `select tablename, policyname, cmd, qual, with_check from pg_policies
       where tablename like 'support%' order by 1, 2`,
    ),
    triggers: await q(
      `select tgname, pg_get_triggerdef(oid) as def from pg_trigger
       where not tgisinternal
         and tgrelid in ('public.support_tickets'::regclass, 'public.support_ticket_replies'::regclass)
       order by 1`,
    ),
    functions: await q(
      `select proname, prosrc, prosecdef from pg_proc
       where proname = 'support_ticket_replies_touch_ticket'`,
    ),
    grants: await q(
      `select table_name, grantee, privilege_type from information_schema.role_table_grants
       where table_schema = 'public' and table_name like 'support%'
       order by 1, 2, 3`,
    ),
    buckets: await q(`select * from storage.buckets order by id`),
  };
}

// ---------------------------------------------------------------------------
// It applies, it applies twice, and it converges over an earlier draft
// ---------------------------------------------------------------------------

test("migration 0090 applies to a 0089-shaped database", async () => {
  const db = await applied();
  const { rows } = await db.query<{ table_name: string }>(
    `select table_name from information_schema.tables
     where table_schema = 'public' and table_name like 'support%' order by table_name`,
  );
  assert.deepEqual(
    rows.map((r) => r.table_name),
    ["support_ticket_attachments", "support_ticket_replies", "support_tickets"],
  );
  await db.close();
});

test("applying 0090 a second time changes nothing and keeps every row", async () => {
  // The header claims idempotency, and "did that go through?" is answered by
  // running it again. Same objects, same definitions, same data afterwards.
  const db = await applied();
  const id = await insertTicket(db);
  await insertReply(db, id, { author: STAFF, isStaff: true, via: "staff" });
  const before = await catalog(db);
  const rowBefore = await ticketRow(db, id);

  await db.exec(migration);

  assert.deepEqual(await catalog(db), before);
  const rowAfter = await ticketRow(db, id);
  assert.deepEqual(
    { ...rowAfter, updated_at: null },
    { ...rowBefore, updated_at: null },
    "a re-run must not rewrite a ticket",
  );
  await db.close();
});

/**
 * The earlier draft of this file, reduced to what differs from the end state:
 * no priority/sensitive/channel/context/outcome/created_by/clock columns, no
 * `via`, a six-value category CHECK, a queue index keyed on last_activity_at,
 * and a trigger that counted internal notes and bumped activity for them.
 */
const EARLIER_DRAFT = `
  create table public.support_tickets (
    id uuid primary key default gen_random_uuid(),
    reference text not null unique
      check (reference ~ '^B0-[2-9A-HJKMNP-TV-Z]{4}-[2-9A-HJKMNP-TV-Z]{4}$'),
    token text not null unique check (token ~ '^[A-Za-z0-9_-]{43}$'),
    user_id uuid references public.profiles(id) on delete set null,
    requester_email text not null,
    requester_name text check (requester_name is null or char_length(requester_name) <= 120),
    category text not null check (category in
      ('refund', 'billing', 'account', 'privacy', 'application', 'other')),
    subject text not null check (char_length(subject) between 1 and 160),
    body text not null check (char_length(body) between 20 and 8000),
    status text not null default 'open'
      check (status in ('open', 'waiting_on_requester', 'resolved', 'closed')),
    needs_reply boolean not null default true,
    receipt_ref text check (receipt_ref is null or char_length(receipt_ref) <= 200),
    payment_id uuid references public.payments(id) on delete set null,
    assigned_to uuid references public.profiles(id) on delete set null,
    reply_count int not null default 0,
    last_activity_at timestamptz not null default now(),
    resolved_at timestamptz,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
  );
  create table public.support_ticket_replies (
    id uuid primary key default gen_random_uuid(),
    ticket_id uuid not null references public.support_tickets(id) on delete cascade,
    author_id uuid references public.profiles(id) on delete set null,
    is_staff boolean not null default false,
    is_internal boolean not null default false,
    body text not null check (char_length(body) between 1 and 8000),
    notified_at timestamptz,
    created_at timestamptz not null default now()
  );
  create index support_tickets_queue_idx
    on public.support_tickets (last_activity_at desc) where needs_reply;
  create or replace function public.support_ticket_replies_touch_ticket()
  returns trigger language plpgsql security definer set search_path = public as $$
  declare tid uuid := coalesce(new.ticket_id, old.ticket_id);
  begin
    update public.support_tickets t
    set reply_count = (select count(*) from public.support_ticket_replies r where r.ticket_id = tid),
        last_activity_at = now()
    where t.id = tid;
    return null;
  end; $$;
  create trigger support_ticket_replies_touch_ticket
    after insert or delete on public.support_ticket_replies
    for each row execute procedure public.support_ticket_replies_touch_ticket();
`;

test("0090 converges a database that ran an earlier draft of it", async () => {
  // 0090 is unapplied everywhere as of writing, but the header promises a
  // re-run over an earlier draft lands the end state, and `create table if not
  // exists` alone would silently keep the old CHECKs and columns.
  const fresh = await applied();
  const want = await catalog(fresh);
  await fresh.close();

  const db = await setup();
  await db.exec(EARLIER_DRAFT);
  const { rows } = await db.query<{ id: string }>(
    `insert into public.support_tickets
       (reference, token, user_id, requester_email, category, subject, body, created_at)
     values ('B0-2222-3333', $1, $2, 'alex@example.com', 'refund', 'Refund',
             'I paid yesterday and would like a refund please.', '2026-09-01T10:00:00Z')
     returning id`,
    [nextToken(), USER],
  );
  const id = rows[0].id;
  await db.exec(`
    insert into public.support_ticket_replies (ticket_id, author_id, is_staff, is_internal, body, created_at) values
      ('${id}', '${STAFF}', true, true, 'Checking the charge.', '2026-09-01T11:00:00Z'),
      ('${id}', '${STAFF}', true, false, 'Refunded.', '2026-09-01T12:00:00Z'),
      ('${id}', '${USER}', false, false, 'Thanks!', '2026-09-01T13:00:00Z');
  `);

  await db.exec(migration);

  assert.deepEqual(await catalog(db), want, "the catalog must match a fresh apply");

  const t = await ticketRow(db, id);
  assert.equal(
    new Date(t.received_at).toISOString(),
    "2026-09-01T10:00:00.000Z",
    "the refund clock is the draft's created_at, not the moment the migration ran",
  );
  assert.equal(new Date(t.requester_activity_at).toISOString(), "2026-09-01T13:00:00.000Z");
  assert.equal(new Date(t.first_response_at).toISOString(), "2026-09-01T12:00:00.000Z");
  assert.equal(t.reply_count, 2, "the internal note no longer counts");
  assert.equal(t.priority, "normal");
  assert.equal(t.sensitive, false);
  assert.equal(t.channel, "web");
  const { rows: via } = await db.query<{ is_staff: boolean; via: string }>(
    `select is_staff, via from public.support_ticket_replies order by created_at`,
  );
  assert.deepEqual(
    via.map((r) => r.via),
    ["staff", "staff", "token"],
    "the draft's only requester path was the emailed token link",
  );
  await db.close();
});

// ---------------------------------------------------------------------------
// The FK names lib/support.ts embeds on
// ---------------------------------------------------------------------------

test("the foreign keys are named exactly what the PostgREST embeds expect", async () => {
  // These strings appear verbatim in the select lists in lib/support.ts. A
  // mismatch is a runtime 400 on every queue read, invisible to tsc and to
  // next build.
  const db = await applied();
  const { rows } = await db.query<{ conname: string }>(
    `select conname from pg_constraint
     where contype = 'f'
       and conrelid in ('public.support_tickets'::regclass,
                        'public.support_ticket_replies'::regclass,
                        'public.support_ticket_attachments'::regclass)
     order by conname`,
  );
  const names = rows.map((r) => r.conname);
  for (const expected of [
    "support_tickets_user_id_fkey",
    "support_tickets_assigned_to_fkey",
    "support_tickets_created_by_fkey",
    "support_tickets_payment_id_fkey",
    "support_ticket_replies_author_id_fkey",
    "support_ticket_replies_ticket_id_fkey",
    "support_ticket_attachments_ticket_id_fkey",
    "support_ticket_attachments_reply_id_fkey",
    "support_ticket_attachments_uploaded_by_fkey",
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

test("a ticket inserts with the defaults the queue depends on", async () => {
  const db = await applied();
  const id = await insertTicket(db);
  const t = await ticketRow(db, id);
  // A brand-new ticket is by definition waiting on us.
  assert.equal(t.status, "open");
  assert.equal(t.needs_reply, true);
  assert.equal(t.reply_count, 0);
  assert.equal(t.priority, "normal");
  assert.equal(t.sensitive, false);
  assert.equal(t.channel, "web");
  assert.deepEqual(t.context, {});
  assert.equal(t.outcome, null);
  assert.equal(t.first_response_at, null);
  assert.equal(
    new Date(t.received_at).getTime(),
    new Date(t.created_at).getTime(),
    "a self-filed request arrived when it was saved",
  );
  await db.close();
});

test("the reference CHECK refuses the symbols that get misread aloud", async () => {
  const db = await applied();
  // I, L, O, U, 0 and 1 are excluded so a reference read over the phone can't
  // be mistyped into a different real ticket. The regex is a second copy of
  // the alphabet in lib/support-access.ts, which is why it is asserted here.
  for (const bad of ["B0-4F2I-9C7K", "B0-4F2L-9C7K", "B0-4F2O-9C7K", "B0-4F2U-9C7K", "B0-4F20-9C7K"]) {
    await assert.rejects(
      insertTicket(db, { reference: bad }),
      /violates check constraint/,
      `${bad} should be refused`,
    );
  }
  await insertTicket(db, { reference: "B0-ZZZZ-2222" });
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
  await assert.rejects(insertTicket(db, { body: "help" }), /violates check constraint/);
  await db.close();
});

test("every vocabulary column refuses a value outside its list", async () => {
  const db = await applied();
  await assert.rejects(insertTicket(db, { category: "lawsuit" }), /violates check constraint/);
  // Every category the end state added is storable.
  for (const [i, c] of ["technical", "program", "concern", "accessibility", "feedback"].entries()) {
    await insertTicket(db, { category: c, reference: `B0-${"ABCDE"[i]}AAA-2222` });
  }
  const id = await insertTicket(db, { reference: "B0-ZZZZ-3333" });
  for (const [col, bad] of [
    ["status", "pending"],
    ["priority", "critical"],
    ["channel", "fax"],
    ["outcome", "won"],
  ]) {
    await assert.rejects(
      db.query(`update public.support_tickets set ${col} = $1 where id = $2`, [bad, id]),
      /violates check constraint/,
      `${col} = ${bad}`,
    );
  }
  // An outcome is optional.
  await db.query(`update public.support_tickets set outcome = null where id = $1`, [id]);
  await db.close();
});

test("context must be a small JSON object", async () => {
  const db = await applied();
  const id = await insertTicket(db);
  await assert.rejects(
    db.query(`update public.support_tickets set context = '[1,2]'::jsonb where id = $1`, [id]),
    /violates check constraint/,
    "an array is not a context",
  );
  await assert.rejects(
    db.query(
      `update public.support_tickets set context = jsonb_build_object('page', repeat(md5(random()::text), 200)) where id = $1`,
      [id],
    ),
    /violates check constraint/,
    "the 4 KB cap is the backstop for the server-side whitelist",
  );
  await db.query(
    `update public.support_tickets set context = '{"page":"/dashboard/billing","surface":"web"}'::jsonb where id = $1`,
    [id],
  );
  await db.close();
});

test("a logged request may have arrived in the past, never in the future", async () => {
  const db = await applied();
  const id = await insertTicket(db);
  // Staff logging an email that arrived three days ago.
  await db.query(
    `update public.support_tickets set received_at = created_at - interval '3 days' where id = $1`,
    [id],
  );
  await assert.rejects(
    db.query(
      `update public.support_tickets set received_at = created_at + interval '1 hour' where id = $1`,
      [id],
    ),
    /violates check constraint/,
  );
  await db.close();
});

test("a reply's side, credential and internal flag cannot contradict each other", async () => {
  const db = await applied();
  const id = await insertTicket(db);
  // Every legal combination.
  await insertReply(db, id, { author: USER, isStaff: false, via: "session" });
  await insertReply(db, id, { author: null, isStaff: false, via: "token" });
  await insertReply(db, id, { author: STAFF, isStaff: true, via: "staff" });
  await insertReply(db, id, { author: STAFF, isStaff: true, isInternal: true, via: "staff" });
  await insertReply(db, id, { author: null, isStaff: true, via: "system" });

  for (const [label, bad] of [
    ["a staff credential on a requester row", { author: USER, isStaff: false, via: "staff" }],
    ["a requester credential on a staff row", { author: STAFF, isStaff: true, via: "token" }],
    ["a requester's internal note", { author: USER, isStaff: false, isInternal: true, via: "session" }],
    ["an unknown credential", { author: USER, isStaff: false, via: "sms" }],
  ] as const) {
    await assert.rejects(insertReply(db, id, bad), /violates check constraint/, label);
  }
  await db.close();
});

test("an attachment is capped at 10 MB and only the team attaches to a note", async () => {
  const db = await applied();
  const id = await insertTicket(db);
  const insert = (over: Record<string, unknown>) => {
    const v = {
      storage_path: `t/${id}/${Math.random()}-a.png`,
      size_bytes: 1024,
      is_staff: false,
      is_internal: false,
      ...over,
    };
    return db.query(
      `insert into public.support_ticket_attachments
         (ticket_id, storage_path, file_name, size_bytes, is_staff, is_internal)
       values ($1, $2, 'a.png', $3, $4, $5)`,
      [id, v.storage_path, v.size_bytes, v.is_staff, v.is_internal],
    );
  };
  await insert({});
  await insert({ size_bytes: 10485760 });
  await assert.rejects(insert({ size_bytes: 10485761 }), /violates check constraint/);
  await assert.rejects(insert({ size_bytes: 0 }), /violates check constraint/);
  await assert.rejects(insert({ is_internal: true }), /violates check constraint/);
  await insert({ is_staff: true, is_internal: true });
  const path = `t/${id}/dup.png`;
  await insert({ storage_path: path });
  await assert.rejects(insert({ storage_path: path }), /unique/, "one row per stored object");
  const { rows } = await db.query<{ content_type: string }>(
    `select content_type from public.support_ticket_attachments limit 1`,
  );
  assert.equal(rows[0].content_type, "application/octet-stream");
  await db.close();
});

// ---------------------------------------------------------------------------
// The recount trigger
// ---------------------------------------------------------------------------

const OLD = "2026-01-01T00:00:00.000Z";

/** Pins all three clocks to a fixed past instant so "did it move" is exact. */
async function freezeClocks(db: PGlite, id: string) {
  await db.query(
    `update public.support_tickets
     set last_activity_at = $2, requester_activity_at = $2, created_at = $2, received_at = $2
     where id = $1`,
    [id, OLD],
  );
}

const iso = (v: unknown) => (v == null ? null : new Date(v as string).toISOString());

test("an internal note moves nothing the requester can see", async () => {
  const db = await applied();
  const id = await insertTicket(db);
  await freezeClocks(db, id);
  await insertReply(db, id, { author: STAFF, isStaff: true, isInternal: true, via: "staff" });
  const t = await ticketRow(db, id);
  assert.equal(t.reply_count, 0, "the requester sees reply_count");
  assert.equal(iso(t.last_activity_at), OLD, "the requester's list sorts on last_activity_at");
  assert.equal(iso(t.requester_activity_at), OLD);
  assert.equal(t.first_response_at, null, "a note is not a response");
  await db.close();
});

test("the first public staff reply stamps first_response_at, once", async () => {
  const db = await applied();
  const id = await insertTicket(db);
  await freezeClocks(db, id);
  await insertReply(db, id, { author: STAFF, isStaff: true, via: "staff" });
  const first = await ticketRow(db, id);
  assert.notEqual(first.first_response_at, null);
  assert.notEqual(iso(first.last_activity_at), OLD, "a public reply is activity");
  assert.equal(iso(first.requester_activity_at), OLD, "the team writing is not the requester writing");
  assert.equal(first.reply_count, 1);

  await db.query(`update public.support_tickets set first_response_at = $2 where id = $1`, [id, OLD]);
  await insertReply(db, id, { author: STAFF, isStaff: true, via: "staff" });
  const second = await ticketRow(db, id);
  assert.equal(iso(second.first_response_at), OLD, "only the first response counts");
  assert.equal(second.reply_count, 2);
  await db.close();
});

test("a system message is public activity but not a response", async () => {
  const db = await applied();
  const id = await insertTicket(db);
  await freezeClocks(db, id);
  await insertReply(db, id, { author: null, isStaff: true, via: "system" });
  const t = await ticketRow(db, id);
  assert.equal(t.first_response_at, null, "an auto-resolve note must not count as the team answering");
  assert.notEqual(iso(t.last_activity_at), OLD);
  assert.equal(t.reply_count, 1, "the requester sees it on the thread");
  await db.close();
});

test("a requester reply moves requester_activity_at, by session or by token", async () => {
  const db = await applied();
  for (const via of ["session", "token"]) {
    const id = await insertTicket(db, { reference: via === "session" ? "B0-2222-4444" : "B0-2222-5555" });
    await freezeClocks(db, id);
    await insertReply(db, id, { author: USER, isStaff: false, via });
    const t = await ticketRow(db, id);
    assert.notEqual(iso(t.requester_activity_at), OLD, via);
    assert.notEqual(iso(t.last_activity_at), OLD, via);
    assert.equal(t.first_response_at, null, via);
  }
  await db.close();
});

test("deleting a reply recounts public replies and leaves the clocks alone", async () => {
  const db = await applied();
  const id = await insertTicket(db);
  const a = await insertReply(db, id, { author: STAFF, isStaff: true, via: "staff" });
  await insertReply(db, id, { author: STAFF, isStaff: true, via: "staff" });
  await insertReply(db, id, { author: STAFF, isStaff: true, isInternal: true, via: "staff" });
  await freezeClocks(db, id);
  await db.query(`delete from public.support_ticket_replies where id = $1`, [a]);
  const t = await ticketRow(db, id);
  assert.equal(t.reply_count, 1);
  assert.equal(iso(t.last_activity_at), OLD);
  await db.close();
});

test("updated_at is maintained by the shared trigger function", async () => {
  const db = await applied();
  const id = await insertTicket(db);
  await db.query(`update public.support_tickets set updated_at = $2 where id = $1`, [id, OLD]);
  await db.query(`update public.support_tickets set status = 'resolved' where id = $1`, [id]);
  const t = await ticketRow(db, id);
  assert.notEqual(iso(t.updated_at), OLD);
  await db.close();
});

// ---------------------------------------------------------------------------
// A ticket outlives its account
// ---------------------------------------------------------------------------

test("deleting a profile leaves the ticket readable instead of destroying it", async () => {
  // The case that forces `on delete set null`: someone files a privacy ticket
  // asking us to delete their account, we honour it, and the record proving we
  // honoured it must survive the deletion it requested.
  const db = await applied();
  const id = await insertTicket(db);
  await insertReply(db, id, { author: STAFF, isStaff: true, via: "staff", body: "Deleted as requested." });
  await db.query(`delete from public.profiles where id = $1`, [USER]);
  const t = await ticketRow(db, id);
  assert.ok(t, "the ticket must still exist");
  assert.equal(t.user_id, null);
  assert.equal(t.requester_email, "alex@example.com");
  await db.close();
});

test("deleting a ticket takes its replies and attachments with it", async () => {
  const db = await applied();
  const id = await insertTicket(db);
  const reply = await insertReply(db, id, { author: STAFF, isStaff: true, via: "staff" });
  await db.query(
    `insert into public.support_ticket_attachments (ticket_id, reply_id, storage_path, file_name, size_bytes, is_staff)
     values ($1, $2, 't/x/a.png', 'a.png', 10, true)`,
    [id, reply],
  );
  await db.query(`delete from public.support_tickets where id = $1`, [id]);
  const { rows } = await db.query<{ n: number }>(
    `select (select count(*) from public.support_ticket_replies)::int
          + (select count(*) from public.support_ticket_attachments)::int as n`,
  );
  assert.equal(rows[0].n, 0);
  await db.close();
});

// ---------------------------------------------------------------------------
// Lockdown
// ---------------------------------------------------------------------------

const TABLES = ["support_tickets", "support_ticket_replies", "support_ticket_attachments"];

test("anon and authenticated hold no privileges on any support table", async () => {
  const db = await applied();
  for (const table of TABLES) {
    for (const role of ["anon", "authenticated"]) {
      for (const priv of ["select", "insert", "update", "delete"]) {
        const { rows } = await db.query<{ ok: boolean }>(
          `select has_table_privilege($1, $2, $3) as ok`,
          [role, `public.${table}`, priv],
        );
        assert.equal(rows[0].ok, false, `${role} must not hold ${priv} on ${table}`);
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

test("row level security is on and there is no requester write policy", async () => {
  const db = await applied();
  const { rows: tables } = await db.query<{ relname: string; relrowsecurity: boolean }>(
    `select relname, relrowsecurity from pg_class
     where oid in ('public.support_tickets'::regclass,
                   'public.support_ticket_replies'::regclass,
                   'public.support_ticket_attachments'::regclass)`,
  );
  assert.equal(tables.length, 3);
  for (const t of tables) assert.equal(t.relrowsecurity, true, `${t.relname} must have RLS enabled`);

  const { rows: policies } = await db.query<{ tablename: string; policyname: string; cmd: string }>(
    `select tablename, policyname, cmd from pg_policies where tablename like 'support%'`,
  );
  // Every write is the service role or a support.manage holder (`for all`);
  // a bare INSERT/UPDATE/DELETE policy would be a requester write path.
  for (const p of policies) {
    assert.ok(["SELECT", "ALL"].includes(p.cmd), `${p.policyname} is a ${p.cmd} policy`);
  }
  for (const table of TABLES) {
    assert.equal(
      policies.filter((p) => p.tablename === table && p.cmd === "SELECT").length,
      1,
      `${table} needs exactly one read policy`,
    );
  }
  await db.close();
});

// ---------------------------------------------------------------------------
// What the policies decide (the backstop)
//
// The app never reaches these tables as `authenticated` — the grants are
// revoked, asserted above. The policies matter the day a future migration
// grants a table back, so they are exercised here by granting SELECT (and, for
// the write rule, UPDATE) back in this throwaway database only.
// ---------------------------------------------------------------------------

async function withSeededThreads() {
  const db = await applied();
  const open = await insertTicket(db, { reference: "B0-AAAA-2222", category: "billing" });
  const concern = await insertTicket(db, {
    reference: "B0-BBBB-2222",
    category: "concern",
    subject: "A concern about a session",
    sensitive: true,
  });
  const ids = { open, concern };
  const replies: Record<string, { pub: string; note: string }> = {};
  for (const [k, id] of Object.entries(ids)) {
    const pub = await insertReply(db, id, { author: STAFF, isStaff: true, via: "staff" });
    const note = await insertReply(db, id, {
      author: STAFF,
      isStaff: true,
      isInternal: true,
      via: "staff",
    });
    replies[k] = { pub, note };
    await db.query(
      `insert into public.support_ticket_attachments (ticket_id, reply_id, storage_path, file_name, size_bytes, is_staff, is_internal)
       values ($1, null, $2, 'request.png', 10, false, false),
              ($1, $3, $4, 'note.png', 10, true, true)`,
      [id, `t/${id}/request.png`, note, `t/${id}/note.png`],
    );
  }
  await db.exec(`
    grant select on public.support_tickets, public.support_ticket_replies,
      public.support_ticket_attachments to authenticated;
  `);
  return { db, ids, replies };
}

async function visible(db: PGlite, uid: string) {
  const t = await as<{ reference: string }>(
    db,
    signedIn(uid),
    `select reference from public.support_tickets order by reference`,
  );
  const r = await as<{ n: number; notes: number }>(
    db,
    signedIn(uid),
    `select count(*)::int as n, (count(*) filter (where is_internal))::int as notes
     from public.support_ticket_replies`,
  );
  // No join to support_tickets here: a join would apply the ticket policy and
  // hide rows the attachment policy itself might have let through.
  const a = await as<{ file_name: string; ticket_id: string }>(
    db,
    signedIn(uid),
    `select file_name, ticket_id from public.support_ticket_attachments`,
  );
  const refs = new Map(
    (
      await db.query<{ id: string; reference: string }>(
        `select id, reference from public.support_tickets`,
      )
    ).rows.map((x) => [x.id, x.reference]),
  );
  return {
    tickets: t.rows.map((x) => x.reference),
    replies: r.rows[0].n,
    notes: r.rows[0].notes,
    files: a.rows.map((x) => `${refs.get(x.ticket_id)}:${x.file_name}`).sort(),
  };
}

test("a requester sees their own threads — the confidential one included — but no notes", async () => {
  const { db } = await withSeededThreads();
  const v = await visible(db, USER);
  assert.deepEqual(v.tickets, ["B0-AAAA-2222", "B0-BBBB-2222"]);
  assert.equal(v.replies, 2, "the public reply on each");
  assert.equal(v.notes, 0);
  assert.deepEqual(v.files, ["B0-AAAA-2222:request.png", "B0-BBBB-2222:request.png"]);
  await db.close();
});

test("support.view without support.sensitive sees nothing of a confidential concern", async () => {
  const { db } = await withSeededThreads();
  const v = await visible(db, VIEWER);
  assert.deepEqual(v.tickets, ["B0-AAAA-2222"], "the concern must not be listed");
  assert.equal(v.replies, 2, "the public reply and the note on the ordinary ticket only");
  assert.equal(v.notes, 1);
  assert.deepEqual(v.files, ["B0-AAAA-2222:note.png", "B0-AAAA-2222:request.png"]);
  await db.close();
});

test("support.manage without support.sensitive reads through the write policies — and still not the concern", async () => {
  // A `for all` policy grants SELECT as well, so a manage-only holder's reads
  // are decided by the staff write policies, not the read ones. Both have to
  // carry the confidentiality rule.
  const { db } = await withSeededThreads();
  const v = await visible(db, MANAGER);
  assert.deepEqual(v.tickets, ["B0-AAAA-2222"]);
  assert.equal(v.replies, 2);
  assert.equal(v.notes, 1);
  assert.deepEqual(v.files, ["B0-AAAA-2222:note.png", "B0-AAAA-2222:request.png"]);
  await db.close();
});

test("support.sensitive opens the concern, and '*' sees everything", async () => {
  const { db } = await withSeededThreads();
  for (const uid of [SENIOR, ADMIN]) {
    const v = await visible(db, uid);
    assert.deepEqual(v.tickets, ["B0-AAAA-2222", "B0-BBBB-2222"], uid);
    assert.equal(v.replies, 4, uid);
    assert.equal(v.notes, 2, uid);
    assert.equal(v.files.length, 4, uid);
  }
  await db.close();
});

test("a stranger sees nothing, and neither does anon", async () => {
  const { db } = await withSeededThreads();
  assert.deepEqual(await visible(db, STRANGER), { tickets: [], replies: 0, notes: 0, files: [] });
  await db.exec(`grant select on public.support_tickets to anon`);
  const { rows } = await as(db, { role: "anon" }, `select id from public.support_tickets`);
  assert.equal(rows.length, 0);
  await db.close();
});

test("a staff member who filed a concern reads it as its requester, not as staff", async () => {
  // A support.view holder can read their OWN concern (user_id = them) — but
  // the team's internal notes on it are written about them, and must stay
  // hidden: the note rule asks whether they can see the ticket as staff.
  const db = await applied();
  const id = await insertTicket(db, {
    reference: "B0-CCCC-2222",
    category: "concern",
    sensitive: true,
    user_id: VIEWER,
  });
  await insertReply(db, id, { author: SENIOR, isStaff: true, via: "staff" });
  await insertReply(db, id, { author: SENIOR, isStaff: true, isInternal: true, via: "staff" });
  await db.exec(`grant select on public.support_tickets, public.support_ticket_replies to authenticated`);
  const t = await as(db, signedIn(VIEWER), `select id from public.support_tickets`);
  assert.equal(t.rows.length, 1, "their own ticket");
  const r = await as<{ is_internal: boolean }>(
    db,
    signedIn(VIEWER),
    `select is_internal from public.support_ticket_replies`,
  );
  assert.deepEqual(r.rows.map((x) => x.is_internal), [false]);
  await db.close();
});

test("support.manage without support.sensitive cannot change a confidential concern", async () => {
  const { db, ids } = await withSeededThreads();
  await db.exec(`grant update on public.support_tickets to authenticated`);
  const tryUpdate = async (uid: string, id: string) =>
    (
      await as(
        db,
        signedIn(uid),
        `update public.support_tickets set priority = 'high' where id = $1 returning id`,
        [id],
      )
    ).rows.length;
  assert.equal(await tryUpdate(MANAGER, ids.open), 1, "an ordinary ticket is theirs to work");
  assert.equal(await tryUpdate(MANAGER, ids.concern), 0, "the concern is not");
  assert.equal(await tryUpdate(SENIOR, ids.concern), 1);
  assert.equal(await tryUpdate(VIEWER, ids.open), 0, "support.view is read-only");
  assert.equal(await tryUpdate(USER, ids.open), 0, "the requester never writes directly");
  await db.close();
});

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

test("the attachments bucket is private, 10 MB, with no MIME list and no policy", async () => {
  const db = await applied();
  const { rows } = await db.query<any>(
    `select public, file_size_limit, allowed_mime_types from storage.buckets where id = 'support-attachments'`,
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].public, false);
  assert.equal(Number(rows[0].file_size_limit), 10485760);
  assert.equal(rows[0].allowed_mime_types, null);
  const { rows: pol } = await db.query<any>(
    `select policyname from pg_policies where schemaname = 'storage'`,
  );
  assert.deepEqual(pol, [], "service role only — the call-recordings precedent");

  // A re-run restores what the code assumes but never lowers a raised limit.
  await db.exec(
    `update storage.buckets set public = true, file_size_limit = 52428800 where id = 'support-attachments'`,
  );
  await db.exec(migration);
  const { rows: after } = await db.query<any>(
    `select public, file_size_limit from storage.buckets where id = 'support-attachments'`,
  );
  assert.equal(after[0].public, false);
  assert.equal(Number(after[0].file_size_limit), 52428800);
  await db.close();
});

// ---------------------------------------------------------------------------
// The platform fixes that ride along
// ---------------------------------------------------------------------------

test("deduped notifications insert at all once 0090 replaces 0012's partial index", async () => {
  // PostgREST sends `on conflict (user_id, dedupe_key)` with no predicate, so
  // against 0012's partial index every deduped bell failed with 42P10.
  const db = await setup();
  const upsert = (key: string | null) =>
    db.query(
      `insert into public.notifications (user_id, type, title, dedupe_key)
       values ($1, 'support_ticket', 'New request', $2)
       on conflict (user_id, dedupe_key) do nothing`,
      [STAFF, key],
    );
  await assert.rejects(upsert("support:new:1"), /no unique or exclusion constraint/);

  await db.exec(migration);

  await upsert("support:new:1");
  await upsert("support:new:1"); // a retried fan-out
  await upsert(null);
  await upsert(null); // rows without a key never collide, exactly as before
  const { rows } = await db.query<{ dedupe_key: string | null }>(
    `select dedupe_key from public.notifications order by dedupe_key nulls last`,
  );
  assert.deepEqual(
    rows.map((r) => r.dedupe_key),
    ["support:new:1", null, null],
  );
  const { rows: idx } = await db.query<{ indexname: string; indexdef: string }>(
    `select indexname, indexdef from pg_indexes where tablename = 'notifications' and indexname like 'notifications_user_dedupe%'`,
  );
  assert.deepEqual(idx.map((i) => i.indexname), ["notifications_user_dedupe_key_idx"]);
  assert.doesNotMatch(idx[0].indexdef, /WHERE/i, "the replacement must not be partial");
  await db.close();
});

test("the pre-existing rate_limits hole is closed, table and function", async () => {
  const db = await setup();
  // With the default privileges modelled in setup(), the hole is real first.
  const before = await db.query<{ t: boolean; f: boolean }>(
    `select has_table_privilege('authenticated', 'public.rate_limits', 'select') as t,
            has_function_privilege('anon', 'public.rate_limit_check(text,integer)', 'execute') as f`,
  );
  assert.deepEqual(before.rows[0], { t: true, f: true }, "the holes this closes must exist first");

  await db.exec(migration);

  for (const role of ["anon", "authenticated"] as const) {
    const { rows } = await db.query<{ ok: boolean }>(
      `select has_table_privilege($1, 'public.rate_limits', 'select') as ok`,
      [role],
    );
    assert.equal(rows[0].ok, false, `${role} must not be able to read rate_limits`);
    await assert.rejects(
      as(db, { role, uid: role === "authenticated" ? USER : undefined }, `select public.rate_limit_check('password-reset:email:victim@example.com', 900)`),
      /permission denied/,
      `${role} must not be able to burn someone else's limit`,
    );
  }
  const { rows: rls } = await db.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
    `select relrowsecurity, relforcerowsecurity from pg_class where oid = 'public.rate_limits'::regclass`,
  );
  assert.equal(rls[0].relrowsecurity, true);
  assert.equal(
    rls[0].relforcerowsecurity,
    false,
    "FORCE would make the limiter fail, and checkRateLimit fails open",
  );

  // checkRateLimit runs as the service role through the RPC; it must keep
  // counting.
  const first = await as<{ n: number }>(db, { role: "service_role" }, `select public.rate_limit_check('k', 60) as n`);
  const second = await as<{ n: number }>(db, { role: "service_role" }, `select public.rate_limit_check('k', 60) as n`);
  assert.equal(first.rows[0].n, 1);
  assert.equal(second.rows[0].n, 2);
  await db.close();
});

test("the payments index the refund path needs exists", async () => {
  const db = await applied();
  const { rows } = await db.query<{ indexdef: string }>(
    `select indexdef from pg_indexes
     where schemaname = 'public' and indexname = 'payments_stripe_payment_intent_id_idx'`,
  );
  assert.equal(rows.length, 1);
  await db.close();
});

test("the queue index is partial on needs_reply and keyed on the reply clock", async () => {
  const db = await applied();
  const { rows } = await db.query<{ indexname: string; indexdef: string }>(
    `select indexname, indexdef from pg_indexes
     where schemaname = 'public' and tablename = 'support_tickets'
       and indexname in ('support_tickets_needs_reply_idx', 'support_tickets_queue_idx')`,
  );
  assert.deepEqual(rows.map((r) => r.indexname), ["support_tickets_needs_reply_idx"]);
  assert.match(rows[0].indexdef, /\(requester_activity_at\) WHERE needs_reply/i);
  await db.close();
});
