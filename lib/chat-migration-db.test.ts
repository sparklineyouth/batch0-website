import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import {
  canReadChannel,
  channelReportsOpenTo,
  reportPartyIds,
  type ChannelScope,
  type ChatViewer,
} from "./chat-access.ts";
import { MIGRATION_PROBES } from "./pending-migrations.ts";
import { ACCEPTED_STATUSES } from "./pre-cohort.ts";

/**
 * Migration 0101 (batch0 Chat, Discord removed), executed against a throwaway
 * Postgres. The read rule is asserted as a signed-in user through the real
 * policies, and then compared person by person, channel by channel, with
 * canReadChannel() in lib/chat-access.ts — the two must never disagree.
 *
 * The fixture recreates just enough of the schema 0101 touches: 0048's
 * app_roles + is_admin/has_permission (copied verbatim), profiles with the
 * Discord columns 0008/0033 added, cohorts/teams/enrollments/applications,
 * the 0089 DM tables (with their read policies) and the 0011 team thread to
 * carry over, a few of the Discord tables to drop, notifications with 0005's
 * read policy, 0049's kickoff checklists, the realtime publication, and a
 * stand-in for Supabase's realtime.messages.
 */

const migration = await readFile(new URL("../supabase/migrations/0101_chat.sql", import.meta.url), "utf8");

const ADMIN = "a0000000-0000-4000-8000-000000000001";
const STAFF = "a0000000-0000-4000-8000-000000000002";
const MENTOR = "a0000000-0000-4000-8000-000000000003";
const ENROLLED = "a0000000-0000-4000-8000-000000000004";
const ACCEPTED = "a0000000-0000-4000-8000-000000000005";
const FRESH = "a0000000-0000-4000-8000-000000000006";
const OTHER = "a0000000-0000-4000-8000-000000000007";
const PAID = "a0000000-0000-4000-8000-000000000008";
const PEOPLE = { ADMIN, STAFF, MENTOR, ENROLLED, ACCEPTED, FRESH, OTHER, PAID };

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

const GROUP = "b0000000-0000-4000-8000-0000000000aa";

type Opts = { optional?: boolean; trgm?: boolean };

