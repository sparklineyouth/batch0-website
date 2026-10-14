import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";

/**
 * Migration 0098 against a throwaway Postgres: it applies twice, changes only
 * the defaults for new rows, and the write policy really is events.manage —
 * a mentor-panel holder can no longer write events over PostgREST.
 *
 * auth.uid() reads a session setting and has_permission() is the real 0048
 * shape over a small app_roles table (the support-migration-db.test.ts idiom).
 */

const migration = await readFile(
  new URL("../supabase/migrations/0098_events.sql", import.meta.url),
  "utf8",
);

const ADMIN = "11111111-1111-4111-8111-111111111111";
const EVENTS_MANAGER = "22222222-2222-4222-8222-222222222222";
const MENTOR = "33333333-3333-4333-8333-333333333333";
const STUDENT = "44444444-4444-4444-8444-444444444444";
const EXISTING = "55555555-5555-4555-8555-555555555555";
const COHORT = "66666666-6666-4666-8666-666666666666";

async function setup() {
  const db = new PGlite();
  await db.exec(`
    create schema if not exists auth;
    do $$ begin
      if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon; end if;
      if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated; end if;
    end $$;
    create or replace function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    grant usage on schema auth to anon, authenticated;
    grant usage on schema public to anon, authenticated;
    alter default privileges in schema public grant all on tables to anon, authenticated;

    create table public.app_roles (slug text primary key, permissions text[] not null default '{}');
    create table public.profiles (id uuid primary key, role text not null default 'student');
    create or replace function public.has_permission(uid uuid, perm text)
    returns boolean language sql stable security definer set search_path = public as $$
      select exists (
        select 1 from public.profiles p join public.app_roles r on r.slug = p.role
        where p.id = uid
          and (r.permissions @> array['*']::text[] or r.permissions @> array[perm])
      ) $$;
    create or replace function public.is_staff(uid uuid)
    returns boolean language sql stable security definer set search_path = public as $$
      select public.has_permission(uid, 'mentor.panel') $$;

    create table public.cohorts (id uuid primary key, name text);
    create table public.enrollments (user_id uuid, cohort_id uuid);

    -- events as 0005 + 0058 + 0084 left it, reduced to what 0098 touches.
    create table public.events (
      id uuid primary key default gen_random_uuid(),
      cohort_id uuid references public.cohorts(id) on delete cascade,
      type text not null default 'webinar',
      title text not null,
      starts_at timestamptz not null,
      ends_at timestamptz,
      visibility text not null default 'enrolled',
      live_mode text not null default 'external',
      audience_mode text not null default 'private'
        check (audience_mode in ('private','moderated','open')),
      auto_record boolean not null default false,
      auto_share boolean not null default false
    );
    alter table public.events enable row level security;
    create policy "events read" on public.events for select using (
      visibility = 'public'
      or public.is_staff(auth.uid())
      or (visibility = 'enrolled' and exists (
        select 1 from public.enrollments e
        where e.user_id = auth.uid() and e.cohort_id = events.cohort_id))
    );
    create policy "events staff write" on public.events
      for all using (public.is_staff(auth.uid())) with check (public.is_staff(auth.uid()));
  `);
  await db.exec(`
    insert into public.app_roles values
      ('admin', array['*']),
      ('events_lead', array['events.manage']),
      ('mentor', array['mentor.panel']),
      ('student', array[]::text[]);
    insert into public.profiles values
      ('${ADMIN}', 'admin'), ('${EVENTS_MANAGER}', 'events_lead'),
      ('${MENTOR}', 'mentor'), ('${STUDENT}', 'student');
    insert into public.cohorts values ('${COHORT}', 'Fall');
    insert into public.enrollments values ('${STUDENT}', '${COHORT}');
    insert into public.events (id, cohort_id, title, starts_at, live_mode)
      values ('${EXISTING}', '${COHORT}', 'Existing workshop', now(), 'hosted');
  `);
  return db;
}

async function as<T = any>(db: PGlite, uid: string, sql: string) {
  await db.exec(
    `set role authenticated; select set_config('request.jwt.claim.sub', '${uid}', false);`,
  );
  try {
    return await db.query<T>(sql);
  } finally {
    await db.exec(`reset role; select set_config('request.jwt.claim.sub', '', false);`);
  }
}

test("0098 applies twice and only changes defaults for new rows", async () => {
  const db = await setup();
  await db.exec(migration);
  await db.exec(migration);

  const defaults = (
    await db.query<any>(
      `select column_name, column_default from information_schema.columns
        where table_schema='public' and table_name='events'
          and column_name in ('audience_mode','auto_record')`,
    )
  ).rows;
  const def = Object.fromEntries(defaults.map((r: any) => [r.column_name, r.column_default]));
  assert.match(def.audience_mode, /open/);
  assert.match(def.auto_record, /true/);

  const existing = (
    await db.query<any>(`select audience_mode, auto_record from public.events where id = $1`, [
      EXISTING,
    ])
  ).rows[0];
  assert.deepEqual(existing, { audience_mode: "private", auto_record: false });

  await db.query(`insert into public.events (title, starts_at) values ('New', now())`);
  const fresh = (
    await db.query<any>(`select audience_mode, auto_record from public.events where title='New'`)
  ).rows[0];
  assert.deepEqual(fresh, { audience_mode: "open", auto_record: true });

  const policies = (
    await db.query<any>(
      `select policyname, qual, with_check from pg_policies
        where schemaname='public' and tablename='events' and policyname='events staff write'`,
    )
  ).rows;
  assert.equal(policies.length, 1);
  assert.match(policies[0].qual, /events\.manage/);
  assert.match(policies[0].with_check, /events\.manage/);
});

test("a mentor-panel holder can read events but no longer write them", async () => {
  const db = await setup();
  await db.exec(migration);

  const seen = await as(db, MENTOR, `select id from public.events`);
  assert.equal(seen.rows.length, 1, "staff still read every event");

  await assert.rejects(
    as(
      db,
      MENTOR,
      `insert into public.events (title, starts_at, visibility) values ('Sneaky', now(), 'public')`,
    ),
    /row-level security/,
  );
  const upd = await as(db, MENTOR, `update public.events set visibility='public' returning id`);
  assert.equal(upd.rows.length, 0);
  const del = await as(db, MENTOR, `delete from public.events returning id`);
  assert.equal(del.rows.length, 0);
  const still = await db.query<any>(`select visibility from public.events where id = $1`, [EXISTING]);
  assert.equal(still.rows[0].visibility, "enrolled");
});

test("events.manage (and '*') still write; students never do", async () => {
  const db = await setup();
  await db.exec(migration);

  for (const uid of [EVENTS_MANAGER, ADMIN]) {
    const ins = await as(
      db,
      uid,
      `insert into public.events (title, starts_at) values ('By ${uid.slice(0, 4)}', now()) returning id`,
    );
    assert.equal(ins.rows.length, 1);
    const upd = await as(db, uid, `update public.events set title = title returning id`);
    assert.ok(upd.rows.length >= 1);
  }

  const read = await as(db, STUDENT, `select id from public.events where id = '${EXISTING}'`);
  assert.equal(read.rows.length, 1, "an enrolled student still reads their cohort's event");
  await assert.rejects(
    as(db, STUDENT, `insert into public.events (title, starts_at) values ('x', now())`),
    /row-level security/,
  );
  const upd = await as(db, STUDENT, `update public.events set title='x' returning id`);
  assert.equal(upd.rows.length, 0);
});
