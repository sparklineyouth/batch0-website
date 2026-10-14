import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";

/**
 * Migration 0099, executed against a throwaway Postgres: applied twice, then
 * queried as a signed-in user so "students can no longer write here" is
 * asserted, not assumed. The fixture recreates the retired tables with their
 * real policy names (0005, 0011, 0027, 0068), the 0048 app_roles shape and the
 * 0089 realtime publication entry.
 */

const migration = await readFile(
  new URL("../supabase/migrations/0099_retire_community.sql", import.meta.url),
  "utf8",
);

const USER = "11111111-1111-4111-8111-111111111111";
const ROW = "22222222-2222-4222-8222-222222222222";

const RETIRED = [
  "discussion_threads",
  "discussion_replies",
  "team_messages",
  "announcement_reactions",
  "lesson_comments",
] as const;

const READ_POLICIES = [
  ["discussion_threads", "discussion_threads read"],
  ["discussion_replies", "discussion_replies read"],
  ["team_messages", "team_messages read"],
  ["announcement_reactions", "announcement_reactions read"],
  ["lesson_comments", "lesson_comments read enrolled"],
] as const;

const WRITE_POLICIES = [
  ["discussion_threads", "discussion_threads insert"],
  ["discussion_threads", "discussion_threads update"],
  ["discussion_threads", "discussion_threads delete"],
  ["discussion_replies", "discussion_replies insert"],
  ["discussion_replies", "discussion_replies delete"],
  ["team_messages", "team_messages write"],
  ["announcement_reactions", "announcement_reactions self insert"],
  ["announcement_reactions", "announcement_reactions self delete"],
  ["lesson_comments", "lesson_comments self insert"],
  ["lesson_comments", "lesson_comments self update"],
  ["lesson_comments", "lesson_comments self delete"],
] as const;

/** One insert per table, as the signed-in USER would have sent it. */
const INSERTS: Record<(typeof RETIRED)[number], string> = {
  discussion_threads: `insert into public.discussion_threads (author_id, body) values ('${USER}', 'q')`,
  discussion_replies: `insert into public.discussion_replies (thread_id, author_id, body) values ('${ROW}', '${USER}', 'r')`,
  team_messages: `insert into public.team_messages (team_id, author_id, body) values ('${ROW}', '${USER}', 'm')`,
  announcement_reactions: `insert into public.announcement_reactions (announcement_id, user_id, emoji) values ('${ROW}', '${USER}', 'heart')`,
  lesson_comments: `insert into public.lesson_comments (lesson_id, user_id, body) values ('${ROW}', '${USER}', 'c')`,
};

