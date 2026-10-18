import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { MIGRATION_CHECKS } from "./migration-plan.ts";
import { MIGRATION_PROBES } from "./pending-migrations.ts";

/**
 * Migration 0110 (Chat threads and #help's questions), executed for real on
 * top of 0101 and 0104 in a throwaway Postgres. What only the database can
 * promise is asserted here:
 *
 *   - a reply's root is in the reply's own channel, one level deep, in a text
 *     channel, a live person's message — whoever writes the row;
 *   - thread replies don't touch the channel's summary or unread counts;
 *   - reply counts follow inserts and deletes; the replier and the root's
 *     author follow, and an unfollow sticks;
 *   - #help's top-level posts from outside the team are open questions;
 *   - an accepted answer must be a live reply in that thread, and deleting it
 *     reopens the question in the same statement; deleting the question
 *     retires it; every transition is in the append-only audit trail;
 *   - the new tables are the service role's alone, and a reply is read by
 *     exactly who reads its channel;
 *   - deleting a channel full of threads still works;
 *   - the verify query in lib/migration-plan.ts tells before from after, and
 *     notices a re-run of 0101.
 *
 * The fixture is the slice of 0001..0100 that 0101 needs (as in
 * lib/chat-migration-db.test.ts, without the optional history tables), plus a
 * stand-in support_tickets for the help request's foreign key.
 */

const chat = await readFile(new URL("../supabase/migrations/0101_chat.sql", import.meta.url), "utf8");
const clientIds = await readFile(new URL("../supabase/migrations/0104_chat_client_ids.sql", import.meta.url), "utf8");
const threads = await readFile(new URL("../supabase/migrations/0110_chat_threads.sql", import.meta.url), "utf8");

const ADMIN = "a0000000-0000-4000-8000-000000000001";
const STAFF = "a0000000-0000-4000-8000-000000000002";
const MENTOR = "a0000000-0000-4000-8000-000000000003";
const ENROLLED = "a0000000-0000-4000-8000-000000000004";
const ACCEPTED = "a0000000-0000-4000-8000-000000000005";
const OTHER = "a0000000-0000-4000-8000-000000000007";
const COHORT_A = "c0000000-0000-4000-8000-00000000000a";
const COHORT_B = "c0000000-0000-4000-8000-00000000000b";
const TEAM_A = "d0000000-0000-4000-8000-00000000000a";

async function setup({ withTickets = true } = {}) {
  const db = new PGlite();
  await db.exec(`
    create schema if not exists auth;
    do $$ begin
      if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon; end if;
      if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated; end if;
      if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role bypassrls; end if;
    end $$;
    grant usage on schema public to anon, authenticated, service_role;
    grant usage on schema auth to anon, authenticated, service_role;
    -- Supabase's default grants on later tables: the revokes must take them away.
    alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
    create or replace function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    create or replace function public.touch_updated_at() returns trigger language plpgsql as $$
    begin new.updated_at = now(); return new; end; $$;

    create table public.app_roles (slug text primary key, permissions text[] not null default '{}');
    insert into public.app_roles (slug, permissions) values
      ('admin', array['*']), ('student', array['student.dashboard']), ('mentor', array['mentor.panel']),
      ('community', array['chat.manage']);
    create table public.profiles (
      id uuid primary key, email text, full_name text, role text not null default 'student',
      stripe_customer_id text,
      discord_user_id text, discord_username text, discord_avatar text, discord_linked_at timestamptz,
      discord_introduced_at timestamptz, discord_first_rsvp_at timestamptz, discord_onboarded_nudged_at timestamptz);
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
      cohort_id uuid references public.cohorts(id) on delete cascade, slug text not null, name text not null,
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

    insert into public.profiles (id, email, full_name, role) values
      ('${ADMIN}', 'admin@x', 'Admin', 'admin'),
      ('${STAFF}', 'staff@x', 'Staff', 'community'),
      ('${MENTOR}', 'mentor@x', 'Mentor', 'mentor'),
      ('${ENROLLED}', 'e@x', 'Enrolled', 'student'),
      ('${ACCEPTED}', 'a@x', 'Accepted', 'student'),
      ('${OTHER}', 'o@x', 'Other', 'student');
    insert into public.cohorts (id, name, status) values
      ('${COHORT_A}', 'Fall 2026', 'active'), ('${COHORT_B}', 'Winter 2027', 'upcoming');
    insert into public.teams (id, cohort_id, slug, name) values ('${TEAM_A}', '${COHORT_A}', 'acme', 'Acme');
    insert into public.team_members (team_id, user_id) values ('${TEAM_A}', '${ENROLLED}');
    insert into public.enrollments (user_id, cohort_id) values ('${ENROLLED}', '${COHORT_A}'), ('${OTHER}', '${COHORT_B}');
    insert into public.applications (user_id, status) values ('${ACCEPTED}', 'accepted');
  `);
  if (withTickets) {
    // A stand-in for 0090's table: only the key the help request points at.
    await db.exec(`create table public.support_tickets (id uuid primary key default gen_random_uuid(), status text not null default 'open');`);
  }
  await db.exec(chat);
  await db.exec(clientIds);
  return db;
}

