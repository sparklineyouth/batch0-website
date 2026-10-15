import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { canReadChannel, type ChannelScope, type ChatViewer } from "./chat-access.ts";
import { MIGRATION_PROBES } from "./pending-migrations.ts";

/**
 * Migration 0101 (batch0 Chat, Discord removed), executed against a throwaway
 * Postgres. The read rule is asserted as a signed-in user through the real
 * policies, and then compared person by person, channel by channel, with
 * canReadChannel() in lib/chat-access.ts — the two must never disagree.
 *
 * The fixture recreates just enough of the schema 0101 touches: 0048's
 * app_roles + is_admin/has_permission (copied verbatim), profiles with the
 * Discord columns 0008/0033 added, cohorts/teams/enrollments/applications,
 * the 0089 DM tables and the 0011 team thread to carry over, a few of the
 * Discord tables to drop, and the realtime publication.
 */

const migration = await readFile(new URL("../supabase/migrations/0101_chat.sql", import.meta.url), "utf8");

const ADMIN = "a0000000-0000-4000-8000-000000000001";
const STAFF = "a0000000-0000-4000-8000-000000000002";
const MENTOR = "a0000000-0000-4000-8000-000000000003";
const ENROLLED = "a0000000-0000-4000-8000-000000000004";
const ACCEPTED = "a0000000-0000-4000-8000-000000000005";
const FRESH = "a0000000-0000-4000-8000-000000000006";
const OTHER = "a0000000-0000-4000-8000-000000000007";
const PEOPLE = { ADMIN, STAFF, MENTOR, ENROLLED, ACCEPTED, FRESH, OTHER };

const COHORT_A = "c0000000-0000-4000-8000-00000000000a";
const COHORT_B = "c0000000-0000-4000-8000-00000000000b";
const COHORT_X = "c0000000-0000-4000-8000-00000000000c";
const TEAM_A = "d0000000-0000-4000-8000-00000000000a";
const TEAM_B = "d0000000-0000-4000-8000-00000000000b";

const DM_OLD = "e0000000-0000-4000-8000-000000000001";
const DM_GONE = "e0000000-0000-4000-8000-000000000002";
const DM_MSG_1 = "f0000000-0000-4000-8000-000000000001";
const DM_MSG_2 = "f0000000-0000-4000-8000-000000000002";
const DM_MSG_UNSENT = "f0000000-0000-4000-8000-000000000003";
const TEAM_MSG = "f0000000-0000-4000-8000-000000000004";

type Opts = { optional?: boolean };