async function setup({ optional = true, trgm = false }: Opts = {}) {
  const db = trgm ? new PGlite({ extensions: { pg_trgm } }) : new PGlite();
  await db.exec(`
    create schema if not exists auth;
    do $$ begin
      if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon; end if;
      if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated; end if;
      if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role bypassrls; end if;
    end $$;
    grant usage on schema public to anon, authenticated, service_role;
    grant usage on schema auth to anon, authenticated, service_role;
    alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
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
    create table public.teams (id uuid primary key default gen_random_uuid(),
      cohort_id uuid references public.cohorts(id) on delete cascade,
      slug text not null, name text not null,
      discord_text_channel_id text, discord_voice_channel_id text);
    create table public.team_members (id uuid primary key default gen_random_uuid(),
      team_id uuid references public.teams(id) on delete cascade, user_id uuid references public.profiles(id));
    create table public.enrollments (id uuid primary key default gen_random_uuid(),
      user_id uuid references public.profiles(id), cohort_id uuid references public.cohorts(id) on delete cascade);
    create table public.applications (id uuid primary key default gen_random_uuid(),
      user_id uuid references public.profiles(id), status text not null);
    create table public.site_settings (key text primary key, value jsonb);
    create table public.mentor_assignments (id uuid primary key default gen_random_uuid(),
      mentor_id uuid references public.profiles(id), student_id uuid references public.profiles(id), cohort_id uuid);

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
      ('${OTHER}', 'o@x', 'Other', 'student', null),
      ('${PAID}', 'p@x', 'Paid', 'student', null);
    insert into public.cohorts (id, name, status) values
      ('${COHORT_A}', 'Fall 2026', 'active'),
      ('${COHORT_B}', 'Winter 2027!', 'upcoming'),
      ('${COHORT_X}', 'Cancelled one', 'cancelled');
    insert into public.teams (id, cohort_id, slug, name, discord_text_channel_id) values
      ('${TEAM_A}', '${COHORT_A}', 'acme', 'Acme', '999'),
      ('${TEAM_B}', '${COHORT_B}', 'globex', 'Globex', null);
    insert into public.team_members (team_id, user_id) values ('${TEAM_A}', '${ENROLLED}'), ('${TEAM_B}', '${OTHER}');
    insert into public.mentor_assignments (mentor_id, student_id) values ('${MENTOR}', '${ENROLLED}');
    insert into public.enrollments (user_id, cohort_id) values ('${ENROLLED}', '${COHORT_A}'), ('${OTHER}', '${COHORT_B}');
    insert into public.applications (user_id, status) values
      ('${ACCEPTED}', 'accepted'), ('${FRESH}', 'draft'), ('${PAID}', 'paid');
    insert into public.site_settings (key, value) values
      ('discord_url', '"https://discord.gg/x"'), ('discord_enabled', 'true'), ('referrals_enabled', 'true');
  `);

  if (!optional) return db;

  await db.exec(`
    create table public.notifications (id uuid primary key default gen_random_uuid(), user_id uuid,
      type text not null, title text, body text, link text, read_at timestamptz);
    alter table public.notifications enable row level security;
    create policy "notifications self select" on public.notifications
      for select using (user_id = auth.uid() or public.is_admin(auth.uid()));
    create table public.lessons (id uuid primary key default gen_random_uuid(), title text, description text);
    create table public.email_templates (key text primary key, body_html text not null);
    create table public.cohort_kickoff (cohort_id uuid primary key references public.cohorts(id) on delete cascade,
      checklist jsonb);
    create schema storage;
    create table storage.buckets (id text primary key, name text, public boolean, file_size_limit bigint);
    create publication supabase_realtime;

    create schema realtime;
    grant usage on schema realtime to authenticated;
    create table realtime.messages (id bigserial primary key, topic text not null, extension text not null,
      payload jsonb, event text);
    alter table realtime.messages enable row level security;
    grant select, insert on realtime.messages to authenticated;
    grant usage on sequence realtime.messages_id_seq to authenticated;
    create function realtime.topic() returns text language sql stable as $$
      select nullif(current_setting('realtime.topic', true), '') $$;

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
    -- 0089's and 0011's read policies, which 0101 retires.
    alter table public.dm_conversations enable row level security;
    alter table public.dm_messages enable row level security;
    alter table public.dm_reports enable row level security;
    alter table public.team_messages enable row level security;
    create policy "dm_conversations read" on public.dm_conversations
      for select using (auth.uid() in (user_a, user_b));
    create policy "dm_messages read" on public.dm_messages
      for select using (exists (select 1 from public.dm_conversations d
                                where d.id = conversation_id and auth.uid() in (d.user_a, d.user_b)));
    create policy "dm_reports read" on public.dm_reports for select using (public.is_admin(auth.uid()));
    create policy "team_messages read" on public.team_messages
      for select using (exists (select 1 from public.team_members m where m.team_id = team_messages.team_id and m.user_id = auth.uid()));

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

async function asUser<T = any>(db: PGlite, uid: string, sql: string, params?: unknown[], topic?: string) {
  await db.exec(`set role authenticated; select set_config('request.jwt.claim.sub', '${uid}', false);
                 select set_config('realtime.topic', '${topic ?? ""}', false);`);
  try {
    return await db.query<T>(sql, params);
  } finally {
    await db.exec(`reset role; select set_config('request.jwt.claim.sub', '', false); select set_config('realtime.topic', '', false);`);
  }
}

async function channelId(db: PGlite, systemKey: string): Promise<string> {
  const { rows } = await db.query<{ id: string }>(`select id from public.chat_channels where system_key = $1`, [systemKey]);
  assert.equal(rows.length, 1, `channel ${systemKey}`);
  return rows[0].id;
}

/**
 * The viewer getChatViewer() (lib/chat.ts) builds, from the same rows, step
 * by step as it does: vettedIds(), own enrollments and teams, mentoredScopes()
 * (the assigned students' teams and cohorts), and the explicit memberships.
 * Never written out by hand, so the matrix can't agree on a made-up viewer.
 */
async function viewerFromDb(db: PGlite, uid: string, staff: boolean): Promise<ChatViewer> {
  const col = async (sql: string, params: unknown[] = [uid]) =>
    (await db.query<{ v: string }>(sql, params)).rows.map((r) => r.v);
  const role = (await col(`select role as v from public.profiles where id = $1`))[0];
  const enrolled = await col(`select cohort_id as v from public.enrollments where user_id = $1`);
  const accepted = await col(`select id as v from public.applications where user_id = $1 and status = any($2)`, [
    uid,
    ACCEPTED_STATUSES,
  ]);
  const ownTeams = await col(`select team_id as v from public.team_members where user_id = $1`);
  const students = await col(`select student_id as v from public.mentor_assignments where mentor_id = $1`);
  const mentoredTeams = await col(`select team_id as v from public.team_members where user_id = any($1)`, [students]);
  const mentoredCohorts = await col(`select cohort_id as v from public.enrollments where user_id = any($1)`, [students]);
  return {
    userId: uid,
    staff,
    vetted: (!!role && role !== "student") || enrolled.length > 0 || accepted.length > 0,
    cohortIds: [...new Set([...enrolled, ...mentoredCohorts])],
    teamIds: [...new Set([...ownTeams, ...mentoredTeams])],
    memberOf: await col(`select channel_id as v from public.chat_members where user_id = $1`),
  };
}

const sorted = (ids: readonly string[]) => [...ids].sort();

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
  // A private channel with one explicit member, an unreported group, and an
  // accepted student added to a cohort channel on top of its audience.
  const cohortB = await channelId(db, `cohort:${COHORT_B}`);
  await db.exec(`
    insert into public.chat_channels (id, kind, name, audience) values
      ('b0000000-0000-4000-8000-000000000001', 'channel', 'mentors', 'members');
    insert into public.chat_members (channel_id, user_id) values
      ('b0000000-0000-4000-8000-000000000001', '${MENTOR}'),
      ('${cohortB}', '${ACCEPTED}');
    insert into public.chat_channels (id, kind, audience) values
      ('b0000000-0000-4000-8000-000000000002', 'group', 'members');
    insert into public.chat_members (channel_id, user_id) values
      ('b0000000-0000-4000-8000-000000000002', '${ENROLLED}'),
      ('b0000000-0000-4000-8000-000000000002', '${OTHER}');
  `);
  // An admin grants chat.manage on purpose — 0101 doesn't (see the Discord
  // test) — so STAFF is a non-admin moderator from here on.
  await db.exec(`update public.app_roles set permissions = permissions || array['chat.manage'] where slug = 'community'`);
  // A group STAFF was in, reported, then left: the report froze STAFF as a
  // party, so leaving opens no read path for them. ADMIN reads it.
  await db.exec(`
    insert into public.chat_channels (id, kind, audience) values
      ('b0000000-0000-4000-8000-000000000003', 'group', 'members');
    insert into public.chat_members (channel_id, user_id) values
      ('b0000000-0000-4000-8000-000000000003', '${ACCEPTED}'),
      ('b0000000-0000-4000-8000-000000000003', '${STAFF}');
    insert into public.chat_reports (channel_id, reporter_id, reason) values
      ('b0000000-0000-4000-8000-000000000003', '${ACCEPTED}', 'not ok');
    delete from public.chat_members where channel_id = 'b0000000-0000-4000-8000-000000000003' and user_id = '${STAFF}';
  `);

  const channels = (
    await db.query<any>(`select id, kind, audience, cohort_id, team_id, posting, archived_at, slowmode_seconds from public.chat_channels`)
  ).rows.map(
    (r): ChannelScope => ({
      id: r.id, kind: r.kind, audience: r.audience, cohortId: r.cohort_id, teamId: r.team_id,
      posting: r.posting, archivedAt: r.archived_at, slowmodeSeconds: r.slowmode_seconds,
    }),
  );
  const reports = (await db.query<any>(`select channel_id, party_ids from public.chat_reports`)).rows;
  const reportsOn = (id: string) => reports.filter((r) => r.channel_id === id).map((r) => ({ partyIds: r.party_ids as string[] }));
  // can(caps, "chat.manage"): the role's permissions, as the app reads them.
  const staffIds = new Set(
    (await db.query<{ id: string }>(
      `select p.id from public.profiles p join public.app_roles r on r.slug = p.role
       where r.permissions @> array['*'] or r.permissions @> array['chat.manage']`,
    )).rows.map((r) => r.id),
  );

  for (const [who, uid] of Object.entries(PEOPLE)) {
    const v = await viewerFromDb(db, uid, staffIds.has(uid));
    const expected = channels.filter((c) => canReadChannel(c, v, channelReportsOpenTo(reportsOn(c.id), v))).map((c) => c.id);
    const actual = (await asUser<{ id: string }>(db, uid, `select id from public.chat_channels`)).rows.map((r) => r.id);
    assert.deepEqual(sorted(actual), sorted(expected), `${who} reads a different set in SQL than in TypeScript`);
  }

  // Spot checks of the rule itself, so the matrix can't agree on nonsense.
  const sees = async (uid: string, key: string) =>
    (await asUser(db, uid, `select 1 from public.chat_channels where system_key = '${key}'`)).rows.length === 1;
  assert.equal(await sees(FRESH, "general"), false, "an unvetted signup sees no community channel");
  assert.equal(await sees(ACCEPTED, "general"), true);
  assert.equal(await sees(PAID, "general"), true, "a paid application counts as let in");
  assert.equal(await sees(MENTOR, "general"), true);
  assert.equal(await sees(ENROLLED, `cohort:${COHORT_A}`), true);
  assert.equal(await sees(OTHER, `cohort:${COHORT_A}`), false);
  assert.equal(await sees(ACCEPTED, `cohort:${COHORT_B}`), true, "explicit member on an audience channel");
  assert.equal(await sees(ENROLLED, `team:${TEAM_B}`), false);
  assert.equal(await sees(STAFF, "staff"), true, "chat.manage, granted above");
  assert.equal(await sees(MENTOR, `team:${TEAM_A}`), true, "a mentor assigned to someone on the team");
  assert.equal(await sees(MENTOR, `cohort:${COHORT_A}`), true, "a mentor assigned to someone in the cohort");
  assert.equal(await sees(MENTOR, `team:${TEAM_B}`), false);
  assert.equal(await sees(MENTOR, `cohort:${COHORT_B}`), false);
  assert.equal(await sees(MENTOR, "staff"), false);
  const group = (uid: string) => asUser(db, uid, `select 1 from public.chat_channels where id = 'b0000000-0000-4000-8000-000000000002'`);
  assert.equal((await group(ADMIN)).rows.length, 0, "no staff read path into an unreported group");
  assert.equal((await group(ENROLLED)).rows.length, 1);
  // The carried-over DM report opens that DM to staff.
  assert.equal((await asUser(db, STAFF, `select 1 from public.chat_channels where id = '${DM_GONE}'`)).rows.length, 1);
  assert.equal((await asUser(db, STAFF, `select 1 from public.chat_channels where id = '${DM_OLD}'`)).rows.length, 0);
  const left = (uid: string) => asUser(db, uid, `select 1 from public.chat_channels where id = 'b0000000-0000-4000-8000-000000000003'`);
  assert.equal((await left(STAFF)).rows.length, 0, "a moderator the report is about can't read in through it");
  assert.equal((await left(ADMIN)).rows.length, 1);
  // And it's the channel rule messages ride on, so its words stay shut too.
  await db.exec(`insert into public.chat_messages (channel_id, sender_id, body) values ('b0000000-0000-4000-8000-000000000003', '${ACCEPTED}', 'x')`);
  const words = (uid: string) => asUser(db, uid, `select 1 from public.chat_messages where channel_id = 'b0000000-0000-4000-8000-000000000003'`);
  assert.equal((await words(STAFF)).rows.length, 0);
  assert.equal((await words(ADMIN)).rows.length, 1);
});

test("a moderator a report names stays out, even when a later report leaves them out", async () => {
  const db = await setup();
  await db.exec(migration);
  await db.exec(`update public.app_roles set permissions = permissions || array['chat.manage'] where slug = 'community'`);
  // STAFF says something in a group with two students, one of them reports
  // it, and STAFF leaves.
  await db.exec(`
    insert into public.chat_channels (id, kind, audience) values ('${GROUP}', 'group', 'members');
    insert into public.chat_members (channel_id, user_id) values
      ('${GROUP}', '${STAFF}'), ('${GROUP}', '${ACCEPTED}'), ('${GROUP}', '${OTHER}');
    insert into public.chat_messages (id, channel_id, sender_id, body) values
      ('90000000-0000-4000-8000-0000000000a1', '${GROUP}', '${STAFF}', 'something awful');
    insert into public.chat_reports (channel_id, message_id, reporter_id, reason) values
      ('${GROUP}', '90000000-0000-4000-8000-0000000000a1', '${ACCEPTED}', 'about the moderator');
    delete from public.chat_members where channel_id = '${GROUP}' and user_id = '${STAFF}';
    insert into public.chat_messages (channel_id, sender_id, body) values ('${GROUP}', '${OTHER}', 'what they said about it');
  `);
  // The next report, as a caller that only saw who's in the group now would
  // file it (the freeze trigger would add STAFF back as a sender; this is the
  // read gate on its own).
  await db.exec(`
    insert into public.chat_reports (channel_id, reporter_id, reason) values ('${GROUP}', '${OTHER}', 'again');
    update public.chat_reports set party_ids = array['${ACCEPTED}', '${OTHER}']::uuid[] where reason = 'again';
  `);
  const reads = async (uid: string) =>
    (await asUser(db, uid, `select 1 from public.chat_messages where channel_id = '${GROUP}'`)).rows.length;
  assert.equal(await reads(STAFF), 0, "the first report still names them");
  assert.equal(await reads(ADMIN), 2);
  const partyLists = (await db.query<any>(`select party_ids from public.chat_reports where channel_id = '${GROUP}'`)).rows.map(
    (r) => ({ partyIds: r.party_ids as string[] }),
  );
  assert.equal(channelReportsOpenTo(partyLists, { userId: STAFF, staff: true }), false);
  assert.equal(channelReportsOpenTo(partyLists, { userId: ADMIN, staff: true }), true);
});

test("a report's parties are frozen when it's filed, as reportPartyIds() has them", async () => {
  const db = await setup();
  await db.exec(migration);
  // A group: two members now; MENTOR posted (a deleted message) and left;
  // an earlier report there named PAID.
  await db.exec(`
    insert into public.chat_channels (id, kind, audience) values ('${GROUP}', 'group', 'members');
    insert into public.chat_members (channel_id, user_id) values ('${GROUP}', '${ENROLLED}'), ('${GROUP}', '${OTHER}');
    insert into public.chat_messages (id, channel_id, sender_id, body, created_at) values
      ('90000000-0000-4000-8000-0000000000b1', '${GROUP}', '${MENTOR}', 'gone now', '2026-10-15T10:00:00Z'),
      ('90000000-0000-4000-8000-0000000000b2', '${GROUP}', '${ENROLLED}', 'still here', '2026-10-15T10:01:00Z');
    update public.chat_messages set body = '', deleted_at = now() where id = '90000000-0000-4000-8000-0000000000b1';
    insert into public.chat_messages (channel_id, kind, body) values ('${GROUP}', 'system', 'Mentor left the group.');
  `);
  await db.exec(`insert into public.chat_reports (channel_id, reporter_id, reason, party_ids) values
    ('${GROUP}', '${OTHER}', 'earlier', array['${PAID}']::uuid[])`);
  // Filed with nothing: the trigger works out who it's about.
  await db.exec(`insert into public.chat_reports (channel_id, message_id, reporter_id, reason) values
    ('${GROUP}', '90000000-0000-4000-8000-0000000000b2', '${OTHER}', 'now')`);
  const frozen = (await db.query<any>(`select party_ids from public.chat_reports where reason = 'now'`)).rows[0].party_ids;
  const expected = reportPartyIds({
    kind: "group",
    members: [ENROLLED, OTHER],
    senders: [MENTOR, ENROLLED, null],
    messageSenderId: ENROLLED,
    earlier: [{ partyIds: [PAID] }],
  });
  assert.deepEqual(sorted(frozen), sorted(expected));
  assert.deepEqual(sorted(frozen), sorted([ENROLLED, OTHER, MENTOR, PAID]));

  // A text channel's report is about the message, not the room.
  const general = await channelId(db, "general");
  await db.exec(`
    insert into public.chat_messages (id, channel_id, sender_id, body) values
      ('90000000-0000-4000-8000-0000000000b3', '${general}', '${ADMIN}', 'hello all'),
      ('90000000-0000-4000-8000-0000000000b4', '${general}', '${ENROLLED}', 'hi');
    insert into public.chat_reports (channel_id, message_id, reporter_id, reason) values
      ('${general}', '90000000-0000-4000-8000-0000000000b3', '${ENROLLED}', 'in general');
  `);
  const channelFrozen = (await db.query<any>(`select party_ids from public.chat_reports where reason = 'in general'`)).rows[0].party_ids;
  assert.deepEqual(
    channelFrozen,
    reportPartyIds({ kind: "channel", members: [], senders: [ADMIN, ENROLLED], messageSenderId: ADMIN, earlier: [] }),
  );
  // Whatever the caller passed is kept: the freeze only ever adds. And in a
  // text channel an earlier report's parties don't carry over (ADMIN, from
  // 'in general', isn't added), so no report can bury another.
  await db.exec(`insert into public.chat_reports (channel_id, message_id, reporter_id, reason, party_ids) values
    ('${general}', '90000000-0000-4000-8000-0000000000b4', '${OTHER}', 'passed', array['${STAFF}']::uuid[])`);
  const passed = (await db.query<any>(`select party_ids from public.chat_reports where reason = 'passed'`)).rows[0].party_ids;
  assert.deepEqual(sorted(passed), sorted([STAFF, ENROLLED]));
});

test("reports are service-role only, and nobody reads who removed or pinned a message", async () => {
  const db = await setup();
  await db.exec(migration);
  const general = await channelId(db, "general");
  await db.exec(`
    insert into public.chat_messages (id, channel_id, sender_id, body) values
      ('90000000-0000-4000-8000-0000000000e1', '${general}', '${OTHER}', 'rude'),
      ('90000000-0000-4000-8000-0000000000e2', '${general}', '${MENTOR}', 'also rude');
    insert into public.chat_reports (channel_id, message_id, reporter_id, reason) values
      ('${general}', '90000000-0000-4000-8000-0000000000e1', '${ENROLLED}', 'mine'),
      ('${general}', '90000000-0000-4000-8000-0000000000e2', '${ACCEPTED}', 'theirs');
    update public.chat_messages set body = '', deleted_at = now(), deleted_by = '${ADMIN}' where id = '90000000-0000-4000-8000-0000000000e1';
  `);
  // Not even your own report: its party_ids would say who else was reported.
  assert.equal((await asUser(db, ENROLLED, `select id from public.chat_reports`)).rows.length, 0);
  // The message itself is readable; who removed it isn't.
  const own = await asUser(db, ENROLLED, `select id, deleted_at is not null as gone from public.chat_messages where id = '90000000-0000-4000-8000-0000000000e1'`);
  assert.deepEqual(own.rows, [{ id: "90000000-0000-4000-8000-0000000000e1", gone: true }]);
  await assert.rejects(asUser(db, ENROLLED, `select deleted_by from public.chat_messages`), /permission denied/);
  await assert.rejects(asUser(db, ENROLLED, `select pinned_by from public.chat_messages`), /permission denied/);
  await assert.rejects(asUser(db, ENROLLED, `select * from public.chat_messages`), /permission denied/);
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

test("there is no browser write path, and mutes are the service role's alone", async () => {
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

  // A mute: nobody but the service role reads or writes one, not even the
  // person muted or an admin.
  await db.exec(`insert into public.chat_mutes (user_id, until, reason, created_by) values ('${ENROLLED}', null, 'spam', '${ADMIN}')`);
  assert.equal((await asUser(db, ENROLLED, `select 1 from public.chat_mutes`)).rows.length, 0);
  assert.equal((await asUser(db, ADMIN, `select 1 from public.chat_mutes`)).rows.length, 0);
  await asUser(db, ENROLLED, `delete from public.chat_mutes`);
  await assert.rejects(asUser(db, ENROLLED, `insert into public.chat_mutes (user_id) values ('${OTHER}')`), /row-level security/);
  assert.equal((await db.query(`select 1 from public.chat_mutes`)).rows.length, 1, "lifting your own mute matches nothing");
  const mutePolicies = await db.query<{ n: number }>(
    `select count(*)::int as n from pg_policies where tablename in ('chat_mutes', 'chat_message_revisions')`,
  );
  assert.equal(mutePolicies.rows[0].n, 0);
  // The mute goes with the account.
  await db.exec(`delete from public.chat_mutes; insert into public.chat_mutes (user_id) values ('${FRESH}');
                 delete from public.applications where user_id = '${FRESH}'; delete from public.profiles where id = '${FRESH}'`);
  assert.equal((await db.query(`select 1 from public.chat_mutes`)).rows.length, 0);
});

test("the helper functions can't be called over /rpc; the service role can count", async () => {
  const db = await setup();
  await db.exec(migration);
  await assert.rejects(asUser(db, ENROLLED, `select public.chat_unread('${ADMIN}', array[]::uuid[])`), /permission denied/);
  await assert.rejects(asUser(db, ENROLLED, `select public.chat_is_staff('${ADMIN}')`), /permission denied/);
  await assert.rejects(asUser(db, ENROLLED, `select public.chat_is_vetted('${FRESH}')`), /permission denied/);
  await assert.rejects(
    asUser(db, ENROLLED, `select public.chat_can_read(c, '${ADMIN}') from public.chat_channels c limit 1`),
    /permission denied/,
  );
  const granted = await db.query<{ ok: boolean }>(
    `select has_function_privilege('service_role', 'public.chat_unread(uuid, uuid[])', 'execute') as ok`,
  );
  assert.equal(granted.rows[0].ok, true);
  await assert.rejects(asUser(db, ENROLLED, `select public.chat_files_in_use(array['x'])`), /permission denied/);
  const sweep = await db.query<{ ok: boolean }>(
    `select has_function_privilege('service_role', 'public.chat_files_in_use(text[])', 'execute') as ok`,
  );
  assert.equal(sweep.rows[0].ok, true);
});

test("chat_files_in_use: a sent file is in use, and stays in use after its message is deleted", async () => {
  const db = await setup();
  await db.exec(migration);
  const general = await channelId(db, "general");
  const path = (n: number) => `${general}/${ENROLLED}/00000000-0000-4000-8000-00000000000${n}-photo.png`;
  const att = (n: number) => JSON.stringify([{ path: path(n), name: "photo.png", size: 10, type: "image/png" }]);
  await db.exec(`
    insert into public.chat_messages (id, channel_id, sender_id, body, attachments) values
      ('90000000-0000-4000-8000-0000000000f1', '${general}', '${ENROLLED}', 'look', '${att(1)}'::jsonb),
      ('90000000-0000-4000-8000-0000000000f2', '${general}', '${ENROLLED}', 'and this', '${att(2)}'::jsonb);
  `);
  const inUse = async (paths: string[]) =>
    (await db.query<{ p: string }>(`select p from public.chat_files_in_use($1::text[]) as p order by p`, [paths])).rows.map((r) => r.p);
  assert.deepEqual(await inUse([path(1), path(2), path(3)]), [path(1), path(2)]);
  // Deleting blanks the message; its files live on in the revision, as evidence.
  await db.exec(`update public.chat_messages set body = '', attachments = '[]', deleted_at = now() where id = '90000000-0000-4000-8000-0000000000f1'`);
  assert.equal((await db.query<any>(`select attachments from public.chat_messages where id = '90000000-0000-4000-8000-0000000000f1'`)).rows[0].attachments.length, 0);
  assert.deepEqual(await inUse([path(1), path(3)]), [path(1)]);
  // Once nothing points at it (the channel deleted, say), it's the sweep's.
  await db.exec(`delete from public.chat_messages where channel_id = '${general}'`);
  assert.deepEqual(await inUse([path(1), path(2)]), []);
  assert.deepEqual(await inUse([]), []);
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

test("the summary kept message by message matches a recount, whatever order things happen in", async () => {
  const db = await setup();
  await db.exec(migration);
  const general = await channelId(db, "general");
  const at = (minute: number) => `2026-10-15T10:${String(minute).padStart(2, "0")}:00Z`;
  const id = (n: number) => `90000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  // What the trigger keeps, against what the messages say.
  const check = async (step: string) => {
    const kept = (await db.query<any>(
      `select message_count, last_message_at, last_message_preview, last_sender_id from public.chat_channels where id = $1`, [general],
    )).rows[0];
    const truth = (await db.query<any>(
      `select (select count(*)::int from public.chat_messages where channel_id = $1 and deleted_at is null and kind = 'message') as message_count,
              l.created_at as last_message_at,
              case when l.created_at is null then null when char_length(l.body) > 0 then left(l.body, 140) else '[attachment]' end as last_message_preview,
              l.sender_id as last_sender_id
       from (select 1) one
       left join lateral (select created_at, body, sender_id from public.chat_messages
                          where channel_id = $1 and deleted_at is null and kind = 'message'
                          order by created_at desc, id desc limit 1) l on true`, [general],
    )).rows[0];
    assert.deepEqual(kept, truth, step);
  };
  const send = (n: number, minute: number, who = ENROLLED, body = `m${n}`) =>
    db.exec(`insert into public.chat_messages (id, channel_id, sender_id, body, created_at) values ('${id(n)}', '${general}', '${who}', '${body}', '${at(minute)}')`);
  const remove = (n: number) =>
    db.exec(`update public.chat_messages set body = '', attachments = '[]', deleted_at = now() where id = '${id(n)}'`);

  await check("empty");
  await send(1, 10);
  await check("first send");
  await send(2, 20, OTHER);
  await check("newer send");
  await send(3, 5); // history carried in behind the newest
  await check("older insert");
  await send(4, 20, ADMIN, "tie"); // the same instant as the newest
  await check("tied insert");
  await db.exec(`insert into public.chat_messages (channel_id, kind, body, created_at) values ('${general}', 'system', 'Sam pinned a message.', '${at(30)}')`);
  await check("a system line never counts");
  await db.exec(`update public.chat_messages set body = 'm1 edited' where id = '${id(1)}'`);
  await check("an older edit");
  await db.exec(`update public.chat_messages set body = 'newest, edited' where id = '${id(2)}'`);
  await db.exec(`update public.chat_messages set body = 'tie, edited' where id = '${id(4)}'`);
  await check("newest edits");
  await db.exec(`insert into public.chat_messages (id, channel_id, sender_id, body, attachments, created_at) values
    ('${id(5)}', '${general}', '${OTHER}', '', '[{"path":"x","name":"a.png","size":1,"type":"image/png"}]', '${at(40)}')`);
  await check("an attachment");
  await remove(5);
  await check("the newest deleted");
  await remove(3);
  await check("an older one deleted");
  await db.exec(`delete from public.chat_messages where id = '${id(2)}'`);
  await check("a hard delete of the newest");
  await remove(4);
  await remove(1);
  await check("everything deleted");
  await send(6, 1);
  await check("a send into an emptied channel");
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
  assert.deepEqual((await db.query<any>(`select channel_id, status, party_ids from public.chat_reports`)).rows, [
    { channel_id: DM_GONE, status: "actioned", party_ids: [ACCEPTED] },
  ]);

  const team = await channelId(db, `team:${TEAM_A}`);
  assert.deepEqual(
    (await db.query<any>(`select id, body from public.chat_messages where channel_id = '${team}'`)).rows,
    [{ id: TEAM_MSG, body: "team thread lives on" }],
  );

  // History is carried once. What Chat removes afterwards — an unsent
  // message's words, purged with the account; a team-thread message staff
  // deleted — a later run of 0101 doesn't bring back.
  await db.exec(`
    delete from public.chat_message_revisions where message_id = '${DM_MSG_UNSENT}';
    delete from public.chat_messages where id = '${TEAM_MSG}';
  `);
  await db.exec(migration);
  assert.equal((await db.query(`select 1 from public.chat_message_revisions where message_id = '${DM_MSG_UNSENT}'`)).rows.length, 0);
  assert.equal((await db.query(`select 1 from public.chat_messages where id = '${TEAM_MSG}'`)).rows.length, 0);
});

