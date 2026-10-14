import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";

/**
 * Migration 0094 (Google Drive), executed against a throwaway Postgres —
 * applied, re-applied, then queried AS signed-in users with RLS in force.
 *
 * What it proves: the new team_drive_links table is readable by the team,
 * mentors and team managers only (not investors, not other teams, not
 * anon), and writable by nobody signed in; the legacy upload tables and
 * buckets are frozen for writes but still readable; the deck link only takes
 * https; and the lesson/notification links into /dashboard/files are
 * repointed.
 */

const migration = await readFile(
  new URL("../supabase/migrations/0094_google_drive.sql", import.meta.url),
  "utf8",
);

const MEMBER = "11111111-1111-4111-8111-111111111111";
const OUTSIDER = "22222222-2222-4222-8222-222222222222"; // student on another team
const MENTOR = "33333333-3333-4333-8333-333333333333";
const MANAGER = "44444444-4444-4444-8444-444444444444"; // custom role: teams.manage only
const INVESTOR = "55555555-5555-4555-8555-555555555555";
const ADMIN = "66666666-6666-4666-8666-666666666666";
const TEAM = "aaaaaaaa-0000-4000-8000-000000000001";
const OTHER_TEAM = "aaaaaaaa-0000-4000-8000-000000000002";
const FOLDER = "1AbCdEfGhIjKlMnOpQrStUvWxYz012345";
const DOC = "1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms";