async function setup({ optional = true }: Opts = {}) {
  const db = new PGlite();
  await db.exec(`
    create schema if not exists auth;
    do $$ begin
      if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon; end if;
      if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated; end if;
    end $$;
    grant usage on schema public to anon, authenticated;
    grant usage on schema auth to anon, authenticated;
    alter default privileges in schema public grant all on tables to anon, authenticated;
    create or replace function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;

    create or replace function public.touch_updated_at() returns trigger language plpgsql as $$
    begin new.updated_at = now(); return new; end; $$;

    create table public.app_roles (slug text primary key, permissions text[] not null default '{}');
    insert into public.app_roles (slug, permissions) values
      ('admin', array['*']),
      ('student', array['student.dashboard']),
      ('mentor', array['mentor.panel']),
      ('community', array['discord.manage', 'announcements.manage']);

    create table public.profiles (
      id uuid primary key, email text, full_name text, role text not null default 'student',
      stripe_customer_id text,
      discord_user_id text, discord_username text, discord_avatar text, discord_linked_at timestamptz,
      discord_introduced_at timestamptz, discord_first_rsvp_at timestamptz, discord_onboarded_nudged_at timestamptz);
    create unique index profiles_discord_user_id_unique on public.profiles (discord_user_id) where discord_user_id is not null;

    create or replace function public.is_admin(uid uuid) returns boolean language sql stable
    security definer set search_path = public as $$
      select exists (select 1 from public.profiles p join public.app_roles r on r.slug = p.role
                     where p.id = uid and r.permissions @> array['*']::text[]); $$;
    create or replace function public.has_permission(uid uuid, perm text) returns boolean language sql stable
    security definer set search_path = public as $$
      select exists (select 1 from public.profiles p join public.app_roles r on r.slug = p.role
                     where p.id = uid and (r.permissions @> array['*']::text[] or r.permissions @> array[perm])); $$;

    create table public.cohorts (id uuid primary key default gen_random_uuid(), name text not null,
      status text not null default 'upcoming');
    create table public.teams (id uuid primary key default gen_random_uuid(), cohort_id uuid references public.cohorts(id),
      slug text not null, name text not null,
      discord_text_channel_id text, discord_voice_channel_id text);
    create table public.team_members (id uuid primary key default gen_random_uuid(),
      team_id uuid references public.teams(id) on delete cascade, user_id uuid references public.profiles(id));
    create table public.enrollments (id uuid primary key default gen_random_uuid(),
      user_id uuid references public.profiles(id), cohort_id uuid references public.cohorts(id));
    create table public.applications (id uuid primary key default gen_random_uuid(),
      user_id uuid references public.profiles(id), status text not null);
    create table public.site_settings (key text primary key, value jsonb);

    create table public.discord_auto_config (id int primary key);
    create table public.discord_auto_jobs (id int primary key);
    create table public.discord_auto_cursors (id int primary key);
    create function public.discord_auto_state() returns jsonb language sql as $$ select '{}'::jsonb $$;
    create table public.oh_queue (id int primary key);
    create table public.mentor_oncall (id int primary key);
    create table public.team_blockers (id int primary key);
    create table public.event_rsvps (id int primary key);
  `);

  await db.exec(`
    insert into public.profiles (id, email, full_name, role, discord_user_id) values
      ('${ADMIN}', 'admin@x', 'Admin', 'admin', '111'),
      ('${STAFF}', 'staff@x', 'Staff', 'community', null),
      ('${MENTOR}', 'mentor@x', 'Mentor', 'mentor', null),
      ('${ENROLLED}', 'e@x', 'Enrolled', 'student', '222'),
      ('${ACCEPTED}', 'a@x', 'Accepted', 'student', null),
      ('${FRESH}', 'f@x', 'Fresh', 'student', null),
      ('${OTHER}', 'o@x', 'Other', 'student', null);
    insert into public.cohorts (id, name, status) values
      ('${COHORT_A}', 'Fall 2026', 'active'),
      ('${COHORT_B}', 'Winter 2027!', 'upcoming'),
      ('${COHORT_X}', 'Cancelled one', 'cancelled');
    insert into public.teams (id, cohort_id, slug, name, discord_text_channel_id) values
      ('${TEAM_A}', '${COHORT_A}', 'acme', 'Acme', '999'),
      ('${TEAM_B}', '${COHORT_B}', 'globex', 'Globex', null);
    insert into public.team_members (team_id, user_id) values ('${TEAM_A}', '${ENROLLED}'), ('${TEAM_B}', '${OTHER}');
    insert into public.enrollments (user_id, cohort_id) values ('${ENROLLED}', '${COHORT_A}'), ('${OTHER}', '${COHORT_B}');
    insert into public.applications (user_id, status) values ('${ACCEPTED}', 'accepted'), ('${FRESH}', 'draft');
    insert into public.site_settings (key, value) values
      ('discord_url', '"https://discord.gg/x"'), ('discord_enabled', 'true'), ('referrals_enabled', 'true');
  `);

  if (!optional) return db;

  await db.exec(`
    create table public.notifications (id uuid primary key default gen_random_uuid(), user_id uuid,
      type text not null, title text, body text, link text);
    create table public.lessons (id uuid primary key default gen_random_uuid(), title text, description text);
    create table public.email_templates (key text primary key, body_html text not null);
    create schema storage;
    create table storage.buckets (id text primary key, name text, public boolean, file_size_limit bigint);
    create publication supabase_realtime;

    create table public.dm_conversations (id uuid primary key, user_a uuid, user_b uuid,
      a_last_read_at timestamptz not null default 'epoch', b_last_read_at timestamptz not null default 'epoch',
      a_seen_at timestamptz, b_seen_at timestamptz, created_at timestamptz not null default now());
    create table public.dm_messages (id uuid primary key, conversation_id uuid, sender_id uuid, body text not null,
      created_at timestamptz not null default now(), unsent_at timestamptz);
    create table public.dm_blocks (blocker_id uuid, blocked_id uuid, created_at timestamptz not null default now(),
      primary key (blocker_id, blocked_id));
    create table public.dm_reports (id uuid primary key default gen_random_uuid(), conversation_id uuid,
      reporter_id uuid, reason text not null, status text not null default 'open', reviewed_by uuid,
      reviewed_at timestamptz, created_at timestamptz not null default now());
    create table public.team_messages (id uuid primary key, team_id uuid, author_id uuid, body text not null,
      created_at timestamptz not null default now());

    insert into public.dm_conversations (id, user_a, user_b, a_last_read_at) values
      ('${DM_OLD}', '${ENROLLED}', '${MENTOR}', '2026-10-01T00:00:01Z'),
      ('${DM_GONE}', '${ACCEPTED}', null, 'epoch');
    insert into public.dm_messages (id, conversation_id, sender_id, body, created_at, unsent_at) values
      ('${DM_MSG_1}', '${DM_OLD}', '${MENTOR}', 'hey there', '2026-10-01T00:00:00Z', null),
      ('${DM_MSG_2}', '${DM_OLD}', '${ENROLLED}', 'hi!', '2026-10-01T00:00:02Z', null),
      ('${DM_MSG_UNSENT}', '${DM_OLD}', '${MENTOR}', 'regret this', '2026-10-01T00:00:03Z', '2026-10-01T00:01:00Z');
    insert into public.dm_blocks (blocker_id, blocked_id) values ('${ENROLLED}', '${OTHER}');
    insert into public.dm_reports (conversation_id, reporter_id, reason, status) values
      ('${DM_GONE}', '${ACCEPTED}', 'spam', 'actioned');
    insert into public.team_messages (id, team_id, author_id, body) values
      ('${TEAM_MSG}', '${TEAM_A}', '${ENROLLED}', 'team thread lives on');
    insert into public.lessons (title, description) values
      ('Field guide', 'Paste it into your cohort channel on [Discord](/dashboard/community) and ask. Use the cohort on Discord as your debrief partner; then [Discord](/dashboard/community).'),
      ('Untouched', 'Post in three FTC Discord servers.');
    insert into public.email_templates (key, body_html) values
      ('cohort.next_steps', '<p>Reply to this email, or put it in your cohort''s Discord — someone else is stuck.</p>');
  `);
  return db;
}