test("an unblock survives a re-run: blocks are carried once", async () => {
  const db = await setup();
  await db.exec(migration);
  await db.exec(`delete from public.chat_blocks where blocker_id = '${ENROLLED}' and blocked_id = '${OTHER}'`);
  await db.exec(migration);
  assert.deepEqual((await db.query<any>(`select 1 from public.chat_blocks`)).rows, []);
});

test("a DM report 0099 already moved to Support arrives closed, once, still opening the DM to staff", async () => {
  const db = await setup();
  await db.exec(`
    create table public.support_tickets (id uuid primary key default gen_random_uuid(), context jsonb);
    insert into public.dm_reports (id, conversation_id, reporter_id, reason, status) values
      ('a1000000-0000-4000-8000-000000000001', '${DM_OLD}', '${ENROLLED}', 'creepy', 'open'),
      ('a1000000-0000-4000-8000-000000000002', '${DM_OLD}', '${ENROLLED}', 'again', 'open');
    insert into public.support_tickets (context) values
      ('{"source": "dm_report", "carriedFrom": "dm_report:a1000000-0000-4000-8000-000000000001"}');
  `);
  await db.exec(migration);
  await db.exec(migration);
  const rows = async () =>
    (await db.query<any>(`select id, status, party_ids from public.chat_reports where channel_id = '${DM_OLD}' order by id`)).rows;
  assert.deepEqual(await rows(), [
    { id: "a1000000-0000-4000-8000-000000000001", status: "actioned", party_ids: sorted([ENROLLED, MENTOR]) },
    { id: "a1000000-0000-4000-8000-000000000002", status: "open", party_ids: sorted([ENROLLED, MENTOR]) },
  ]);
  // A '*' admin who isn't in the DM reads it; nobody in it reads it as staff.
  assert.equal((await asUser(db, ADMIN, `select 1 from public.chat_channels where id = '${DM_OLD}'`)).rows.length, 1);

  // A moderator reopens the closed copy. Running 0101 again leaves it open.
  await db.exec(`update public.chat_reports set status = 'open', reviewed_by = null, reviewed_at = null where id = 'a1000000-0000-4000-8000-000000000001'`);
  await db.exec(migration);
  assert.deepEqual((await rows()).map((r: any) => r.status), ["open", "open"]);

  // The old rows say they were carried, so a 0099 run after this one (it
  // moves the open ones to Support) finds nothing left to move.
  assert.deepEqual(
    (await db.query<any>(`select id, status from public.dm_reports where conversation_id = '${DM_OLD}' order by id`)).rows,
    [
      { id: "a1000000-0000-4000-8000-000000000001", status: "actioned" },
      { id: "a1000000-0000-4000-8000-000000000002", status: "actioned" },
    ],
  );
});

