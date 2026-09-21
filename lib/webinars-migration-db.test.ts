import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";

/**
 * Migration 0084, executed for real against a throwaway Postgres.
 *
 * Worth the setup cost because 0084 is not a column addition: it carries a
 * SECURITY DEFINER function, a recount trigger, eleven policies, a widened
 * CHECK on a table with live rows, and a column-level REVOKE that closes a
 * privilege escalation. None of that is verifiable by reading, and all of it is
 * pasted into the Supabase SQL editor BY HAND — there is no runner, no ledger,
 * and no CI step between the file and production.
 *
 * The one thing this deliberately does NOT assert is what the policies decide.
 * PGlite has no `auth.uid()` session to speak of, so the stub below returns
 * null and every policy evaluates as "signed out". Asserting the privacy rules
 * here would be asserting the stub. What IS asserted is that they parse, apply,
 * and re-apply — which is the failure mode that would otherwise be discovered
 * at 7pm with an audience waiting.
 */

const migration = await readFile(
  new URL("../supabase/migrations/0084_webinars.sql", import.meta.url),
  "utf8",
);

const EVENT = "11111111-1111-4111-8111-111111111111";
const ASKER = "22222222-2222-4222-8222-222222222222";
const GUEST = "33333333-3333-4333-8333-333333333333";
const VOTER_A = "44444444-4444-4444-8444-444444444444";
const VOTER_B = "55555555-5555-4555-8555-555555555555";

/**
 * The shape 0084 assumes is already there: 0001..0083, reduced to exactly the
 * objects it touches. Anything it does not reference is left out, so a failure
 * points at the migration rather than at the fixture.
 */
async function setup() {
  const db = new PGlite();
  await db.exec(`
    create schema if not exists storage;
    create schema if not exists auth;

    -- PostgREST's roles. They exist here only so the column-level REVOKE at
    -- the end of the speakers section has something to revoke from.
    do $$ begin
      if not exists (select 1 from pg_roles where rolname = 'anon') then
        create role anon;
      end if;
      if not exists (select 1 from pg_roles where rolname = 'authenticated') then
        create role authenticated;
      end if;
    end $$;

    -- Signed out. Every policy therefore evaluates false, which is fine: this
    -- test is about whether the DDL applies, not about what it decides.
    create or replace function auth.uid() returns uuid language sql stable as $$
      select null::uuid $$;

    -- Supabase grants anon and authenticated full table privileges in the
    -- public schema
    -- by default, and does it through ALTER DEFAULT PRIVILEGES — so a table
    -- created by a LATER migration is granted automatically, without that
    -- migration saying anything.
    --
    -- Modelling it here is what makes the claim_token test mean something.
    -- Without these two lines the roles start with no privileges at all, the
    -- revoke has nothing to take away, and the test passes for the wrong
    -- reason while production stays wide open.
    grant usage on schema public to anon, authenticated;
    alter default privileges in schema public
      grant all on tables to anon, authenticated;

    create table public.profiles (
      id uuid primary key,
      email text,
      full_name text,
      role text default 'student'
    );
    create table public.cohorts (id uuid primary key, name text);
    create table public.enrollments (user_id uuid, cohort_id uuid);
    create table public.demo_day_tickets (
      user_id uuid, cohort_id uuid, status text
    );

    create table public.events (
      id uuid primary key,
      cohort_id uuid references public.cohorts(id) on delete cascade,
      type text not null check (type in ('demo_day','office_hours','workshop','other')),
      title text not null,
      description text,
      starts_at timestamptz not null,
      ends_at timestamptz,
      location text,
      zoom_url text,
      recording_url text,
      visibility text not null default 'enrolled'
        check (visibility in ('enrolled','staff','public')),
      live_mode text not null default 'external',
      daily_room_name text,
      daily_room_url text,
      display_viewer_count integer,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
    alter table public.events
      add constraint events_live_mode_check check (live_mode in ('external','hosted'));
    alter table public.events enable row level security;

    create table public.webinar_questions (
      id uuid primary key default gen_random_uuid(),
      event_id uuid not null references public.events(id) on delete cascade,
      asker_id uuid not null references public.profiles(id) on delete cascade,
      body text not null check (length(btrim(body)) between 1 and 500),
      status text not null default 'open'
        check (status in ('open','answered','dismissed')),
      resolved_by uuid references public.profiles(id) on delete set null,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
    alter table public.webinar_questions enable row level security;

    create table storage.buckets (
      id text primary key,
      name text,
      public boolean,
      file_size_limit bigint,
      allowed_mime_types text[]
    );
    create table storage.objects (id uuid default gen_random_uuid(), bucket_id text);
    alter table storage.objects enable row level security;

    -- The helper functions 0084's policies call.
    create or replace function public.is_admin(uid uuid) returns boolean
      language sql stable as $$ select false $$;
    create or replace function public.is_staff(uid uuid) returns boolean
      language sql stable as $$ select false $$;
    create or replace function public.has_permission(uid uuid, perm text) returns boolean
      language sql stable as $$ select false $$;
    create or replace function public.touch_updated_at() returns trigger
      language plpgsql as $$ begin new.updated_at = now(); return new; end $$;
  `);

  await db.query(
    `insert into public.profiles(id, full_name) values ($1,'Asker'),($2,'Guest'),($3,'A'),($4,'B')`,
    [ASKER, GUEST, VOTER_A, VOTER_B],
  );
  await db.query(
    `insert into public.events(id, type, title, starts_at, live_mode)
     values ($1,'workshop','Existing workshop', now(), 'hosted')`,
    [EVENT],
  );
  return db;
}