async function asUser<T = any>(db: PGlite, uid: string, sql: string, params?: unknown[]) {
  await db.exec(`set role authenticated; select set_config('request.jwt.claim.sub', '${uid}', false);`);
  try {
    return await db.query<T>(sql, params);
  } finally {
    await db.exec(`reset role; select set_config('request.jwt.claim.sub', '', false);`);
  }
}

async function channelId(db: PGlite, systemKey: string): Promise<string> {
  const { rows } = await db.query<{ id: string }>(`select id from public.chat_channels where system_key = $1`, [systemKey]);
  assert.equal(rows.length, 1, `channel ${systemKey}`);
  return rows[0].id;
}

test("0101 applies twice and seeds the starting channels once", async () => {
  const db = await setup();
  await db.exec(migration);
  await db.exec(migration);
  const { rows } = await db.query<{ system_key: string; name: string; audience: string; posting: string }>(
    `select system_key, name, audience, posting from public.chat_channels where system_key is not null order by position, name`,
  );
  assert.deepEqual(rows, [
    { system_key: "announcements", name: "announcements", audience: "everyone", posting: "staff" },
    { system_key: "general", name: "general", audience: "everyone", posting: "everyone" },
    { system_key: "wins", name: "wins", audience: "everyone", posting: "everyone" },
    { system_key: "help", name: "help", audience: "everyone", posting: "everyone" },
    { system_key: "staff", name: "staff", audience: "staff", posting: "everyone" },
    { system_key: `cohort:${COHORT_A}`, name: "fall-2026", audience: "cohort", posting: "everyone" },
    { system_key: `cohort:${COHORT_B}`, name: "winter-2027", audience: "cohort", posting: "everyone" },
    { system_key: `team:${TEAM_A}`, name: "team-acme", audience: "team", posting: "everyone" },
    { system_key: `team:${TEAM_B}`, name: "team-globex", audience: "team", posting: "everyone" },
  ]);
});