test("the old DM and team-thread tables are the service role's alone", async () => {
  const db = await setup();
  // Before: either side of an old DM reads it through the API.
  assert.equal((await asUser(db, MENTOR, `select 1 from public.dm_messages where conversation_id = '${DM_OLD}'`)).rows.length, 3);
  await db.exec(migration);
  // In Chat, the mentor deletes what they said. The old table mustn't still have it on offer.
  await db.exec(`update public.chat_messages set body = '', attachments = '[]', deleted_at = now(), deleted_by = '${MENTOR}' where id = '${DM_MSG_1}'`);
  for (const [table, who] of [
    ["dm_messages", ENROLLED], ["dm_conversations", ENROLLED], ["dm_reports", ADMIN], ["team_messages", ENROLLED],
  ] as const) {
    assert.equal((await asUser(db, who, `select 1 from public.${table}`)).rows.length, 0, table);
  }
  const left = await db.query<{ n: number }>(
    `select count(*)::int as n from pg_policies where schemaname = 'public'
     and tablename in ('dm_conversations', 'dm_messages', 'dm_reports', 'dm_blocks', 'team_messages')`,
  );
  assert.equal(left.rows[0].n, 0);
  // Kept, though: the service role still has the history.
  assert.equal((await db.query(`select 1 from public.dm_messages`)).rows.length, 3);
});