async function setup() {
  const db = new PGlite();
  await db.exec(`
    create schema if not exists auth;
    create schema if not exists storage;
    do $$ begin
      if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon; end if;
      if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated; end if;
    end $$;

    -- The signed-in user, as PostgREST would set it.
    create or replace function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    grant usage on schema auth to anon, authenticated;

    -- Supabase's default privileges: every table a later migration creates is
    -- granted to both API roles, so a missing revoke would show up here.
    grant usage on schema public to anon, authenticated;
    grant usage on schema storage to anon, authenticated;
    alter default privileges in schema public grant all on tables to anon, authenticated;
    alter default privileges in schema public grant execute on functions to anon, authenticated;

    create table public.profiles (id uuid primary key, role text not null default 'student');
    create table public.app_roles (slug text primary key, permissions text[] not null);
    insert into public.app_roles values
      ('student', array['student.dashboard']),
      ('mentor', array['mentor.panel']),
      ('team-manager', array['teams.manage']),
      ('investor', array['investor.panel']),
      ('admin', array['*']);
    -- Same shape as 0048.
    create or replace function public.has_permission(uid uuid, perm text) returns boolean
      language sql stable security definer set search_path = public as $$
      select exists (
        select 1 from public.profiles p join public.app_roles r on r.slug = p.role
        where p.id = uid and (r.permissions @> array['*']::text[] or r.permissions @> array[perm])) $$;
    create or replace function public.is_admin(uid uuid) returns boolean
      language sql stable security definer set search_path = public as $$
      select public.has_permission(uid, '*') $$;
    create or replace function public.is_staff(uid uuid) returns boolean
      language sql stable security definer set search_path = public as $$
      select public.has_permission(uid, 'mentor.panel') $$;
    create or replace function public.is_investor(uid uuid) returns boolean
      language sql stable security definer set search_path = public as $$
      select public.has_permission(uid, 'investor.panel') $$;
    create or replace function public.touch_updated_at() returns trigger language plpgsql as $$
      begin new.updated_at = now(); return new; end $$;

    create table public.teams (id uuid primary key, name text not null);
    create table public.team_members (
      id uuid primary key default gen_random_uuid(),
      team_id uuid not null references public.teams(id) on delete cascade,
      user_id uuid not null references public.profiles(id) on delete cascade
    );

    -- 0011 pitch_submissions (member write still allowed after 0094).
    create table public.pitch_submissions (
      team_id uuid primary key references public.teams(id) on delete cascade,
      deck_path text, video_path text, video_url text, notes text,
      submitted_at timestamptz
    );
    alter table public.pitch_submissions enable row level security;
    create policy "pitch_submissions member write" on public.pitch_submissions
      for all using (exists (select 1 from public.team_members tm
        where tm.team_id = pitch_submissions.team_id and tm.user_id = auth.uid()))
      with check (exists (select 1 from public.team_members tm
        where tm.team_id = pitch_submissions.team_id and tm.user_id = auth.uid()));

    -- 0004 student_files and its policies.
    create table public.student_files (
      id uuid primary key default gen_random_uuid(),
      user_id uuid not null references public.profiles(id) on delete cascade,
      name text not null, path text not null
    );
    alter table public.student_files enable row level security;
    create policy "student_files own select" on public.student_files
      for select using (user_id = auth.uid() or public.is_staff(auth.uid()));
    create policy "student_files own insert" on public.student_files
      for insert with check (user_id = auth.uid());
    create policy "student_files own delete" on public.student_files
      for delete using (user_id = auth.uid());
    create policy "student_files own update" on public.student_files
      for update using (user_id = auth.uid()) with check (user_id = auth.uid());

    -- 0011 team_drive_files and its policies.
    create table public.team_drive_files (
      id uuid primary key default gen_random_uuid(),
      team_id uuid not null references public.teams(id) on delete cascade,
      name text not null, path text not null
    );
    alter table public.team_drive_files enable row level security;
    create policy "team_drive_files read" on public.team_drive_files
      for select using (public.is_staff(auth.uid()) or public.is_investor(auth.uid())
        or exists (select 1 from public.team_members tm
          where tm.team_id = team_drive_files.team_id and tm.user_id = auth.uid()));
    create policy "team_drive_files member write" on public.team_drive_files
      for all using (exists (select 1 from public.team_members tm
        where tm.team_id = team_drive_files.team_id and tm.user_id = auth.uid()))
      with check (exists (select 1 from public.team_members tm
        where tm.team_id = team_drive_files.team_id and tm.user_id = auth.uid()));

    -- storage.objects with the 0004 / 0011 policies.
    create table storage.objects (
      id uuid primary key default gen_random_uuid(),
      bucket_id text not null,
      name text not null
    );
    alter table storage.objects enable row level security;
    grant all on storage.objects to anon, authenticated;
    create policy "student-files own write" on storage.objects
      for all to authenticated
      using (bucket_id = 'student-files' and (split_part(name, '/', 1) = auth.uid()::text or public.is_staff(auth.uid())))
      with check (bucket_id = 'student-files' and (split_part(name, '/', 1) = auth.uid()::text or public.is_staff(auth.uid())));
    create policy "team-drive read" on storage.objects
      for select using (bucket_id = 'team-drive' and exists (select 1 from public.team_members tm
        where tm.user_id = auth.uid() and tm.team_id::text = split_part(storage.objects.name, '/', 1)));
    create policy "team-drive write" on storage.objects
      for all using (bucket_id = 'team-drive' and exists (select 1 from public.team_members tm
        where tm.user_id = auth.uid() and tm.team_id::text = split_part(storage.objects.name, '/', 1)))
      with check (bucket_id = 'team-drive' and exists (select 1 from public.team_members tm
        where tm.user_id = auth.uid() and tm.team_id::text = split_part(storage.objects.name, '/', 1)));

    create table public.lessons (id uuid primary key default gen_random_uuid(), description text);
    create table public.notifications (
      id uuid primary key default gen_random_uuid(), user_id uuid, link text
    );

    insert into public.profiles (id, role) values
      ('${MEMBER}', 'student'), ('${OUTSIDER}', 'student'), ('${MENTOR}', 'mentor'),
      ('${MANAGER}', 'team-manager'), ('${INVESTOR}', 'investor'), ('${ADMIN}', 'admin');
    insert into public.teams values ('${TEAM}', 'Alpha'), ('${OTHER_TEAM}', 'Beta');
    insert into public.team_members (team_id, user_id) values
      ('${TEAM}', '${MEMBER}'), ('${OTHER_TEAM}', '${OUTSIDER}');

    insert into public.pitch_submissions (team_id, video_url) values
      ('${TEAM}', 'HTTP://www.loom.com/share/abc'), ('${OTHER_TEAM}', 'not a url');
    insert into public.student_files (user_id, name, path) values ('${MEMBER}', 'a.pdf', '${MEMBER}/drive/a.pdf');
    insert into public.team_drive_files (team_id, name, path) values ('${TEAM}', 'b.pdf', '${TEAM}/drive/b.pdf');
    insert into storage.objects (bucket_id, name) values
      ('student-files', '${MEMBER}/drive/a.pdf'), ('team-drive', '${TEAM}/drive/b.pdf');

    insert into public.lessons (description) values
      ('Your team''s folder in [Files](/dashboard/files) | Same folder'),
      ('- [Team](/dashboard/team) and [Files](/dashboard/files): your people. See /dashboard/files too.'),
      ('Nothing to change here.');
    insert into public.notifications (link) values
      ('/dashboard/files'), ('/dashboard/files?x=1'), ('/dashboard/team');
  `);
  await db.exec(migration);
  return db;
}

/** Run `sql` as a signed-in user, then drop back to the owner. */
async function as<T = any>(db: PGlite, uid: string, sql: string, params: unknown[] = []) {
  await db.exec(`set role authenticated; select set_config('request.jwt.claim.sub', '${uid}', false);`);
  try {
    return await db.query<T>(sql, params);
  } finally {
    await db.exec(`reset role; select set_config('request.jwt.claim.sub', '', false);`);
  }
}