test("new cohorts and teams get their channel from a trigger", async () => {
  const db = await setup();
  await db.exec(migration);
  await db.exec(`insert into public.cohorts (id, name, status) values ('c0000000-0000-4000-8000-0000000000dd', 'Spring 2027', 'upcoming')`);
  await db.exec(`insert into public.teams (id, cohort_id, slug, name) values ('d0000000-0000-4000-8000-0000000000dd', '${COHORT_A}', 'initech', 'Initech')`);
  assert.ok(await channelId(db, "cohort:c0000000-0000-4000-8000-0000000000dd"));
  assert.ok(await channelId(db, "team:d0000000-0000-4000-8000-0000000000dd"));
  // A cancelled cohort coming back to life gets one too.
  await db.exec(`update public.cohorts set status = 'upcoming' where id = '${COHORT_X}'`);
  assert.ok(await channelId(db, `cohort:${COHORT_X}`));
});

test("who reads what: the policies and canReadChannel() agree for every person and channel", async () => {
  const db = await setup();
  await db.exec(migration);
  // A private channel with one explicit member, an unreported group, and a
  // mentor added to a cohort channel on top of its audience.
  const cohortA = await channelId(db, `cohort:${COHORT_A}`);
  await db.exec(`
    insert into public.chat_channels (id, kind, name, audience) values
      ('b0000000-0000-4000-8000-000000000001', 'channel', 'mentors', 'members');
    insert into public.chat_members (channel_id, user_id) values
      ('b0000000-0000-4000-8000-000000000001', '${MENTOR}'),
      ('${cohortA}', '${MENTOR}');
    insert into public.chat_channels (id, kind, audience) values
      ('b0000000-0000-4000-8000-000000000002', 'group', 'members');
    insert into public.chat_members (channel_id, user_id) values
      ('b0000000-0000-4000-8000-000000000002', '${ENROLLED}'),
      ('b0000000-0000-4000-8000-000000000002', '${OTHER}');
  `);

  const channels = (
    await db.query<any>(`select id, kind, audience, cohort_id, team_id, posting, archived_at, slowmode_seconds from public.chat_channels`)
  ).rows.map(
    (r): ChannelScope => ({
      id: r.id, kind: r.kind, audience: r.audience, cohortId: r.cohort_id, teamId: r.team_id,
      posting: r.posting, archivedAt: r.archived_at, slowmodeSeconds: r.slowmode_seconds,
    }),
  );
  const reported = new Set((await db.query<any>(`select channel_id from public.chat_reports`)).rows.map((r) => r.channel_id));
  const members = (await db.query<any>(`select channel_id, user_id from public.chat_members`)).rows;

  const viewers: Record<string, ChatViewer> = {
    ADMIN: { userId: ADMIN, staff: true, vetted: true, cohortIds: [], teamIds: [], memberOf: [] },
    STAFF: { userId: STAFF, staff: true, vetted: true, cohortIds: [], teamIds: [], memberOf: [] },
    MENTOR: { userId: MENTOR, staff: false, vetted: true, cohortIds: [], teamIds: [], memberOf: [] },
    ENROLLED: { userId: ENROLLED, staff: false, vetted: true, cohortIds: [COHORT_A], teamIds: [TEAM_A], memberOf: [] },
    ACCEPTED: { userId: ACCEPTED, staff: false, vetted: true, cohortIds: [], teamIds: [], memberOf: [] },
    FRESH: { userId: FRESH, staff: false, vetted: false, cohortIds: [], teamIds: [], memberOf: [] },
    OTHER: { userId: OTHER, staff: false, vetted: true, cohortIds: [COHORT_B], teamIds: [TEAM_B], memberOf: [] },
  };

  for (const [who, uid] of Object.entries(PEOPLE)) {
    const v = { ...viewers[who], memberOf: members.filter((m) => m.user_id === uid).map((m) => m.channel_id) };
    const expected = channels.filter((c) => canReadChannel(c, v, reported.has(c.id))).map((c) => c.id).sort();
    const actual = (await asUser<{ id: string }>(db, uid, `select id from public.chat_channels`)).rows.map((r) => r.id).sort();
    assert.deepEqual(actual, expected, `${who} reads a different set in SQL than in TypeScript`);
  }

  // Spot checks of the rule itself, so the matrix can't agree on nonsense.
  const sees = async (uid: string, key: string) =>
    (await asUser(db, uid, `select 1 from public.chat_channels where system_key = '${key}'`)).rows.length === 1;
  assert.equal(await sees(FRESH, "general"), false, "an unvetted signup sees no community channel");
  assert.equal(await sees(ACCEPTED, "general"), true);
  assert.equal(await sees(MENTOR, "general"), true);
  assert.equal(await sees(ENROLLED, `cohort:${COHORT_A}`), true);
  assert.equal(await sees(OTHER, `cohort:${COHORT_A}`), false);
  assert.equal(await sees(MENTOR, `cohort:${COHORT_A}`), true, "explicit member on an audience channel");
  assert.equal(await sees(ENROLLED, `team:${TEAM_B}`), false);
  assert.equal(await sees(STAFF, "staff"), true, "discord.manage became chat.manage");
  assert.equal(await sees(MENTOR, "staff"), false);
  const group = (uid: string) => asUser(db, uid, `select 1 from public.chat_channels where id = 'b0000000-0000-4000-8000-000000000002'`);
  assert.equal((await group(ADMIN)).rows.length, 0, "no staff read path into an unreported group");
  assert.equal((await group(ENROLLED)).rows.length, 1);
  // The carried-over DM report opens that DM to staff.
  assert.equal((await asUser(db, STAFF, `select 1 from public.chat_channels where id = '${DM_GONE}'`)).rows.length, 1);
  assert.equal((await asUser(db, STAFF, `select 1 from public.chat_channels where id = '${DM_OLD}'`)).rows.length, 0);
});