test("a cohort name longer than a topic still gets its channel", async () => {
  const db = await setup();
  const long = "x".repeat(320);
  await db.exec(`update public.cohorts set name = '${long}' where id = '${COHORT_A}'`);
  await db.exec(migration);
  const topic = (await db.query<any>(`select topic from public.chat_channels where system_key = 'cohort:${COHORT_A}'`)).rows[0].topic;
  assert.equal(topic.length, 300);
  await db.exec(`insert into public.cohorts (id, name, status) values ('c0000000-0000-4000-8000-0000000000ee', '${long}', 'upcoming')`);
  assert.ok(await channelId(db, "cohort:c0000000-0000-4000-8000-0000000000ee"));
});

test("sidebar counts: unread since the cursor, mentions on top, blocked senders never", async () => {
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
  assert.deepEqual(await counts(ENROLLED, [general]), [{ channel_id: general, unread: 2, mentions: 2 }],
    "OTHER's line doesn't count: ENROLLED blocked them (carried from dm_blocks)");
  assert.deepEqual(await counts(OTHER, [general]), [{ channel_id: general, unread: 2, mentions: 1 }]);
  // A blocked person @mentioning the blocker rings nothing.
  await db.exec(`insert into public.chat_messages (channel_id, sender_id, body, mentions) values
    ('${general}', '${OTHER}', 'hey <@${ENROLLED}>', array['${ENROLLED}']::uuid[])`);
  assert.deepEqual(await counts(ENROLLED, [general]), [{ channel_id: general, unread: 2, mentions: 2 }]);
  await db.exec(`delete from public.chat_blocks`);
  assert.deepEqual(await counts(ENROLLED, [general]), [{ channel_id: general, unread: 4, mentions: 3 }]);

  await db.exec(`insert into public.chat_reads (channel_id, user_id, last_read_at) values ('${general}', '${ENROLLED}', now() + interval '1 minute')`);
  assert.deepEqual(await counts(ENROLLED, [general]), [{ channel_id: general, unread: 0, mentions: 0 }]);

  // A cursor left months behind: everything since counts as unread (to the
  // cap), but mentions only from the last 30 days.
  await db.exec(`
    update public.chat_reads set last_read_at = now() - interval '200 days' where channel_id = '${general}' and user_id = '${ENROLLED}';
    insert into public.chat_messages (channel_id, sender_id, body, mentions, created_at) values
      ('${general}', '${ADMIN}', 'old ping <@${ENROLLED}>', array['${ENROLLED}']::uuid[], now() - interval '60 days');
  `);
  assert.deepEqual(await counts(ENROLLED, [general]), [{ channel_id: general, unread: 5, mentions: 3 }]);

  // System lines are echoes and never count, except #staff's feed, which is
  // nothing but system lines and has to show up as new — and then be read:
  // it moves the summary markRead clamps the cursor to.
  const summary = async (id: string) =>
    (await db.query<any>(`select message_count, last_message_at, last_message_preview from public.chat_channels where id = $1`, [id])).rows[0];
  const before = await summary(general);
  await db.exec(`insert into public.chat_messages (channel_id, sender_id, kind, body) values ('${general}', null, 'system', 'Ada pinned a message.')`);
  assert.deepEqual(await counts(ENROLLED, [general]), [{ channel_id: general, unread: 5, mentions: 3 }]);
  assert.deepEqual(await summary(general), before);
  const staff = await channelId(db, "staff");
  await db.exec(`insert into public.chat_messages (channel_id, sender_id, body, created_at) values ('${staff}', '${ADMIN}', 'morning team', now() - interval '1 hour')`);
  // Two feed lines a second apart, as two posts would be (one statement would
  // give them the same now(), and a tie goes to the larger random id).
  await db.exec(`insert into public.chat_messages (channel_id, sender_id, kind, body, created_at) values
    ('${staff}', null, 'system', 'New application: Ada.', now() - interval '1 second'),
    ('${staff}', null, 'system', 'Ada was accepted.', now())`);
  assert.deepEqual(await counts(STAFF, [staff]), [{ channel_id: staff, unread: 3, mentions: 0 }]);
  const feed = await summary(staff);
  assert.equal(feed.message_count, 3);
  assert.equal(feed.last_message_preview, "Ada was accepted.");
  // The cursor straight from the row, in SQL: a JS Date would cut it to milliseconds.
  await db.query(
    `insert into public.chat_reads (channel_id, user_id, last_read_at) select id, $2, last_message_at from public.chat_channels where id = $1`,
    [staff, STAFF],
  );
  assert.deepEqual(await counts(STAFF, [staff]), [{ channel_id: staff, unread: 0, mentions: 0 }]);
});