async function asUser<T = any>(db: PGlite, uid: string, sql: string) {
  await db.exec(`set role authenticated; select set_config('request.jwt.claim.sub', '${uid}', false);`);
  try {
    return await db.query<T>(sql);
  } finally {
    await db.exec(`reset role; select set_config('request.jwt.claim.sub', '', false);`);
  }
}

async function channelId(db: PGlite, systemKey: string): Promise<string> {
  const { rows } = await db.query<{ id: string }>(`select id from public.chat_channels where system_key = $1`, [systemKey]);
  assert.equal(rows.length, 1, `channel ${systemKey}`);
  return rows[0].id;
}

let n = 0;
const mid = () => `90000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;

/** Insert a message (optionally a thread reply) and return its id. */
async function post(
  db: PGlite,
  channel: string,
  sender: string | null,
  body: string,
  opts: { root?: string; replyTo?: string; kind?: string; at?: string; everyone?: boolean } = {},
): Promise<string> {
  const id = mid();
  await db.query(
    `insert into public.chat_messages (id, channel_id, sender_id, body, thread_root_id, reply_to_id, kind, created_at, mention_everyone)
     values ($1, $2, $3, $4, $5, $6, $7, coalesce($8::timestamptz, now()), $9)`,
    [id, channel, sender, body, opts.root ?? null, opts.replyTo ?? null, opts.kind ?? "message", opts.at ?? null, !!opts.everyone],
  );
  return id;
}

const del = (db: PGlite, id: string, by: string | null = null) =>
  db.query(`update public.chat_messages set body = '', attachments = '[]', deleted_at = now(), deleted_by = $2 where id = $1`, [id, by]);

const thread = async (db: PGlite, root: string) =>
  (await db.query<any>(`select reply_count, last_reply_at, question, answer_id, question_changed_by from public.chat_threads where root_id = $1`, [root])).rows[0];

const events = async (db: PGlite, root: string) =>
  (
    await db.query<{ action: string; actor_id: string | null; from_state: string | null; to_state: string | null; answer_id: string | null }>(
      `select action, actor_id, from_state, to_state, answer_id from public.chat_thread_events where root_id = $1 order by seq`,
      [root],
    )
  ).rows;

const verified = async (db: PGlite) => (await db.query<{ ok: boolean }>(MIGRATION_CHECKS["0110"])).rows[0]?.ok === true;

test("0110 applies twice on top of 0101 and 0104; its verify query tells before from after, and notices 0101 run again", async () => {
  const db = await setup();
  assert.equal(await verified(db), false);
  // The admin Overview's "run migration 0110" probe: missing before, satisfied after.
  const probes = MIGRATION_PROBES.filter((p) => p.migration === "0110");
  assert.ok(probes.length > 0);
  for (const p of probes) await assert.rejects(db.query(`select ${p.columns} from public.${p.table} limit 0`), /does not exist/);
  await db.exec(threads);
  await db.exec(threads);
  assert.equal(await verified(db), true);
  for (const p of probes) await db.query(`select ${p.columns} from public.${p.table} limit 0`);
  // 0101 again re-creates chat_unread without the thread clause and takes the
  // column grant away: the check says so, and 0110 again puts both back.
  await db.exec(chat);
  assert.equal(await verified(db), false);
  await db.exec(threads);
  assert.equal(await verified(db), true);
  // Where support_tickets doesn't exist, it still applies (no help-request key).
  const bare = await setup({ withTickets: false });
  await bare.exec(threads);
  assert.equal(await verified(bare), true);
});

test("a reply's root is in its own channel, one level deep, in a text channel, a live person's message", async () => {
  const db = await setup();
  await db.exec(threads);
  const help = await channelId(db, "help");
  const general = await channelId(db, "general");
  const root = await post(db, help, ENROLLED, "How do I recruit interviewees?");
  const reply = await post(db, help, ACCEPTED, "Start with your own network", { root });

  // Another channel's message is never a root, whoever writes the row.
  await assert.rejects(post(db, general, ACCEPTED, "cross-posted", { root }), (e: any) => e?.code === "23503");
  // One level: a reply can't start a thread of its own.
  await assert.rejects(post(db, help, OTHER, "nested", { root: reply }), /one level/);
  // A system line, or a deleted message, takes no replies.
  const line = await post(db, help, null, "Maya pinned a message.", { kind: "system" });
  await assert.rejects(post(db, help, OTHER, "re: pin", { root: line }), /can't take replies/);
  const gone = await post(db, help, OTHER, "never mind");
  await del(db, gone, OTHER);
  await assert.rejects(post(db, help, ACCEPTED, "too late", { root: gone }), /can't take replies/);
  // DMs and groups have no threads.
  await db.exec(`insert into public.chat_channels (id, kind, audience) values ('b0000000-0000-4000-8000-0000000000aa', 'group', 'members')`);
  const g = "b0000000-0000-4000-8000-0000000000aa";
  const groupRoot = await post(db, g, ENROLLED, "hi group");
  await assert.rejects(post(db, g, ACCEPTED, "thread?", { root: groupRoot }), /text channels/);
  // A reply can't ping everyone, and can't move threads.
  const loud = await post(db, help, STAFF, "@everyone look", { root, everyone: true });
  assert.equal((await db.query<any>(`select mention_everyone from public.chat_messages where id = $1`, [loud])).rows[0].mention_everyone, false);
  await assert.rejects(db.query(`update public.chat_messages set thread_root_id = null where id = $1`, [reply]), /move into or out of a thread/);
  await assert.rejects(db.query(`update public.chat_messages set thread_root_id = $2 where id = $1`, [line, root]), /move into or out of a thread/);
});

test("thread replies count on the thread, never on the channel: summary, unread and mentions stay the feed's", async () => {
  const db = await setup();
  await db.exec(threads);
  const general = await channelId(db, "general");
  const root = await post(db, general, ENROLLED, "Anyone tried cold email?", { at: "2026-10-17T10:00:00Z" });
  const before = (await db.query<any>(`select message_count, last_message_at, last_message_preview from public.chat_channels where id = $1`, [general])).rows[0];
  const r1 = await post(db, general, ACCEPTED, `<@${OTHER}> yes, works`, { root, at: "2026-10-17T10:05:00Z" });
  await db.query(`update public.chat_messages set mentions = array['${OTHER}']::uuid[] where id = $1`, [r1]);
  const r2 = await post(db, general, MENTOR, "Keep it short", { root, at: "2026-10-17T10:06:00Z" });
  const after = (await db.query<any>(`select message_count, last_message_at, last_message_preview from public.chat_channels where id = $1`, [general])).rows[0];
  assert.deepEqual(after, before, "the channel's summary is its feed's");

  const unread = (await db.query<any>(`select unread, mentions from public.chat_unread($1, array[$2]::uuid[])`, [OTHER, general])).rows[0];
  assert.deepEqual(unread, { unread: 1, mentions: 0 }, "the root counts; the replies, and the mention in one, don't");

  let t = await thread(db, root);
  assert.equal(t.reply_count, 2);
  assert.equal(new Date(t.last_reply_at).toISOString(), "2026-10-17T10:06:00.000Z");
  // Deleting the newest reply takes it off the count, and the last reply is the one before.
  await del(db, r2, MENTOR);
  t = await thread(db, root);
  assert.equal(t.reply_count, 1);
  assert.equal(new Date(t.last_reply_at).toISOString(), "2026-10-17T10:05:00.000Z");
  await del(db, r1, ACCEPTED);
  t = await thread(db, root);
  assert.equal(t.reply_count, 0);
  assert.equal(t.last_reply_at, null);
  // A deleted root still deletes like any message, and its channel summary moves.
  await del(db, root, ENROLLED);
  const end = (await db.query<any>(`select message_count from public.chat_channels where id = $1`, [general])).rows[0];
  assert.equal(end.message_count, 0);
});

test("the replier and the root's author follow; an unfollow sticks through another reply", async () => {
  const db = await setup();
  await db.exec(threads);
  const general = await channelId(db, "general");
  const root = await post(db, general, ENROLLED, "Pitch feedback?");
  const follows = async () =>
    (await db.query<{ user_id: string; state: string | null }>(`select user_id, state from public.chat_thread_follows where root_id = $1 order by user_id`, [root])).rows;
  // Someone who only had it open (a seen stamp, no choice made) is not following.
  await db.query(`insert into public.chat_thread_follows (root_id, user_id, seen_at) values ($1, $2, now())`, [root, OTHER]);
  await post(db, general, ACCEPTED, "Send it over", { root });
  assert.deepEqual(await follows(), [
    { user_id: ENROLLED, state: "following" },
    { user_id: ACCEPTED, state: "following" },
    { user_id: OTHER, state: null },
  ]);
  // ACCEPTED unfollows; replying again doesn't undo it. OTHER replies, and now follows.
  await db.query(`update public.chat_thread_follows set state = 'muted' where root_id = $1 and user_id = $2`, [root, ACCEPTED]);
  await post(db, general, ACCEPTED, "One more thing", { root });
  await post(db, general, OTHER, "Me too", { root });
  assert.deepEqual(await follows(), [
    { user_id: ENROLLED, state: "following" },
    { user_id: ACCEPTED, state: "muted" },
    { user_id: OTHER, state: "following" },
  ]);
});

test("#help: a top-level post from outside the team is an open question; the team's, quotes and other channels aren't", async () => {
  const db = await setup();
  await db.exec(threads);
  const help = await channelId(db, "help");
  const general = await channelId(db, "general");
  const asked = await post(db, help, ENROLLED, "How do I price a pilot?");
  const staffPost = await post(db, help, STAFF, "Office hours moved to 4pm");
  const quote = await post(db, help, ACCEPTED, "Try $500", { replyTo: asked });
  const elsewhere = await post(db, general, ENROLLED, "Not a question here");
  assert.equal((await thread(db, asked)).question, "open");
  for (const id of [staffPost, quote, elsewhere]) assert.equal(await thread(db, id), undefined);
  assert.deepEqual(await events(db, asked), [{ action: "asked", actor_id: ENROLLED, from_state: null, to_state: "open", answer_id: null }]);
});

test("an accepted answer is a live reply in that thread; deleting it reopens the question in the same statement", async () => {
  const db = await setup();
  await db.exec(threads);
  const help = await channelId(db, "help");
  const q = await post(db, help, ENROLLED, "Where do I find the interview script?");
  const answer = await post(db, help, MENTOR, "Week 2, lesson 3", { root: q });
  const otherQ = await post(db, help, OTHER, "Different question");
  const elsewhere = await post(db, help, ACCEPTED, "Wrong thread", { root: otherQ });
  const accept = (id: string, by = ENROLLED) =>
    db.query(`update public.chat_threads set question = 'answered', answer_id = $2, question_changed_by = $3, question_changed_at = now() where root_id = $1`, [q, id, by]);

  // A reply from another thread, the question itself, or a deleted reply: refused.
  await assert.rejects(accept(elsewhere), /reply in that thread/);
  await assert.rejects(accept(q), /reply in that thread/);
  const deleted = await post(db, help, ACCEPTED, "oops", { root: q });
  await del(db, deleted, ACCEPTED);
  await assert.rejects(accept(deleted), /reply in that thread/);
  // An answer needs an answered question.
  await assert.rejects(
    db.query(`update public.chat_threads set question = 'open', answer_id = $2 where root_id = $1`, [q, answer]),
    /chat_threads_answer_needs_answered/,
  );

  await accept(answer);
  assert.deepEqual(
    { question: (await thread(db, q)).question, answer: (await thread(db, q)).answer_id },
    { question: "answered", answer },
  );
  // The answer is deleted: open again, by nobody, in the delete's own statement.
  await del(db, answer, MENTOR);
  const t = await thread(db, q);
  assert.deepEqual({ question: t.question, answer: t.answer_id, by: t.question_changed_by }, { question: "open", answer: null, by: null });
  assert.deepEqual(
    (await events(db, q)).map((e) => [e.action, e.actor_id, e.from_state, e.to_state]),
    [
      ["asked", ENROLLED, null, "open"],
      ["accepted", ENROLLED, "open", "answered"],
      ["answer_removed", null, "answered", "open"],
    ],
  );
});

test("every question transition is logged, by whom; the log is append-only; deleting the question retires it", async () => {
  const db = await setup();
  await db.exec(threads);
  const help = await channelId(db, "help");
  const q = await post(db, help, ENROLLED, "Is the demo day deck template up?");
  const reply = await post(db, help, ACCEPTED, "Resources tab", { root: q });
  const set = (sql: string) => db.query(`update public.chat_threads set ${sql}, question_changed_at = now() where root_id = $1`, [q]);
  await set(`question = 'answered', question_changed_by = '${STAFF}'`);
  await set(`question = 'open', question_changed_by = '${ENROLLED}'`);
  await set(`question = 'answered', answer_id = '${reply}', question_changed_by = '${ENROLLED}'`);
  await set(`question = 'open', answer_id = null, question_changed_by = '${STAFF}'`);
  await set(`question = null, question_changed_by = '${ENROLLED}'`);
  await set(`question = 'open', question_changed_by = '${ENROLLED}'`);
  await del(db, q, ENROLLED);
  assert.deepEqual(
    (await events(db, q)).map((e) => [e.action, e.actor_id]),
    [
      ["asked", ENROLLED],
      ["marked_answered", STAFF],
      ["reopened", ENROLLED],
      ["accepted", ENROLLED],
      ["reopened", STAFF],
      ["unmarked", ENROLLED],
      ["asked", ENROLLED],
      ["question_removed", null],
    ],
  );
  assert.equal((await thread(db, q)).question, null);
  // Nobody rewrites the record — not even the service role…
  await assert.rejects(db.query(`update public.chat_thread_events set action = 'asked' where root_id = $1`, [q]), /append-only/);
  // …but an actor's account can still be deleted: their rows keep, unattributed.
  await db.exec(`delete from public.chat_thread_follows where user_id = '${STAFF}'`);
  await db.query(`update public.chat_threads set question_changed_by = null where question_changed_by = $1`, [STAFF]);
  await db.query(`delete from public.profiles where id = $1`, [STAFF]);
  assert.equal((await events(db, q)).filter((e) => e.actor_id === null).length, 3);
});

test("readers of the channel read its replies and their thread_root_id; nobody signed in reads the thread tables", async () => {
  const db = await setup();
  await db.exec(threads);
  const team = await channelId(db, `team:${TEAM_A}`);
  const root = await post(db, team, ENROLLED, "Team: who's calling the vendor?");
  const reply = await post(db, team, MENTOR, "I will", { root });
  // The team's member reads the reply, with its root (Realtime routes it by that).
  const seen = await asUser(db, ENROLLED, `select id, thread_root_id from public.chat_messages where id = '${reply}'`);
  assert.deepEqual(seen.rows, [{ id: reply, thread_root_id: root }]);
  // Someone on another cohort's team reads neither the root nor the reply, by id or at all.
  assert.equal((await asUser(db, OTHER, `select id from public.chat_messages where id in ('${root}', '${reply}')`)).rows.length, 0);
  // Following a thread grants nothing: a follow row for an outsider changes no read.
  await db.query(`insert into public.chat_thread_follows (root_id, user_id, state) values ($1, $2, 'following')`, [root, OTHER]);
  assert.equal((await asUser(db, OTHER, `select id from public.chat_messages where thread_root_id = '${root}'`)).rows.length, 0);
  // The thread tables are the service role's: counts, follows and the audit trail.
  for (const table of ["chat_threads", "chat_thread_follows", "chat_thread_events"]) {
    await assert.rejects(asUser(db, ENROLLED, `select * from public.${table}`), /permission denied/, table);
  }
});

test("a help request links one Support ticket to one thread, and a deleted ticket unlinks", async () => {
  const db = await setup();
  await db.exec(threads);
  const help = await channelId(db, "help");
  const q1 = await post(db, help, ENROLLED, "Stuck on the market sizing worksheet");
  const q2 = await post(db, help, OTHER, "Stuck too");
  const T = "5e000000-0000-4000-8000-000000000001";
  await db.exec(`insert into public.support_tickets (id) values ('${T}')`);
  await db.query(`update public.chat_threads set help_ticket_id = $2 where root_id = $1`, [q1, T]);
  await assert.rejects(db.query(`update public.chat_threads set help_ticket_id = $2 where root_id = $1`, [q2, T]), /chat_threads_help_ticket_idx/);
  await assert.rejects(
    db.query(`update public.chat_threads set help_ticket_id = '5e000000-0000-4000-8000-0000000000ff' where root_id = $1`, [q2]),
    /chat_threads_help_ticket_id_fkey/,
  );
  await db.exec(`delete from public.support_tickets where id = '${T}'`);
  assert.equal((await db.query<any>(`select help_ticket_id from public.chat_threads where root_id = $1`, [q1])).rows[0].help_ticket_id, null);
});

test("deleting a channel full of threads, answers, follows and history still works", async () => {
  const db = await setup();
  await db.exec(threads);
  await db.exec(`insert into public.chat_channels (id, kind, name, audience) values ('b0000000-0000-4000-8000-0000000000bb', 'channel', 'scratch', 'everyone')`);
  const c = "b0000000-0000-4000-8000-0000000000bb";
  const root = await post(db, c, ENROLLED, "Question?");
  const answer = await post(db, c, MENTOR, "Answer", { root });
  await post(db, c, ACCEPTED, "Thanks", { root, replyTo: answer });
  await db.query(`update public.chat_threads set question = 'answered', answer_id = $2, question_changed_by = $3 where root_id = $1`, [root, answer, ENROLLED]);
  await db.exec(`delete from public.chat_channels where id = '${c}'`);
  for (const table of ["chat_messages", "chat_threads"]) {
    assert.equal((await db.query<any>(`select count(*)::int as n from public.${table} where channel_id = $1`, [c])).rows[0].n, 0, table);
  }
  assert.equal((await db.query<any>(`select count(*)::int as n from public.chat_thread_events where root_id = $1`, [root])).rows[0].n, 0);
  assert.equal((await db.query<any>(`select count(*)::int as n from public.chat_thread_follows where root_id = $1`, [root])).rows[0].n, 0);
});