test("messages, members and reactions are readable exactly where the channel is", async () => {
  const db = await setup();
  await db.exec(migration);
  const team = await channelId(db, `team:${TEAM_A}`);
  await db.exec(`insert into public.chat_reactions (message_id, user_id, emoji) values ('${TEAM_MSG}', '${ENROLLED}', '🔥')`);
  for (const [uid, n] of [[ENROLLED, 1], [OTHER, 0], [ADMIN, 1]] as const) {
    const m = await asUser(db, uid, `select id from public.chat_messages where channel_id = '${team}'`);
    assert.equal(m.rows.length, n);
    const r = await asUser(db, uid, `select 1 from public.chat_reactions where message_id = '${TEAM_MSG}'`);
    assert.equal(r.rows.length, n);
  }
  const dmMembers = await asUser(db, MENTOR, `select user_id from public.chat_members where channel_id = '${DM_OLD}' order by user_id`);
  assert.deepEqual(dmMembers.rows.map((r: any) => r.user_id), [MENTOR, ENROLLED].sort());
  assert.equal((await asUser(db, OTHER, `select 1 from public.chat_members where channel_id = '${DM_OLD}'`)).rows.length, 0);
  // Revisions have no read policy at all.
  assert.equal((await asUser(db, ADMIN, `select 1 from public.chat_message_revisions`)).rows.length, 0);
});

test("there is no browser write path", async () => {
  const db = await setup();
  await db.exec(migration);
  const general = await channelId(db, "general");
  await assert.rejects(
    asUser(db, ENROLLED, `insert into public.chat_messages (channel_id, sender_id, body) values ('${general}', '${ENROLLED}', 'hi')`),
    /row-level security/,
  );
  await assert.rejects(
    asUser(db, ENROLLED, `insert into public.chat_reactions (message_id, user_id, emoji) values ('${TEAM_MSG}', '${ENROLLED}', '👍')`),
    /row-level security/,
  );
  await assert.rejects(
    asUser(db, ENROLLED, `insert into public.chat_members (channel_id, user_id) values ('${general}', '${ENROLLED}')`),
    /row-level security/,
  );
  // Updates and deletes match nothing.
  await asUser(db, MENTOR, `update public.chat_messages set body = 'rewritten' where id = '${DM_MSG_1}'`);
  await asUser(db, MENTOR, `delete from public.chat_messages where id = '${DM_MSG_1}'`);
  const still = await db.query<{ body: string }>(`select body from public.chat_messages where id = '${DM_MSG_1}'`);
  assert.deepEqual(still.rows, [{ body: "hey there" }]);
  const policies = await db.query<{ n: number }>(
    `select count(*)::int as n from pg_policies where schemaname = 'public' and tablename like 'chat_%' and cmd <> 'SELECT'`,
  );
  assert.equal(policies.rows[0].n, 0);
});