test("deleting a team or cohort archives its channel; a reported channel can't be deleted", async () => {
  const db = await setup();
  await db.exec(migration);
  const team = await channelId(db, `team:${TEAM_A}`);
  const cohortB = await channelId(db, `cohort:${COHORT_B}`);
  const teamB = await channelId(db, `team:${TEAM_B}`);
  // Evidence in the team channel: a message deleted (its words in revisions),
  // and a report about it.
  await db.exec(`
    insert into public.chat_messages (id, channel_id, sender_id, body) values
      ('90000000-0000-4000-8000-0000000000c1', '${team}', '${ENROLLED}', 'something to hide'),
      ('90000000-0000-4000-8000-0000000000c2', '${team}', '${ENROLLED}', 'a reply');
    update public.chat_messages set reply_to_id = '90000000-0000-4000-8000-0000000000c1' where id = '90000000-0000-4000-8000-0000000000c2';
    update public.chat_messages set body = '', deleted_at = now() where id = '90000000-0000-4000-8000-0000000000c1';
    insert into public.chat_reports (channel_id, message_id, reporter_id, reason) values
      ('${team}', '90000000-0000-4000-8000-0000000000c1', '${MENTOR}', 'not ok');
  `);

  // The last member leaves, and the team goes with them.
  await db.exec(`delete from public.team_members where team_id = '${TEAM_A}'; delete from public.teams where id = '${TEAM_A}'`);
  const kept = (await db.query<any>(
    `select audience, team_id, system_key, archived_at is not null as archived, message_count from public.chat_channels where id = '${team}'`,
  )).rows[0];
  assert.deepEqual(kept, { audience: "staff", team_id: null, system_key: null, archived: true, message_count: 2 });
  assert.equal((await db.query(`select 1 from public.chat_messages where channel_id = '${team}'`)).rows.length, 3);
  assert.equal((await db.query(`select 1 from public.chat_message_revisions where message_id = '90000000-0000-4000-8000-0000000000c1'`)).rows.length, 1);
  assert.equal((await db.query(`select 1 from public.chat_reports where channel_id = '${team}'`)).rows.length, 1);
  // Staff read it; the mentor the team channel opened to doesn't any more.
  assert.equal((await asUser(db, ADMIN, `select 1 from public.chat_channels where id = '${team}'`)).rows.length, 1);
  assert.equal((await asUser(db, MENTOR, `select 1 from public.chat_channels where id = '${team}'`)).rows.length, 0);

  // A whole cohort: its channel, and its teams' through the cascade.
  await db.exec(`delete from public.cohorts where id = '${COHORT_B}'`);
  const both = (await db.query<any>(
    `select id, audience, cohort_id, team_id, system_key, archived_at is not null as archived from public.chat_channels where id in ('${cohortB}', '${teamB}') order by id = '${teamB}'`,
  )).rows;
  assert.deepEqual(both, [
    { id: cohortB, audience: "staff", cohort_id: null, team_id: null, system_key: null, archived: true },
    { id: teamB, audience: "staff", cohort_id: null, team_id: null, system_key: null, archived: true },
  ]);
  // A re-run doesn't bring the owned channel back.
  await db.exec(migration);
  assert.equal((await db.query(`select 1 from public.chat_channels where system_key = 'team:${TEAM_A}'`)).rows.length, 0);

  // The reported channel can't be deleted outright; an unreported one can,
  // replies and all.
  await assert.rejects(db.exec(`delete from public.chat_channels where id = '${team}'`), /chat_reports_channel_id_fkey/);
  await db.exec(`
    insert into public.chat_messages (id, channel_id, sender_id, body) values
      ('90000000-0000-4000-8000-0000000000c3', '${teamB}', '${OTHER}', 'q'),
      ('90000000-0000-4000-8000-0000000000c4', '${teamB}', '${OTHER}', 'a');
    update public.chat_messages set reply_to_id = '90000000-0000-4000-8000-0000000000c3' where id = '90000000-0000-4000-8000-0000000000c4';
    delete from public.chat_channels where id = '${teamB}';
  `);
  assert.equal((await db.query(`select 1 from public.chat_messages where channel_id = '${teamB}'`)).rows.length, 0);
});