async function setup(opts: { tables?: boolean; publication?: boolean } = {}) {
  const { tables = true, publication = true } = opts;
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
    end $$;
    grant usage on schema public to anon, authenticated;
    grant usage on schema auth to anon, authenticated;
    alter default privileges in schema public
      grant all on tables to anon, authenticated;
    create or replace function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;

    create table public.app_roles (
      slug text primary key,
      permissions text[] not null default '{}'
    );
    insert into public.app_roles (slug, permissions) values
      ('admin', array['*']),
      ('community', array['announcements.manage', 'discussions.manage', 'support.view']),
      ('mentor', array['mentor.panel']);
  `);

  if (!tables) return db;

  await db.exec(`
    create table public.discussion_threads (
      id uuid primary key default gen_random_uuid(),
      author_id uuid not null, body text not null);
    create table public.discussion_replies (
      id uuid primary key default gen_random_uuid(),
      thread_id uuid not null, author_id uuid not null, body text not null);
    create table public.team_messages (
      id uuid primary key default gen_random_uuid(),
      team_id uuid not null, author_id uuid not null, body text not null);
    create table public.announcement_reactions (
      announcement_id uuid not null, user_id uuid not null, emoji text not null,
      primary key (announcement_id, user_id, emoji));
    create table public.lesson_comments (
      id uuid primary key default gen_random_uuid(),
      lesson_id uuid not null, user_id uuid not null, body text not null);
    create table public.dm_messages (
      id uuid primary key default gen_random_uuid(), body text not null);

    alter table public.discussion_threads enable row level security;
    alter table public.discussion_replies enable row level security;
    alter table public.team_messages enable row level security;
    alter table public.announcement_reactions enable row level security;
    alter table public.lesson_comments enable row level security;

    create policy "discussion_threads read" on public.discussion_threads for select using (true);
    create policy "discussion_threads insert" on public.discussion_threads for insert with check (author_id = auth.uid());
    create policy "discussion_threads update" on public.discussion_threads for update using (author_id = auth.uid());
    create policy "discussion_threads delete" on public.discussion_threads for delete using (author_id = auth.uid());
    create policy "discussion_replies read" on public.discussion_replies for select using (true);
    create policy "discussion_replies insert" on public.discussion_replies for insert with check (author_id = auth.uid());
    create policy "discussion_replies delete" on public.discussion_replies for delete using (author_id = auth.uid());
    create policy "team_messages read" on public.team_messages for select using (true);
    create policy "team_messages write" on public.team_messages for insert with check (author_id = auth.uid());
    create policy "announcement_reactions read" on public.announcement_reactions for select using (true);
    create policy "announcement_reactions self insert" on public.announcement_reactions for insert with check (user_id = auth.uid());
    create policy "announcement_reactions self delete" on public.announcement_reactions for delete using (user_id = auth.uid());
    create policy "lesson_comments read enrolled" on public.lesson_comments for select using (true);
    create policy "lesson_comments self insert" on public.lesson_comments for insert with check (user_id = auth.uid());
    create policy "lesson_comments self update" on public.lesson_comments for update using (user_id = auth.uid());
    create policy "lesson_comments self delete" on public.lesson_comments for delete using (user_id = auth.uid());
  `);

  if (publication) {
    await db.exec(`
      create publication supabase_realtime;
      alter publication supabase_realtime add table public.dm_messages;
    `);
  }
  return db;
}

/** Run `sql` as a signed-in user, then drop back to the owner. */
async function asUser(db: PGlite, sql: string) {
  await db.exec(
    `set role authenticated; select set_config('request.jwt.claim.sub', '${USER}', false);`,
  );
  try {
    return await db.query(sql);
  } finally {
    await db.exec(`reset role; select set_config('request.jwt.claim.sub', '', false);`);
  }
}

async function policies(db: PGlite) {
  const { rows } = await db.query<{ tablename: string; policyname: string }>(
    `select tablename, policyname from pg_policies where schemaname = 'public'`,
  );
  return new Set(rows.map((r) => `${r.tablename}/${r.policyname}`));
}

async function permissions(db: PGlite) {
  const { rows } = await db.query<{ slug: string; permissions: string[] }>(
    `select slug, permissions from public.app_roles order by slug`,
  );
  return Object.fromEntries(rows.map((r) => [r.slug, r.permissions]));
}

test("the fixture's write policies work before 0099 (so the next test means something)", async () => {
  const db = await setup();
  for (const table of RETIRED) await asUser(db, INSERTS[table]);
  const { rows } = await asUser(db, `select count(*)::int as n from public.team_messages`);
  assert.equal((rows[0] as any).n, 1);
});

test("0099 applies twice and drops only the client write policies", async () => {
  const db = await setup();
  await db.exec(migration);
  await db.exec(migration);

  const live = await policies(db);
  for (const [table, name] of WRITE_POLICIES) {
    assert.ok(!live.has(`${table}/${name}`), `${table}: "${name}" should be gone`);
  }
  for (const [table, name] of READ_POLICIES) {
    assert.ok(live.has(`${table}/${name}`), `${table}: "${name}" should stay`);
  }
});

test("after 0099 a signed-in user can still read but no longer write", async () => {
  const db = await setup();
  await db.exec(
    `insert into public.team_messages (team_id, author_id, body) values ('${ROW}', '${USER}', 'old')`,
  );
  await db.exec(migration);

  for (const table of RETIRED) {
    await assert.rejects(asUser(db, INSERTS[table]), /row-level security/, `${table} insert`);
  }
  const { rows } = await asUser(db, `select body from public.team_messages`);
  assert.deepEqual(rows, [{ body: "old" }]);

  // Update/delete have no policy either: they match zero rows.
  await asUser(db, `update public.team_messages set body = 'edited'`);
  await asUser(db, `delete from public.team_messages`);
  const after = await db.query(`select body from public.team_messages`);
  assert.deepEqual(after.rows, [{ body: "old" }]);
});

test("0099 removes discussions.manage and leaves every other grant alone", async () => {
  const db = await setup();
  await db.exec(migration);
  await db.exec(migration);
  assert.deepEqual(await permissions(db), {
    admin: ["*"],
    community: ["announcements.manage", "support.view"],
    mentor: ["mentor.panel"],
  });
});

test("0099 takes dm_messages out of realtime; tables are kept", async () => {
  const db = await setup();
  const published = `select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'dm_messages'`;
  assert.equal((await db.query(published)).rows.length, 1);
  await db.exec(migration);
  await db.exec(migration);
  assert.equal((await db.query(published)).rows.length, 0);
  for (const table of [...RETIRED, "dm_messages"]) {
    const r = await db.query<{ t: string | null }>(`select to_regclass('public.${table}')::text as t`);
    assert.equal(r.rows[0].t, table);
  }
});

test("0099 applies on a database without the publication or the retired tables", async () => {
  const noPublication = await setup({ publication: false });
  await noPublication.exec(migration);
  await noPublication.exec(migration);

  const bare = await setup({ tables: false });
  await bare.exec(migration);
  await bare.exec(migration);
  assert.deepEqual((await permissions(bare)).community, ["announcements.manage", "support.view"]);
});