test("the helper functions can't be called over /rpc", async () => {
  const db = await setup();
  await db.exec(migration);
  await assert.rejects(asUser(db, ENROLLED, `select public.chat_unread('${ADMIN}', array[]::uuid[])`), /permission denied/);
  await assert.rejects(asUser(db, ENROLLED, `select public.chat_is_staff('${ADMIN}')`), /permission denied/);
  await assert.rejects(asUser(db, ENROLLED, `select public.chat_is_vetted('${FRESH}')`), /permission denied/);
});

test("the channel summary follows sends, edits and deletes; revisions keep the words", async () => {
  const db = await setup();
  await db.exec(migration);
  const general = await channelId(db, "general");
  await db.exec(`
    insert into public.chat_messages (id, channel_id, sender_id, body, created_at) values
      ('90000000-0000-4000-8000-000000000001', '${general}', '${ENROLLED}', 'first', '2026-10-15T10:00:00Z'),
      ('90000000-0000-4000-8000-000000000002', '${general}', '${OTHER}', 'second', '2026-10-15T10:01:00Z');
  `);
  const summary = async () =>
    (await db.query<any>(`select message_count, last_message_preview, last_sender_id from public.chat_channels where id = '${general}'`)).rows[0];
  assert.deepEqual(await summary(), { message_count: 2, last_message_preview: "second", last_sender_id: OTHER });

  await db.exec(`update public.chat_messages set body = 'second, edited', edited_at = now() where id = '90000000-0000-4000-8000-000000000002'`);
  assert.equal((await summary()).last_message_preview, "second, edited");

  await db.exec(`update public.chat_messages set body = '', attachments = '[]', deleted_at = now() where id = '90000000-0000-4000-8000-000000000002'`);
  assert.deepEqual(await summary(), { message_count: 1, last_message_preview: "first", last_sender_id: ENROLLED });

  const revisions = await db.query<{ body: string; reason: string }>(
    `select body, reason from public.chat_message_revisions where message_id = '90000000-0000-4000-8000-000000000002' order by created_at, reason desc`,
  );
  assert.deepEqual(revisions.rows, [
    { body: "second", reason: "edit" },
    { body: "second, edited", reason: "delete" },
  ]);

  // A deleted message must be blank; an empty live one is refused.
  await assert.rejects(db.exec(`update public.chat_messages set deleted_at = now() where id = '90000000-0000-4000-8000-000000000001'`), /chat_messages_deleted_blank/);
  await assert.rejects(db.exec(`insert into public.chat_messages (channel_id, body) values ('${general}', '')`), /chat_messages_content/);
});

test("reactions fold onto the message and come off again", async () => {
  const db = await setup();
  await db.exec(migration);
  await db.exec(`
    insert into public.chat_reactions (message_id, user_id, emoji, created_at) values
      ('${TEAM_MSG}', '${ENROLLED}', '🔥', '2026-10-15T10:00:00Z'),
      ('${TEAM_MSG}', '${ADMIN}', '🔥', '2026-10-15T10:00:01Z'),
      ('${TEAM_MSG}', '${ADMIN}', '👍', '2026-10-15T10:00:02Z');
  `);
  const reactions = async () =>
    (await db.query<{ reactions: Record<string, string[]> }>(`select reactions from public.chat_messages where id = '${TEAM_MSG}'`)).rows[0].reactions;
  assert.deepEqual(await reactions(), { "🔥": [ENROLLED, ADMIN], "👍": [ADMIN] });
  await db.exec(`delete from public.chat_reactions where message_id = '${TEAM_MSG}' and emoji = '🔥' and user_id = '${ENROLLED}'`);
  assert.deepEqual(await reactions(), { "🔥": [ADMIN], "👍": [ADMIN] });
  await db.exec(`delete from public.chat_reactions where message_id = '${TEAM_MSG}'`);
  assert.deepEqual(await reactions(), {});
});