test("Discord is gone: tables, columns, settings, the permission, and old bells' links", async () => {
  const db = await setup();
  await db.exec(`insert into public.notifications (user_id, type, title, link, read_at) values
    ('${ADMIN}', 'discord_blocker', 'Blocker flagged in Discord', 'https://discord.com/channels/1/2/3', null),
    ('${ADMIN}', 'discord_blocker', 'Blocker flagged in Discord', null, null),
    ('${ENROLLED}', 'direct_message', 'Mentor messaged you', '/messages?c=${DM_OLD}', null),
    ('${ENROLLED}', 'announcement', 'News', 'https://discord.com/somewhere', null)`);
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
    [{ key: "chat_blocks_carried" }, { key: "chat_history_carried" }, { key: "referrals_enabled" }],
  );
  const roles = Object.fromEntries(
    (await db.query<any>(`select slug, permissions from public.app_roles`)).rows.map((r) => [r.slug, r.permissions]),
  );
  // Removed, not converted: chat.manage opens reported DMs, so it's granted on purpose.
  assert.deepEqual(roles.community, ["announcements.manage"]);
  assert.equal((await asUser(db, STAFF, `select 1 from public.chat_channels where id = '${DM_GONE}'`)).rows.length, 0);
  assert.deepEqual(roles.admin, ["*"]);
  // The profile guard still guards, without the dropped columns.
  await db.exec(`create trigger guard_profile_privileges before update on public.profiles for each row execute procedure public.guard_profile_privileges()`);
  await assert.rejects(asUser(db, ENROLLED, `update public.profiles set role = 'admin' where id = '${ENROLLED}'`), /cannot be changed/);
  await asUser(db, ENROLLED, `update public.profiles set full_name = 'New name' where id = '${ENROLLED}'`);
  // The blocker bell keeps its title and loses the dead link; the old DM bell
  // is read (Chat counts that DM itself); nothing else is touched.
  assert.deepEqual(
    (await db.query<any>(`select type, link, read_at is not null as read from public.notifications order by type, link nulls last`)).rows,
    [
      { type: "announcement", link: "https://discord.com/somewhere", read: false },
      { type: "direct_message", link: `/messages?c=${DM_OLD}`, read: true },
      { type: "discord_blocker", link: null, read: false },
      { type: "discord_blocker", link: null, read: false },
    ],
  );
});