async function seedLinks(db: PGlite) {
  await db.query(
    `insert into public.team_drive_links (team_id, kind, google_id, title, is_folder_root, created_by) values
       ($1, 'folder', $2, 'Team folder', true, $3),
       ($1, 'doc', $4, 'One-pager', false, $3)`,
    [TEAM, FOLDER, MEMBER, DOC],
  );
}

test("0094 applies, and re-applies", async () => {
  const db = await setup();
  await db.exec(migration);
  await db.exec(migration);
  const { rows } = await db.query<any>(
    `select count(*)::int as n from information_schema.columns
     where table_schema = 'public' and table_name = 'pitch_submissions' and column_name = 'deck_url'`,
  );
  assert.equal(rows[0].n, 1);
});

test("team_drive_links: the team, mentors and team managers read; nobody else", async () => {
  const db = await setup();
  await seedLinks(db);
  const read = async (uid: string) =>
    (await as(db, uid, `select title from public.team_drive_links where team_id = $1 order by title`, [TEAM])).rows.map(
      (r: any) => r.title,
    );
  assert.deepEqual(await read(MEMBER), ["One-pager", "Team folder"]);
  assert.deepEqual(await read(MENTOR), ["One-pager", "Team folder"]);
  assert.deepEqual(await read(MANAGER), ["One-pager", "Team folder"]);
  assert.deepEqual(await read(ADMIN), ["One-pager", "Team folder"]);
  assert.deepEqual(await read(OUTSIDER), []);
  assert.deepEqual(await read(INVESTOR), []);

  await db.exec(`set role anon;`);
  try {
    await assert.rejects(db.query(`select * from public.team_drive_links`), /permission denied/);
  } finally {
    await db.exec(`reset role;`);
  }
});

test("team_drive_links: no signed-in writes, not even by members or admins", async () => {
  const db = await setup();
  await seedLinks(db);
  for (const uid of [MEMBER, ADMIN]) {
    await assert.rejects(
      as(db, uid, `insert into public.team_drive_links (team_id, kind, google_id, title) values ($1, 'doc', $2, 'x')`, [
        TEAM,
        "1ZZZZZZZZZZZZZZZZZZZZZZZ",
      ]),
      /permission denied/,
    );
    await assert.rejects(as(db, uid, `update public.team_drive_links set title = 'pwned'`), /permission denied/);
    await assert.rejects(as(db, uid, `delete from public.team_drive_links`), /permission denied/);
  }
});

test("team_drive_links: shape rules", async () => {
  const db = await setup();
  await seedLinks(db);
  const ins = (cols: string) => db.query(`insert into public.team_drive_links (team_id, kind, google_id, title, is_folder_root, published, gid) values ${cols}`);
  // One folder per team.
  await assert.rejects(ins(`('${TEAM}', 'folder', '${DOC}', 'Second root', true, false, null)`), /team_drive_links_one_root/);
  // The same file can't be pinned twice…
  await assert.rejects(ins(`('${TEAM}', 'doc', '${DOC}', 'Again', false, false, null)`), /team_drive_links_pin_unique/);
  // …but the root folder can also be pinned (different role), and another team can pin the same doc.
  await ins(`('${TEAM}', 'folder', '${FOLDER}', 'Pinned root', false, false, null)`);
  await ins(`('${OTHER_TEAM}', 'doc', '${DOC}', 'Theirs', false, false, null)`);
  // A root must be a folder; folders and files are never "published".
  await assert.rejects(ins(`('${OTHER_TEAM}', 'doc', '${FOLDER}', 'x', true, false, null)`), /team_drive_links_root_is_folder/);
  await assert.rejects(ins(`('${OTHER_TEAM}', 'file', '${FOLDER}', 'x', false, true, null)`), /team_drive_links_published_kinds/);
  // Ids, gids, kinds and titles are checked.
  await assert.rejects(ins(`('${OTHER_TEAM}', 'doc', 'short', 'x', false, false, null)`), /check constraint/);
  await assert.rejects(ins(`('${OTHER_TEAM}', 'doc', '${DOC}"><x', 'x', false, false, null)`), /check constraint/);
  await assert.rejects(ins(`('${OTHER_TEAM}', 'sheet', '${FOLDER}', 'x', false, false, '1;2')`), /check constraint/);
  await assert.rejects(ins(`('${OTHER_TEAM}', 'document', '${FOLDER}', 'x', false, false, null)`), /check constraint/);
  await assert.rejects(ins(`('${OTHER_TEAM}', 'doc', '${FOLDER}', '   ', false, false, null)`), /check constraint/);
  await assert.rejects(ins(`('${OTHER_TEAM}', 'doc', '${FOLDER}', '${"x".repeat(121)}', false, false, null)`), /check constraint/);
});