test("old DMs, blocks, reports and the team thread carry over once", async () => {
  const db = await setup();
  await db.exec(migration);
  await db.exec(migration);

  const dm = (await db.query<any>(`select kind, audience, dm_key, message_count, last_message_preview from public.chat_channels where id = '${DM_OLD}'`)).rows[0];
  assert.deepEqual(dm, {
    kind: "dm", audience: "members", dm_key: [ENROLLED, MENTOR].sort().join(":"),
    message_count: 2, last_message_preview: "hi!",
  });
  const gone = (await db.query<any>(`select dm_key from public.chat_channels where id = '${DM_GONE}'`)).rows[0];
  assert.equal(gone.dm_key, `legacy:${DM_GONE}`);
  assert.deepEqual(
    (await db.query<any>(`select user_id from public.chat_members where channel_id = '${DM_GONE}'`)).rows,
    [{ user_id: ACCEPTED }],
  );

  const messages = (await db.query<any>(`select id, body, deleted_at is not null as deleted from public.chat_messages where channel_id = '${DM_OLD}' order by created_at`)).rows;
  assert.deepEqual(messages, [
    { id: DM_MSG_1, body: "hey there", deleted: false },
    { id: DM_MSG_2, body: "hi!", deleted: false },
    { id: DM_MSG_UNSENT, body: "", deleted: true },
  ]);
  const kept = (await db.query<any>(`select body, reason from public.chat_message_revisions where message_id = '${DM_MSG_UNSENT}'`)).rows;
  assert.deepEqual(kept, [{ body: "regret this", reason: "delete" }]);

  const read = (await db.query<any>(`select last_read_at from public.chat_reads where channel_id = '${DM_OLD}' and user_id = '${ENROLLED}'`)).rows[0];
  assert.equal(new Date(read.last_read_at).toISOString(), "2026-10-01T00:00:01.000Z");

  assert.deepEqual((await db.query<any>(`select blocker_id, blocked_id from public.chat_blocks`)).rows, [{ blocker_id: ENROLLED, blocked_id: OTHER }]);
  assert.deepEqual((await db.query<any>(`select channel_id, status from public.chat_reports`)).rows, [{ channel_id: DM_GONE, status: "actioned" }]);

  const team = await channelId(db, `team:${TEAM_A}`);
  assert.deepEqual(
    (await db.query<any>(`select id, body from public.chat_messages where channel_id = '${team}'`)).rows,
    [{ id: TEAM_MSG, body: "team thread lives on" }],
  );
});

test("sidebar counts: unread since the cursor, mentions on top", async () => {
  const db = await setup();
  await db.exec(migration);
  // ENROLLED has read DM_OLD up to the mentor's first message: their own
  // reply never counts, the unsent one doesn't either.
  const counts = async (uid: string, ids: string[]) =>
    (await db.query<any>(`select channel_id, unread, mentions from public.chat_unread($1, $2::uuid[])`, [uid, ids])).rows;
  assert.deepEqual(await counts(ENROLLED, [DM_OLD]), [{ channel_id: DM_OLD, unread: 0, mentions: 0 }]);
  assert.deepEqual(await counts(MENTOR, [DM_OLD]), [{ channel_id: DM_OLD, unread: 1, mentions: 0 }]);

  const general = await channelId(db, "general");
  await db.exec(`
    insert into public.chat_messages (channel_id, sender_id, body, mentions) values
      ('${general}', '${ADMIN}', 'hello <@${ENROLLED}>', array['${ENROLLED}']::uuid[]),
      ('${general}', '${OTHER}', 'plain', '{}');
    insert into public.chat_messages (channel_id, sender_id, body, mention_everyone) values
      ('${general}', '${ADMIN}', '@everyone big news', true);
  `);
  assert.deepEqual(await counts(ENROLLED, [general]), [{ channel_id: general, unread: 3, mentions: 2 }]);
  assert.deepEqual(await counts(OTHER, [general]), [{ channel_id: general, unread: 2, mentions: 1 }]);
  await db.exec(`insert into public.chat_reads (channel_id, user_id, last_read_at) values ('${general}', '${ENROLLED}', now() + interval '1 minute')`);
  assert.deepEqual(await counts(ENROLLED, [general]), [{ channel_id: general, unread: 0, mentions: 0 }]);
});

