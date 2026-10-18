import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { MIGRATION_CHECKS } from "./migration-plan.ts";

/**
 * Migration 0109 against a throwaway Postgres: it applies twice, an investor's
 * own JWT can no longer file intro requests past the cap or rewrite one the
 * team acted on, nobody but the service role reads `admin_notes`, and every
 * read the policies allowed before still works for the columns the app shows.
 *
 * intro_requests is 0011's table with 0011's and 0019's policies; auth.uid()
 * reads a session setting (the events-migration-db.test.ts idiom), and the
 * default privileges hand the API roles `all` on new tables, as Supabase does.
 */

const migration = await readFile(
  new URL("../supabase/migrations/0109_intro_requests_server_writes.sql", import.meta.url),
  "utf8",
);

const ADMIN = "11111111-1111-4111-8111-111111111111";
const INVESTOR = "22222222-2222-4222-8222-222222222222";
const OTHER_INVESTOR = "33333333-3333-4333-8333-333333333333";
const MEMBER = "44444444-4444-4444-8444-444444444444";
const OUTSIDER = "55555555-5555-4555-8555-555555555555";
const TEAM = "66666666-6666-4666-8666-666666666666";
const OTHER_TEAM = "77777777-7777-4777-8777-777777777777";
const INTRO = "88888888-8888-4888-8888-888888888888";

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

    create table public.profiles (id uuid primary key, role text not null default 'student');
    create or replace function public.is_admin(uid uuid)
    returns boolean language sql stable security definer set search_path = public as $$
      select exists (select 1 from public.profiles where id = uid and role = 'admin') $$;
    create or replace function public.is_investor(uid uuid)
    returns boolean language sql stable security definer set search_path = public as $$
      select exists (select 1 from public.profiles where id = uid and role = 'investor') $$;
    create table public.teams (id uuid primary key, name text);
    create table public.team_members (team_id uuid, user_id uuid);

    -- intro_requests as 0011 + 0019 left it.
    create table public.intro_requests (
      id uuid primary key default gen_random_uuid(),
      investor_id uuid not null references public.profiles(id) on delete cascade,
      team_id uuid not null references public.teams(id) on delete cascade,
      status text not null default 'requested'
        check (status in ('requested', 'intro_made', 'meeting_held', 'committed', 'wired', 'passed')),
      message text,
      admin_notes text,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      unique (investor_id, team_id)
    );
    alter table public.intro_requests enable row level security;
    create policy "intro_requests read" on public.intro_requests
      for select using (public.is_admin(auth.uid()) or investor_id = auth.uid());
    create policy "intro_requests investor write" on public.intro_requests
      for insert with check (investor_id = auth.uid() and public.is_investor(auth.uid()));
    create policy "intro_requests update" on public.intro_requests
      for update using (public.is_admin(auth.uid()) or investor_id = auth.uid())
      with check (public.is_admin(auth.uid()) or investor_id = auth.uid());
    create policy "intro_requests team member read" on public.intro_requests
      for select using (exists (
        select 1 from public.team_members tm
        where tm.team_id = intro_requests.team_id and tm.user_id = auth.uid()));
  `);
  await db.exec(`
    insert into public.profiles values
      ('${ADMIN}', 'admin'), ('${INVESTOR}', 'investor'), ('${OTHER_INVESTOR}', 'investor'),
      ('${MEMBER}', 'student'), ('${OUTSIDER}', 'student');
    insert into public.teams values ('${TEAM}', 'Rocket'), ('${OTHER_TEAM}', 'Comet');
    insert into public.team_members values ('${TEAM}', '${MEMBER}');
    insert into public.intro_requests (id, investor_id, team_id, status, message, admin_notes)
      values ('${INTRO}', '${INVESTOR}', '${TEAM}', 'intro_made', 'Love the traction', 'Founder is shy; warm intro via mentor');
  `);
  return db;
}

/** Runs `sql` as a signed-in user, or as the anon key when `uid` is null. */
async function as<T = any>(db: PGlite, uid: string | null, sql: string) {
  await db.exec(
    `set role ${uid ? "authenticated" : "anon"}; select set_config('request.jwt.claim.sub', '${uid ?? ""}', false);`,
  );
  try {
    return await db.query<T>(sql);
  } finally {
    await db.exec(`reset role; select set_config('request.jwt.claim.sub', '', false);`);
  }
}

const verify = async (db: PGlite) => (await db.query<{ ok: boolean }>(MIGRATION_CHECKS["0109"])).rows[0]?.ok;

test("before 0109: the holes this closes are real", async () => {
  const db = await setup();
  assert.equal(await verify(db), false);
  // An investor files a request with their own JWT, past any cap…
  const ins = await as(db, INVESTOR, `insert into public.intro_requests (investor_id, team_id) values ('${INVESTOR}', '${OTHER_TEAM}') returning id`);
  assert.equal(ins.rows.length, 1);
  // …puts a made intro back in the queue, and reads the team's notes.
  const upd = await as(db, INVESTOR, `update public.intro_requests set status = 'requested' where id = '${INTRO}' returning id`);
  assert.equal(upd.rows.length, 1);
  const notes = await as(db, MEMBER, `select admin_notes from public.intro_requests`);
  assert.equal(notes.rows[0].admin_notes, "Founder is shy; warm intro via mentor");
});

test("0109 applies twice, and its verify query passes", async () => {
  const db = await setup();
  await db.exec(migration);
  await db.exec(migration);
  assert.equal(await verify(db), true);
  const writes = await db.query(
    `select policyname from pg_policies where schemaname = 'public' and tablename = 'intro_requests' and cmd <> 'SELECT'`,
  );
  assert.deepEqual(writes.rows, []);
  const rows = await db.query<any>(`select status, admin_notes from public.intro_requests`);
  assert.deepEqual(rows.rows, [{ status: "intro_made", admin_notes: "Founder is shy; warm intro via mentor" }], "no row changed");
});

test("no API role writes the table any more, admins included", async () => {
  const db = await setup();
  await db.exec(migration);
  for (const uid of [INVESTOR, ADMIN, MEMBER, null]) {
    await assert.rejects(
      as(db, uid, `insert into public.intro_requests (investor_id, team_id) values ('${INVESTOR}', '${OTHER_TEAM}')`),
      /permission denied/,
      `insert as ${uid}`,
    );
    await assert.rejects(
      as(db, uid, `update public.intro_requests set status = 'wired' where id = '${INTRO}'`),
      /permission denied/,
      `update as ${uid}`,
    );
    await assert.rejects(as(db, uid, `delete from public.intro_requests`), /permission denied/, `delete as ${uid}`);
  }
  const row = await db.query<any>(`select status from public.intro_requests where id = '${INTRO}'`);
  assert.equal(row.rows[0].status, "intro_made");
});

test("every read the app relied on still works, without admin_notes", async () => {
  const db = await setup();
  await db.exec(migration);
  const cols = "id, status, message, created_at, updated_at, investor_id, team_id";
  // The investor's own row, the team's members, and admins: as before.
  assert.equal((await as(db, INVESTOR, `select ${cols} from public.intro_requests`)).rows.length, 1);
  assert.equal((await as(db, MEMBER, `select ${cols} from public.intro_requests`)).rows.length, 1);
  assert.equal((await as(db, ADMIN, `select ${cols} from public.intro_requests`)).rows.length, 1);
  // Nobody else.
  assert.equal((await as(db, OTHER_INVESTOR, `select id from public.intro_requests`)).rows.length, 0);
  assert.equal((await as(db, OUTSIDER, `select id from public.intro_requests`)).rows.length, 0);
  await assert.rejects(as(db, null, `select id from public.intro_requests`), /permission denied/);
  // The team's notes are the team's: not to the investor, not to the
  // students, and `select *` (which would include them) is refused.
  for (const uid of [INVESTOR, MEMBER, ADMIN]) {
    await assert.rejects(as(db, uid, `select admin_notes from public.intro_requests`), /permission denied/, `admin_notes as ${uid}`);
    await assert.rejects(as(db, uid, `select * from public.intro_requests`), /permission denied/, `* as ${uid}`);
  }
  // The service role (here: the owner) reads and writes everything, which is
  // what every page and action uses.
  const all = await db.query<any>(`select admin_notes from public.intro_requests`);
  assert.equal(all.rows.length, 1);
  await db.exec(`update public.intro_requests set status = 'meeting_held' where id = '${INTRO}'`);
});