test("team_drive_links go with their team", async () => {
  const db = await setup();
  await seedLinks(db);
  await db.query(`delete from public.teams where id = $1`, [TEAM]);
  const { rows } = await db.query<any>(`select count(*)::int as n from public.team_drive_links`);
  assert.equal(rows[0].n, 0);
});

test("pitch links: https only; old http video links upgraded", async () => {
  const db = await setup();
  const { rows } = await db.query<any>(`select team_id, video_url from public.pitch_submissions order by team_id`);
  assert.equal(rows[0].video_url, "https://www.loom.com/share/abc");
  // NOT VALID: a junk row from before the migration is left as it was.
  assert.equal(rows[1].video_url, "not a url");

  await as(db, MEMBER, `update public.pitch_submissions set deck_url = 'https://docs.google.com/presentation/d/x/edit' where team_id = $1`, [TEAM]);
  for (const bad of ["javascript:alert(1)", "http://example.com/deck", "https://exa mple.com", `https://x.com/${"a".repeat(2050)}`]) {
    await assert.rejects(
      as(db, MEMBER, `update public.pitch_submissions set deck_url = $2 where team_id = $1`, [TEAM, bad]),
      /pitch_submissions_deck_url_https/,
      bad,
    );
    await assert.rejects(
      as(db, MEMBER, `update public.pitch_submissions set video_url = $2 where team_id = $1`, [TEAM, bad]),
      /pitch_submissions_video_url_https/,
      bad,
    );
  }
});

test("legacy uploads: readable, frozen for writes", async () => {
  const db = await setup();
  // Rows: still readable by their owners; owners can still delete their own.
  assert.equal((await as(db, MEMBER, `select id from public.student_files`)).rows.length, 1);
  assert.equal((await as(db, MEMBER, `select id from public.team_drive_files`)).rows.length, 1);
  assert.equal((await as(db, OUTSIDER, `select id from public.team_drive_files`)).rows.length, 0);
  // No new rows, no edits — the old confused-deputy path (a row pointing at
  // someone else's object) is closed.
  await assert.rejects(
    as(db, MEMBER, `insert into public.student_files (user_id, name, path) values ($1, 'x', $2)`, [MEMBER, `${OUTSIDER}/drive/x`]),
    /row-level security/,
  );
  const renamed = await as(db, MEMBER, `update public.student_files set path = 'elsewhere' returning id`);
  assert.equal(renamed.rows.length, 0);
  await assert.rejects(
    as(db, MEMBER, `insert into public.team_drive_files (team_id, name, path) values ($1, 'x', $2)`, [TEAM, `${OTHER_TEAM}/drive/x`]),
    /row-level security/,
  );
  assert.equal((await as(db, MEMBER, `delete from public.team_drive_files returning id`)).rows.length, 0);
  assert.equal((await as(db, MEMBER, `delete from public.student_files returning id`)).rows.length, 1);

  // Buckets: reads keep working, writes are gone.
  assert.equal((await as(db, MEMBER, `select name from storage.objects where bucket_id = 'student-files'`)).rows.length, 1);
  assert.equal((await as(db, MENTOR, `select name from storage.objects where bucket_id = 'student-files'`)).rows.length, 1);
  assert.equal((await as(db, OUTSIDER, `select name from storage.objects where bucket_id = 'student-files'`)).rows.length, 0);
  assert.equal((await as(db, MEMBER, `select name from storage.objects where bucket_id = 'team-drive'`)).rows.length, 1);
  for (const [bucket, path] of [
    ["student-files", `${MEMBER}/drive/new.pdf`],
    ["team-drive", `${TEAM}/drive/new.pdf`],
  ]) {
    await assert.rejects(
      as(db, MEMBER, `insert into storage.objects (bucket_id, name) values ($1, $2)`, [bucket, path]),
      /row-level security/,
      bucket,
    );
  }
  assert.equal((await as(db, MEMBER, `delete from storage.objects returning id`)).rows.length, 0);
});

test("lesson text and notifications leave /dashboard/files", async () => {
  const db = await setup();
  await db.exec(migration);
  const { rows } = await db.query<any>(`select description from public.lessons order by description`);
  assert.deepEqual(
    rows.map((r: any) => r.description),
    [
      "- [Team](/dashboard/team) and [Google Drive](/dashboard/team?tab=drive): your people. See /dashboard/team?tab=drive too.",
      "Nothing to change here.",
      "Your team's folder in [Google Drive](/dashboard/team?tab=drive) | Same folder",
    ],
  );
  const { rows: links } = await db.query<any>(`select link from public.notifications order by link`);
  assert.deepEqual(
    links.map((r: any) => r.link),
    ["/dashboard/team", "/dashboard/team?tab=drive", "/dashboard/team?tab=drive"],
  );
});