test("Discord is gone: tables, columns, settings, and the permission", async () => {
  const db = await setup();
  await db.exec(migration);
  await db.exec(migration);
  for (const t of ["discord_auto_config", "discord_auto_jobs", "discord_auto_cursors", "oh_queue", "mentor_oncall", "team_blockers", "event_rsvps"]) {
    assert.equal((await db.query<any>(`select to_regclass('public.${t}') as t`)).rows[0].t, null, t);
  }
  const cols = await db.query<{ column_name: string }>(
    `select column_name from information_schema.columns where table_schema = 'public' and table_name in ('profiles', 'teams') and column_name like 'discord%'`,
  );
  assert.deepEqual(cols.rows, []);
  assert.deepEqual(
    (await db.query<any>(`select key from public.site_settings order by key`)).rows,
    [{ key: "referrals_enabled" }],
  );
  const roles = Object.fromEntries(
    (await db.query<any>(`select slug, permissions from public.app_roles`)).rows.map((r) => [r.slug, r.permissions]),
  );
  assert.deepEqual(roles.community, ["announcements.manage", "chat.manage"]);
  assert.deepEqual(roles.admin, ["*"]);
  // The profile guard still guards, without the dropped columns.
  await db.exec(`create trigger guard_profile_privileges before update on public.profiles for each row execute procedure public.guard_profile_privileges()`);
  await assert.rejects(asUser(db, ENROLLED, `update public.profiles set role = 'admin' where id = '${ENROLLED}'`), /cannot be changed/);
  await asUser(db, ENROLLED, `update public.profiles set full_name = 'New name' where id = '${ENROLLED}'`);
});

test("lesson and email copy point at Chat, once; generic Discord advice is left alone", async () => {
  const db = await setup();
  await db.exec(migration);
  const once = (await db.query<any>(`select title, description from public.lessons order by title`)).rows;
  await db.exec(migration);
  const twice = (await db.query<any>(`select title, description from public.lessons order by title`)).rows;
  assert.deepEqual(twice, once);
  const by = Object.fromEntries(once.map((r) => [r.title, r.description]));
  assert.equal(
    by["Field guide"],
    "Paste it into your cohort channel in [Chat](/chat) and ask. Use the cohort in Chat as your debrief partner; then [Chat](/chat).",
  );
  assert.equal(by.Untouched, "Post in three FTC Discord servers.");
  const email = (await db.query<any>(`select body_html from public.email_templates`)).rows[0].body_html;
  assert.equal(email, "<p>Reply to this email, or post it in your cohort's channel in Chat — someone else is stuck.</p>");
});

test("realtime carries chat_messages; chat bells never carry words; the bucket exists", async () => {
  const db = await setup();
  await db.exec(migration);
  await db.exec(migration);
  const pub = await db.query(`select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'chat_messages'`);
  assert.equal(pub.rows.length, 1);
  await db.exec(`insert into public.notifications (user_id, type, title, body) values
    ('${ENROLLED}', 'chat_dm', 'Mentor messaged you', 'the secret words'),
    ('${ENROLLED}', 'chat_mention', 'You were mentioned', 'more words'),
    ('${ENROLLED}', 'announcement', 'News', 'kept')`);
  assert.deepEqual(
    (await db.query<any>(`select type, body from public.notifications order by type`)).rows,
    [
      { type: "announcement", body: "kept" },
      { type: "chat_dm", body: null },
      { type: "chat_mention", body: null },
    ],
  );
  assert.deepEqual(
    (await db.query<any>(`select id, public, file_size_limit::int as limit from storage.buckets`)).rows,
    [{ id: "chat-files", public: false, limit: 10485760 }],
  );
});

test("0101 applies on a database without the optional tables", async () => {
  const db = await setup({ optional: false });
  await db.exec(migration);
  await db.exec(migration);
  assert.ok(await channelId(db, "general"));
});

test("the admin overview's 0101 probes: stale before, satisfied after", async () => {
  const db = await setup();
  const probes = MIGRATION_PROBES.filter((p) => p.migration === "0101");
  const leftover = probes.find((p) => p.leftover)!;
  const leftoverSql = `select ${leftover.columns} from public.${leftover.table} where ${leftover.leftover!.column} @> array[${leftover.leftover!.values.map((v) => `'${v}'`).join(", ")}]::text[] limit 1`;
  assert.equal((await db.query(leftoverSql)).rows.length, 1, "discord.manage is still granted before 0101");
  for (const p of probes.filter((x) => !x.leftover)) {
    await assert.rejects(db.query(`select ${p.columns} from public.${p.table} limit 0`), /does not exist/);
  }
  await db.exec(migration);
  assert.equal((await db.query(leftoverSql)).rows.length, 0);
  for (const p of probes.filter((x) => !x.leftover)) {
    await db.query(`select ${p.columns} from public.${p.table} limit 0`);
  }
});
