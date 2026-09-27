import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";

/**
 * Migration 0089 (direct messages), executed for real against a throwaway
 * Postgres — applied, re-applied, and then queried AS a signed-in user.
 *
 * Unlike the other migration tests, auth.uid() here reads a session setting,
 * so the policies' decisions are asserted, not just their syntax. That is the
 * point: every DM write goes through a service-role server action, so the
 * only thing these policies may grant a signed-in user is READ access to
 * their own conversations. A write policy would let anyone skip the block
 * check, the rate limits and the notification logic over PostgREST, and an
 * update policy on a conversation let a participant rewrite `user_b` and
 * hand the other person's messages to a third account.
 */

const migration = await readFile(
  new URL("../supabase/migrations/0089_direct_messages.sql", import.meta.url),
  "utf8",
);

const ALICE = "11111111-1111-4111-8111-111111111111";
const BOB = "22222222-2222-4222-8222-222222222222";
const EVE = "33333333-3333-4333-8333-333333333333";
const MOD = "44444444-4444-4444-8444-444444444444";

async function setup() {
  const db = new PGlite();
  await db.exec(`
    create schema if not exists auth;
    do $$ begin
      if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon; end if;
      if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated; end if;
    end $$;

    -- The signed-in user, as PostgREST would set it.
    create or replace function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    grant usage on schema auth to anon, authenticated;

    -- Supabase's default privileges: every table and function a later
    -- migration creates in public is granted to both API roles. Without this
    -- the revokes and the missing write policies would pass vacuously.
    grant usage on schema public to anon, authenticated;
    alter default privileges in schema public grant all on tables to anon, authenticated;
    alter default privileges in schema public grant execute on functions to anon, authenticated;

    create table public.profiles (id uuid primary key, full_name text, role text default 'student');
    create or replace function public.is_admin(uid uuid) returns boolean language sql stable as $$
      select exists (select 1 from public.profiles where id = uid and role = 'admin') $$;
    create or replace function public.has_permission(uid uuid, perm text) returns boolean language sql stable as $$
      select false $$;
    create or replace function public.touch_updated_at() returns trigger language plpgsql as $$
      begin new.updated_at = now(); return new; end $$;

    create publication supabase_realtime;
    create table public.notifications (
      id uuid primary key default gen_random_uuid(),
      user_id uuid not null,
      type text not null,
      title text not null,
      body text,
      link text
    );

    insert into public.profiles (id, full_name, role) values
      ('${ALICE}', 'Alice', 'student'),
      ('${BOB}', 'Bob', 'mentor'),
      ('${EVE}', 'Eve', 'student'),
      ('${MOD}', 'Mod', 'admin');
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

/** A conversation between Alice and Bob with two messages, written as the owner (the service role). */
async function seedConversation(db: PGlite) {
  const { rows } = await db.query<{ id: string }>(
    `insert into public.dm_conversations (user_a, user_b) values ($1, $2) returning id`,
    [ALICE, BOB],
  );
  const id = rows[0].id;
  await db.query(
    `insert into public.dm_messages (conversation_id, sender_id, body, created_at) values
       ($1, $2, 'hi bob', now() - interval '1 minute'),
       ($1, $3, 'hey alice', now())`,
    [id, ALICE, BOB],
  );
  return id;
}

test("0089 applies, and re-applies", async () => {
  const db = await setup();
  await db.exec(migration);
  const { rows } = await db.query<any>(
    `select count(*)::int as n from information_schema.tables where table_schema = 'public' and table_name like 'dm\\_%'`,
  );
  assert.equal(rows[0].n, 4);
  const { rows: pub } = await db.query<any>(
    `select tablename from pg_publication_tables where pubname = 'supabase_realtime'`,
  );
  assert.deepEqual(pub.map((r) => r.tablename), ["dm_messages"]);
});

test("signed-in users hold read policies only", async () => {
  const db = await setup();
  const { rows } = await db.query<any>(
    `select tablename, cmd from pg_policies where tablename like 'dm\\_%' order by tablename, cmd`,
  );
  assert.ok(rows.length > 0);
  for (const r of rows) assert.equal(r.cmd, "SELECT", `${r.tablename} has a ${r.cmd} policy`);
});

test("a participant reads their conversation; nobody else does, staff included until it is reported", async () => {
  const db = await setup();
  const id = await seedConversation(db);

  for (const uid of [ALICE, BOB]) {
    const { rows } = await as(db, uid, `select body from public.dm_messages where conversation_id = $1`, [id]);
    assert.equal(rows.length, 2, "participant sees both messages");
  }
  for (const uid of [EVE, MOD]) {
    const c = await as(db, uid, `select id from public.dm_conversations where id = $1`, [id]);
    const m = await as(db, uid, `select id from public.dm_messages where conversation_id = $1`, [id]);
    assert.equal(c.rows.length + m.rows.length, 0, `${uid} must not see an unreported DM`);
  }

  await db.query(`insert into public.dm_reports (conversation_id, reporter_id, reason) values ($1, $2, 'spam')`, [id, ALICE]);
  const { rows } = await as(db, MOD, `select id from public.dm_messages where conversation_id = $1`, [id]);
  assert.equal(rows.length, 2, "a moderator reads a reported DM");
  const eve = await as(db, EVE, `select id from public.dm_messages where conversation_id = $1`, [id]);
  assert.equal(eve.rows.length, 0, "a report opens it to staff, not to everyone");
});

test("no direct writes: a participant cannot send, re-point, forge or delete over PostgREST", async () => {
  const db = await setup();
  const id = await seedConversation(db);

  // Sending past the server action (and so past blocks and rate limits).
  await assert.rejects(
    as(db, ALICE, `insert into public.dm_messages (conversation_id, sender_id, body) values ($1, $2, 'spam')`, [id, ALICE]),
    /row-level security/,
  );
  // Opening a conversation past the new-conversation rate limit.
  await assert.rejects(
    as(db, EVE, `insert into public.dm_conversations (user_a, user_b) values ($1, $2)`, [ALICE, EVE]),
    /row-level security/,
  );
  // Re-pointing the conversation at a third account (would hand Bob's
  // messages to Eve), and forging the preview Bob sees. With no update
  // policy these match no rows rather than erroring.
  const moved = await as(db, ALICE, `update public.dm_conversations set user_b = $2 where id = $1 returning id`, [id, EVE]);
  assert.equal(moved.rows.length, 0);
  const forged = await as(db, ALICE, `update public.dm_conversations set last_message_preview = 'forged' where id = $1 returning id`, [id]);
  assert.equal(forged.rows.length, 0);
  // Deleting the other person's words, or a report, or a block.
  const del = await as(db, ALICE, `delete from public.dm_messages where conversation_id = $1 returning id`, [id]);
  assert.equal(del.rows.length, 0);
  await assert.rejects(
    as(db, ALICE, `insert into public.dm_blocks (blocker_id, blocked_id) values ($1, $2)`, [ALICE, BOB]),
    /row-level security/,
  );

  const { rows } = await db.query<any>(`select user_b, message_count, last_message_preview from public.dm_conversations where id = $1`, [id]);
  assert.equal(rows[0].user_b, BOB);
  assert.equal(rows[0].message_count, 2);
  assert.equal(rows[0].last_message_preview, "hey alice");
});

test("nobody can ask whether they have been blocked", async () => {
  const db = await setup();
  await db.query(`insert into public.dm_blocks (blocker_id, blocked_id) values ($1, $2)`, [BOB, ALICE]);
  // The RPC would answer "has Bob blocked me?" — which the design never reveals.
  await assert.rejects(as(db, ALICE, `select public.dm_is_blocked($1, $2)`, [ALICE, BOB]), /permission denied/);
  // …and the block row itself is only visible to the blocker.
  const alice = await as(db, ALICE, `select * from public.dm_blocks`);
  assert.equal(alice.rows.length, 0);
  const bob = await as(db, BOB, `select * from public.dm_blocks`);
  assert.equal(bob.rows.length, 1);
  // The service role (the owner here) still has it.
  const { rows } = await db.query<any>(`select public.dm_is_blocked($1, $2) as b`, [ALICE, BOB]);
  assert.equal(rows[0].b, true);
});

test("the read check only ever answers for the caller", async () => {
  const db = await setup();
  const id = await seedConversation(db);
  await db.query(`insert into public.dm_reports (conversation_id, reporter_id, reason) values ($1, $2, 'spam')`, [id, ALICE]);
  // No form of it takes a uid any more, so nobody can pass a moderator's id
  // and learn whether a conversation was reported.
  const { rows: fns } = await db.query<any>(
    `select pg_get_function_identity_arguments(p.oid) as args from pg_proc p where p.proname = 'dm_can_read_conversation'`,
  );
  assert.deepEqual(fns.map((f) => f.args), ["c dm_conversations"]);
  // Eve asking about a reported conversation she is not in gets "no".
  const { rows } = await as(
    db,
    EVE,
    `select public.dm_can_read_conversation(c) as ok from public.dm_conversations c where c.id = $1`,
    [id],
  );
  assert.equal(rows.length, 0, "she cannot even select the row to ask about");
  const crafted = await as(
    db,
    EVE,
    `select public.dm_can_read_conversation(row($1::uuid, $2::uuid, $3::uuid, 'epoch'::timestamptz, 'epoch'::timestamptz, null::timestamptz, null::text, null::uuid, 0, now(), now())::public.dm_conversations) as ok`,
    [id, ALICE, BOB],
  );
  assert.equal(crafted.rows[0].ok, false);
});

test("a DM notification never stores the message text; other notifications keep theirs", async () => {
  const db = await setup();
  await db.query(
    `insert into public.notifications (user_id, type, title, body) values
       ($1, 'direct_message', 'Alice messaged you', 'my secret'),
       ($1, 'announcement', 'Kickoff', 'see you at 6')`,
    [BOB],
  );
  const { rows } = await db.query<any>(`select type, body from public.notifications order by type`);
  assert.deepEqual(rows, [
    { type: "announcement", body: "see you at 6" },
    { type: "direct_message", body: null },
  ]);
  await db.query(`update public.notifications set body = 'sneaky' where type = 'direct_message'`);
  const { rows: after } = await db.query<any>(`select body from public.notifications where type = 'direct_message'`);
  assert.equal(after[0].body, null);
});

test("the trigger keeps the conversation summary right through sends and unsends", async () => {
  const db = await setup();
  const id = await seedConversation(db);
  let { rows } = await db.query<any>(
    `select message_count, last_message_preview, last_sender_id from public.dm_conversations where id = $1`,
    [id],
  );
  assert.equal(rows[0].message_count, 2);
  assert.equal(rows[0].last_message_preview, "hey alice");
  assert.equal(rows[0].last_sender_id, BOB);

  await db.query(`delete from public.dm_messages where conversation_id = $1 and sender_id = $2`, [id, BOB]);
  ({ rows } = await db.query<any>(
    `select message_count, last_message_preview, last_sender_id from public.dm_conversations where id = $1`,
    [id],
  ));
  assert.equal(rows[0].message_count, 1);
  assert.equal(rows[0].last_message_preview, "hi bob");
  assert.equal(rows[0].last_sender_id, ALICE);

  await db.query(`delete from public.dm_messages where conversation_id = $1`, [id]);
  ({ rows } = await db.query<any>(
    `select message_count, last_message_at, last_message_preview from public.dm_conversations where id = $1`,
    [id],
  ));
  assert.equal(rows[0].message_count, 0);
  assert.equal(rows[0].last_message_at, null);
  assert.equal(rows[0].last_message_preview, null);

  // A long body is previewed, not copied.
  await db.query(`insert into public.dm_messages (conversation_id, sender_id, body) values ($1, $2, $3)`, [id, ALICE, "x".repeat(500)]);
  ({ rows } = await db.query<any>(`select length(last_message_preview) as n from public.dm_conversations where id = $1`, [id]));
  assert.equal(rows[0].n, 140);
});

test("deleting one account keeps the other person's history and every report", async () => {
  const db = await setup();
  const id = await seedConversation(db);
  await db.query(`insert into public.dm_reports (conversation_id, reporter_id, reason) values ($1, $2, 'harassment')`, [id, ALICE]);
  await db.query(`delete from public.profiles where id = $1`, [BOB]);

  const { rows: c } = await db.query<any>(`select user_a, user_b, message_count from public.dm_conversations where id = $1`, [id]);
  assert.equal(c.length, 1, "the conversation survives");
  assert.deepEqual([c[0].user_a, c[0].user_b].sort(), [ALICE, null].sort());
  assert.equal(c[0].message_count, 2);
  const { rows: m } = await db.query<any>(`select sender_id from public.dm_messages where conversation_id = $1 order by created_at`, [id]);
  assert.deepEqual(m.map((r) => r.sender_id), [ALICE, null], "Bob's words stay, unattributed");
  const { rows: r } = await db.query<any>(`select count(*)::int as n from public.dm_reports where conversation_id = $1`, [id]);
  assert.equal(r[0].n, 1, "the report survives");
  // Alice still reads her side.
  const mine = await as(db, ALICE, `select id from public.dm_messages where conversation_id = $1`, [id]);
  assert.equal(mine.rows.length, 2);
});

test("a DM between two people is a singleton, stored as an ordered pair", async () => {
  const db = await setup();
  await seedConversation(db);
  await assert.rejects(db.query(`insert into public.dm_conversations (user_a, user_b) values ($1, $2)`, [ALICE, BOB]));
  await assert.rejects(db.query(`insert into public.dm_conversations (user_a, user_b) values ($1, $2)`, [BOB, ALICE]));
  await assert.rejects(db.query(`insert into public.dm_conversations (user_a, user_b) values ($1, $1)`, [EVE]));
  await assert.rejects(db.query(`insert into public.dm_blocks (blocker_id, blocked_id) values ($1, $1)`, [EVE]));
});