test("0084 applies cleanly, twice, over an existing hosted workshop", async () => {
  const db = await setup();
  try {
    await db.exec(migration);
    // Idempotency is not a nicety here — these files are pasted in by hand, and
    // "did I already run this one?" is answered by re-running it.
    await db.exec(migration);

    const cols = (
      await db.query<any>(
        `select column_name, data_type, column_default, is_nullable
           from information_schema.columns
          where table_schema='public' and table_name='events'
            and column_name in ('audience_mode','auto_record','auto_share',
                                'assets_shared_at','premiere_seconds','qa_opens_at',
                                'live_started_at','live_ended_at')`,
      )
    ).rows;
    assert.equal(cols.length, 8, "every new events column is present");

    const mode = cols.find((c: any) => c.column_name === "audience_mode");
    assert.match(
      mode.column_default,
      /private/,
      "The default must be the private behaviour every existing event already has",
    );

    for (const table of [
      "event_speakers",
      "event_assets",
      "webinar_messages",
      "webinar_question_votes",
      "webinar_polls",
      "webinar_poll_votes",
    ]) {
      const { rows } = await db.query<any>(
        `select 1 from information_schema.tables
          where table_schema='public' and table_name=$1`,
        [table],
      );
      assert.equal(rows.length, 1, `${table} exists`);
    }
  } finally {
    await db.close();
  }
});

test("an event written before 0084 keeps working, and its audience stays private", async () => {
  const db = await setup();
  try {
    await db.exec(migration);
    const { rows } = await db.query<any>(
      `select audience_mode, auto_record, auto_share, live_mode
         from public.events where id=$1`,
      [EVENT],
    );
    assert.equal(
      rows[0].audience_mode,
      "private",
      "A migration must never switch an existing webinar's audience on",
    );
    assert.equal(rows[0].auto_record, false);
    assert.equal(rows[0].auto_share, false);
    assert.equal(rows[0].live_mode, "hosted", "The row is untouched");
  } finally {
    await db.close();
  }
});

test("the widened CHECKs accept webinar and premiere, and still refuse nonsense", async () => {
  const db = await setup();
  try {
    await db.exec(migration);

    await db.query(
      `insert into public.events(id,type,title,starts_at,live_mode,audience_mode)
       values (gen_random_uuid(),'webinar','A webinar', now(), 'premiere', 'moderated')`,
    );

    await assert.rejects(
      () =>
        db.query(
          `insert into public.events(id,type,title,starts_at)
           values (gen_random_uuid(),'seminar','Nope', now())`,
        ),
      /events_type_check/,
      "Widening the type must not turn it into a free-text column",
    );

    await assert.rejects(
      () =>
        db.query(
          `insert into public.events(id,type,title,starts_at,live_mode)
           values (gen_random_uuid(),'webinar','Nope', now(), 'recorded')`,
        ),
      /events_live_mode_check/,
    );

    await assert.rejects(
      () =>
        db.query(
          `insert into public.events(id,type,title,starts_at,audience_mode)
           values (gen_random_uuid(),'webinar','Nope', now(), 'public')`,
        ),
      /events_audience_mode_check/,
      "An unknown audience mode must be impossible to store, not merely normalised on read",
    );

    // The typo guard: an extra digit would park the audience in front of a
    // video that never ends and a Q&A that never opens.
    await assert.rejects(
      () =>
        db.query(
          `insert into public.events(id,type,title,starts_at,premiere_seconds)
           values (gen_random_uuid(),'webinar','Nope', now(), 999999)`,
        ),
      /events_premiere_seconds_check/,
    );
  } finally {
    await db.close();
  }
});

test("claim_token and email are unreadable by ordinary users, while the row stays readable", async () => {
  const db = await setup();
  try {
    await db.exec(migration);
    // This is the privilege escalation the revoke closes: RLS is row-level, so
    // without it any signed-in student could read the token for a webinar they
    // can see, claim the slot, and walk out with broadcast rights, moderation,
    // and the room's audience roster.
    for (const role of ["anon", "authenticated"]) {
      const { rows } = await db.query<any>(
        `select
           has_column_privilege($1,'public.event_speakers','claim_token','SELECT') as tok,
           has_column_privilege($1,'public.event_speakers','email','SELECT')       as email,
           has_column_privilege($1,'public.event_speakers','name','SELECT')        as name`,
        [role],
      );
      assert.equal(rows[0].tok, false, `${role} must not read claim_token`);
      assert.equal(rows[0].email, false, `${role} must not read email`);
      assert.equal(
        rows[0].name,
        true,
        `${role} must still read the speaker card — that is the point of a column-level revoke`,
      );
    }
  } finally {
    await db.close();
  }
});