test("lesson, email and kickoff copy point at Chat, once; generic Discord advice is left alone", async () => {
  const db = await setup();
  await db.exec(`insert into public.cohort_kickoff (cohort_id, checklist) values
    ('${COHORT_A}', '[{"label": "Read the guide", "href": "/dashboard/resources"},
                     {"label": "Link Discord and meet your cohort", "href": "/dashboard/community"},
                     {"label": "Profile", "href": "/dashboard/settings"}]'),
    ('${COHORT_B}', '[{"label": "Say hi in #general", "href": "/chat"}]')`);
  await db.exec(migration);
  const once = (await db.query<any>(`select title, description from public.lessons order by title`)).rows;
  const kickoffOnce = (await db.query<any>(`select cohort_id, checklist from public.cohort_kickoff order by cohort_id`)).rows;
  await db.exec(migration);
  const twice = (await db.query<any>(`select title, description from public.lessons order by title`)).rows;
  assert.deepEqual(twice, once);
  assert.deepEqual((await db.query<any>(`select cohort_id, checklist from public.cohort_kickoff order by cohort_id`)).rows, kickoffOnce);
  const by = Object.fromEntries(once.map((r) => [r.title, r.description]));
  assert.equal(
    by["Field guide"],
    "Paste it into your cohort channel in [Chat](/chat) and ask. Use the cohort in Chat as your debrief partner; then [Chat](/chat).",
  );
  assert.equal(by.Untouched, "Post in three FTC Discord servers.");
  const email = (await db.query<any>(`select body_html from public.email_templates`)).rows[0].body_html;
  assert.equal(email, "<p>Reply to this email, or post it in your cohort's channel in Chat — someone else is stuck.</p>");
  assert.deepEqual(kickoffOnce.map((r) => r.checklist), [
    [
      { label: "Read the guide", href: "/dashboard/resources" },
      { label: "Say hi in #general and your cohort's channel", href: "/chat" },
      { label: "Profile", href: "/dashboard/settings" },
    ],
    [{ label: "Say hi in #general", href: "/chat" }],
  ]);
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

test("admins read other people's bells, but never their chat ones", async () => {
  const db = await setup();
  await db.exec(migration);
  await db.exec(`insert into public.notifications (user_id, type, title) values
    ('${ENROLLED}', 'chat_dm', 'Mentor messaged you'),
    ('${ENROLLED}', 'chat_message', 'Other in a group chat'),
    ('${ENROLLED}', 'direct_message', 'Mentor messaged you'),
    ('${ENROLLED}', 'announcement', 'News'),
    ('${STAFF}', 'chat_reported', 'Someone reported a chat message'),
    ('${STAFF}', 'dm_reported', 'Reported conversation'),
    ('${ADMIN}', 'chat_reported', 'Someone reported a chat message')`);
  const sees = async (uid: string) =>
    (await asUser<{ user_id: string; type: string }>(db, uid, `select user_id, type from public.notifications order by user_id, type`)).rows.map(
      (r) => `${r.user_id === uid ? "own" : "other"}:${r.type}`,
    );
  assert.deepEqual(await sees(ADMIN), ["own:chat_reported", "other:announcement"]);
  assert.deepEqual(sorted(await sees(ENROLLED)), sorted(["own:announcement", "own:chat_dm", "own:chat_message", "own:direct_message"]));
  assert.deepEqual(sorted(await sees(STAFF)), sorted(["own:chat_reported", "own:dm_reported"]));
});

test("presence and typing topics: who may listen and send", async () => {
  const db = await setup();
  await db.exec(migration);
  await db.exec(migration);
  const team = await channelId(db, `team:${TEAM_A}`);
  const typing = (id: string) => `chat-typing:${id}`;
  // A message on every topic, as Realtime would store one.
  await db.exec(`insert into realtime.messages (topic, extension) values
    ('chat-presence', 'presence'), ('${typing(team)}', 'broadcast'), ('${typing(DM_OLD)}', 'broadcast'), ('somebody-else', 'broadcast')`);
  const listens = async (uid: string, topic: string) =>
    (await asUser(db, uid, `select 1 from realtime.messages where topic = $1`, [topic], topic)).rows.length === 1;
  const sends = async (uid: string, topic: string, extension = "broadcast") => {
    try {
      await asUser(db, uid, `insert into realtime.messages (topic, extension) values ($1, $2)`, [topic, extension], topic);
      return true;
    } catch (err) {
      if (/row-level security/.test(String(err))) return false;
      throw err;
    }
  };
  assert.equal(await listens(ENROLLED, "chat-presence"), true);
  assert.equal(await sends(ENROLLED, "chat-presence", "presence"), true);
  assert.equal(await listens(FRESH, "chat-presence"), false, "an unvetted signup isn't in the directory, so not online either");
  assert.equal(await sends(FRESH, "chat-presence", "presence"), false);
  assert.equal(await listens(ENROLLED, typing(team)), true);
  assert.equal(await sends(MENTOR, typing(team)), true, "a mentor assigned to the team reads it");
  assert.equal(await listens(OTHER, typing(team)), false);
  assert.equal(await sends(OTHER, typing(team)), false);
  assert.equal(await listens(MENTOR, typing(DM_OLD)), true);
  assert.equal(await sends(ADMIN, typing(DM_OLD)), false, "no staff path into an unreported DM");
  assert.equal(await listens(ENROLLED, "somebody-else"), false, "not chat's topic");
  assert.equal(await sends(ENROLLED, "chat-typing:not-a-uuid"), false, "refused, not an error");
  assert.equal(await sends(ENROLLED, typing(team), "postgres_changes"), false);
});

test("with pg_trgm installed, search gets a trigram index", async () => {
  const db = await setup({ trgm: true });
  await db.exec(`create extension if not exists pg_trgm`);
  await db.exec(migration);
  await db.exec(migration);
  const idx = await db.query<{ indexdef: string }>(`select indexdef from pg_indexes where indexname = 'chat_messages_body_trgm'`);
  assert.equal(idx.rows.length, 1);
  assert.match(idx.rows[0].indexdef, /gin \(body gin_trgm_ops\) WHERE \(\(deleted_at IS NULL\) AND \(kind = 'message'::text\)\)/);
  // Without it, 0101 still applies (the other tests): search just isn't indexed.
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