test("is_event_speaker answers per event, not globally", async () => {
  const db = await setup();
  try {
    await db.exec(migration);
    const other = "66666666-6666-4666-8666-666666666666";
    await db.query(
      `insert into public.events(id,type,title,starts_at,live_mode)
       values ($1,'webinar','Other', now(), 'hosted')`,
      [other],
    );
    await db.query(
      `insert into public.event_speakers(event_id,user_id,name)
       values ($1,$2,'Guest')`,
      [EVENT, GUEST],
    );

    const { rows } = await db.query<any>(
      `select public.is_event_speaker($1,$2) as here,
              public.is_event_speaker($1,$3) as elsewhere,
              public.is_event_speaker($4,$2) as someone_else`,
      [GUEST, EVENT, other, ASKER],
    );
    assert.equal(rows[0].here, true);
    assert.equal(
      rows[0].elsewhere,
      false,
      "A speaker grant is scoped to one event — that is the whole reason it exists instead of events.manage",
    );
    assert.equal(rows[0].someone_else, false);
  } finally {
    await db.close();
  }
});

test("the vote trigger recounts rather than steps, so it cannot drift", async () => {
  const db = await setup();
  try {
    await db.exec(migration);
    const { rows: q } = await db.query<any>(
      `insert into public.webinar_questions(event_id,asker_id,body)
       values ($1,$2,'How do I raise a seed round?') returning id`,
      [EVENT, ASKER],
    );
    const qid = q[0].id;

    await db.query(
      `insert into public.webinar_question_votes(question_id,voter_id)
       values ($1,$2),($1,$3)`,
      [qid, VOTER_A, VOTER_B],
    );
    let count = (
      await db.query<any>(
        `select vote_count from public.webinar_questions where id=$1`,
        [qid],
      )
    ).rows[0].vote_count;
    assert.equal(count, 2);

    await db.query(
      `delete from public.webinar_question_votes where question_id=$1 and voter_id=$2`,
      [qid, VOTER_A],
    );
    count = (
      await db.query<any>(
        `select vote_count from public.webinar_questions where id=$1`,
        [qid],
      )
    ).rows[0].vote_count;
    assert.equal(count, 1, "Un-voting must take the count back down");

    // The primary key is what makes a double-click idempotent, and the recount
    // is what keeps the number right when it isn't.
    await assert.rejects(
      () =>
        db.query(
          `insert into public.webinar_question_votes(question_id,voter_id) values ($1,$2)`,
          [qid, VOTER_B],
        ),
      /duplicate key/,
    );
  } finally {
    await db.close();
  }
});

test("a recording segment index is unique, so a retried upload replaces rather than duplicates", async () => {
  const db = await setup();
  try {
    await db.exec(migration);
    await db.query(
      `insert into public.event_assets(event_id,kind,storage_path,filename,sort_order)
       values ($1,'recording','p/0.webm','0.webm',0)`,
      [EVENT],
    );
    await assert.rejects(
      () =>
        db.query(
          `insert into public.event_assets(event_id,kind,storage_path,filename,sort_order)
           values ($1,'recording','p/0-retry.webm','0.webm',0)`,
          [EVENT],
        ),
      /event_assets_recording_segment|duplicate key/,
      "Otherwise a recorder recovering from a dropped connection plays the same five minutes twice",
    );

    // Decks are NOT covered by that index — an event may have several, all at
    // sort_order 0 until someone reorders them.
    await db.query(
      `insert into public.event_assets(event_id,kind,storage_path,filename,sort_order)
       values ($1,'deck','p/a.pdf','a.pdf',0),($1,'handout','p/b.pdf','b.pdf',0)`,
      [EVENT],
    );
  } finally {
    await db.close();
  }
});

test("the webinar-media bucket is private and large enough for a premiere", async () => {
  const db = await setup();
  try {
    await db.exec(migration);
    const { rows } = await db.query<any>(
      `select public, file_size_limit from storage.buckets where id='webinar-media'`,
    );
    assert.equal(rows.length, 1);
    assert.equal(
      rows[0].public,
      false,
      "An enrolled-only webinar's deck is enrolled-only; a public bucket cannot express that",
    );
    assert.equal(Number(rows[0].file_size_limit), 2147483648);

    // Re-running must not quietly shrink a limit an operator raised by hand.
    await db.query(
      `update storage.buckets set file_size_limit = 5368709120 where id='webinar-media'`,
    );
    await db.exec(migration);
    const after = (
      await db.query<any>(
        `select file_size_limit from storage.buckets where id='webinar-media'`,
      )
    ).rows[0];
    assert.equal(Number(after.file_size_limit), 5368709120);
  } finally {
    await db.close();
  }
});
