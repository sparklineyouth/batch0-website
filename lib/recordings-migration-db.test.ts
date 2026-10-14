import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";

/**
 * Migration 0095 (recording takes), executed for real against a throwaway
 * Postgres, on top of the REAL 0059 and 0092 it reads through
 * is_call_participant — and queried AS each kind of person with RLS in force:
 * these are recordings of minors' calls, and who can read a row is the point.
 *
 * Covers: applies twice; the lease (one 'recording' row per room); the status
 * and kind CHECKs; staff with events.manage read webinar takes and not calls;
 * the people on a call (and admins) read its takes, nobody else does; nobody
 * signed in can write; the private bucket and its size limit.
 */

const SQL = (name: string) =>
  readFile(new URL(`../supabase/migrations/${name}`, import.meta.url), "utf8");
const [CALLS, COHOSTS, RECORDINGS] = await Promise.all([
  SQL("0059_call_invites.sql"),
  SQL("0092_call_cohosts.sql"),
  SQL("0095_recordings.sql"),
]);

const ADMIN = "aaaaaaaa-0000-4000-8000-000000000001";
const HOST = "aaaaaaaa-0000-4000-8000-000000000002";
const COHOST = "aaaaaaaa-0000-4000-8000-000000000003";
const STUDENT = "aaaaaaaa-0000-4000-8000-000000000004";
const OTHER_STUDENT = "aaaaaaaa-0000-4000-8000-000000000005";
const INTERN = "aaaaaaaa-0000-4000-8000-000000000006"; // events.manage only
const OTHER_MENTOR = "aaaaaaaa-0000-4000-8000-000000000007";
const EVENT = "bbbbbbbb-0000-4000-8000-000000000001";

const db = new PGlite();

async function q<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }> {
  return (await db.query(sql, params)) as { rows: T[] };
}

await db.exec(`
  create role anon; create role authenticated; create role service_role;
  create schema if not exists auth;
  create schema if not exists storage;
  create or replace function auth.uid() returns uuid language sql stable as $$
    select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  grant usage on schema auth to anon, authenticated;
  grant usage on schema public to anon, authenticated;
  alter default privileges in schema public grant all on tables to anon, authenticated;
  alter default privileges in schema public grant execute on functions to anon, authenticated;

  create table storage.buckets (
    id text primary key, name text, public boolean,
    file_size_limit bigint, allowed_mime_types text[]
  );

  create table public.profiles (id uuid primary key, full_name text, role text not null default 'student');
  create table public.app_roles (slug text primary key, permissions text[] not null default '{}');
  insert into public.app_roles values
    ('admin', array['*']),
    ('intern', array['events.manage']),
    ('mentor', array['mentor.panel', 'calls.invite']),
    ('student', array['student.dashboard']);
  create or replace function public.is_admin(uid uuid)
  returns boolean language sql stable security definer set search_path = public as $$
    select exists (select 1 from public.profiles p join public.app_roles r on r.slug = p.role
      where p.id = uid and r.permissions @> array['*']::text[]) $$;
  create or replace function public.has_permission(uid uuid, perm text)
  returns boolean language sql stable security definer set search_path = public as $$
    select exists (select 1 from public.profiles p join public.app_roles r on r.slug = p.role
      where p.id = uid and (r.permissions @> array['*']::text[] or r.permissions @> array[perm])) $$;
  create or replace function public.touch_updated_at()
  returns trigger language plpgsql as $$ begin new.updated_at = now(); return new; end $$;

  insert into public.profiles (id, full_name, role) values
    ('${ADMIN}', 'An Admin', 'admin'),
    ('${HOST}', 'Marcus Mentor', 'mentor'),
    ('${COHOST}', 'Priya Mentor', 'mentor'),
    ('${STUDENT}', 'Ana Student', 'student'),
    ('${OTHER_STUDENT}', 'Ben Student', 'student'),
    ('${INTERN}', 'Ivy Intern', 'intern'),
    ('${OTHER_MENTOR}', 'Other Mentor', 'mentor');
`);
await db.exec(CALLS);
await db.exec(COHOSTS);
await db.exec(RECORDINGS);

const CALL = (
  await q<{ id: string }>(
    `insert into public.call_invites (host_id, invitee_id, starts_at, status)
     values ($1, $2, now(), 'accepted') returning id`,
    [HOST, STUDENT],
  )
).rows[0].id;
await q(`insert into public.call_invite_cohosts (invite_id, profile_id) values ($1, $2)`, [CALL, COHOST]);
const OTHER_CALL = (
  await q<{ id: string }>(
    `insert into public.call_invites (host_id, invitee_id, starts_at, status)
     values ($1, $2, now(), 'accepted') returning id`,
    [OTHER_MENTOR, OTHER_STUDENT],
  )
).rows[0].id;

async function take(kind: string, room: string, status = "finished", by = HOST): Promise<string> {
  const { rows } = await q<{ id: string }>(
    `insert into public.recording_sessions (room_kind, room_id, status, started_by, mime, storage_prefix)
     values ($1::text, $2::uuid, $3::text, $4::uuid, 'video/webm;codecs=vp8,opus', 'p/' || $2::text) returning id`,
    [kind, room, status, by],
  );
  return rows[0].id;
}

/** Run `sql` as a signed-in user, with RLS in force. */
async function as<T = Record<string, unknown>>(uid: string, sql: string, params: unknown[] = []) {
  await db.exec(`set role authenticated; select set_config('request.jwt.claim.sub', '${uid}', false);`);
  try {
    return await q<T>(sql, params);
  } finally {
    await db.exec(`reset role; select set_config('request.jwt.claim.sub', '', false);`);
  }
}

async function refusal(run: () => Promise<unknown>): Promise<string | null> {
  try {
    await run();
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

test("0095 applies twice and creates the private bucket", async () => {
  await db.exec(RECORDINGS);
  await db.exec(RECORDINGS);
  const { rows } = await q<{ public: boolean; file_size_limit: string }>(
    `select public, file_size_limit from storage.buckets where id = 'recordings'`,
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].public, false);
  assert.ok(Number(rows[0].file_size_limit) >= 8 * 1024 * 1024, "holds a part");
  // A limit raised by hand is never lowered by a re-run.
  await q(`update storage.buckets set file_size_limit = 104857600 where id = 'recordings'`);
  await db.exec(RECORDINGS);
  const again = await q<{ file_size_limit: string }>(
    `select file_size_limit from storage.buckets where id = 'recordings'`,
  );
  assert.equal(Number(again.rows[0].file_size_limit), 104857600);
});

test("one take recording per room: the lease", async () => {
  const room = "cccccccc-0000-4000-8000-000000000001";
  const first = await take("webinar", room, "recording");
  const err = await refusal(() => take("webinar", room, "recording"));
  assert.match(err ?? "", /duplicate key|recording_sessions_one_active/);
  // Closed takes don't hold it; nor does the same id as a call room.
  await take("webinar", room, "finished");
  await take("call", room, "recording");
  await q(`update public.recording_sessions set status = 'interrupted' where id = $1`, [first]);
  await take("webinar", room, "recording");
});

test("status and kind are checked", async () => {
  assert.match((await refusal(() => take("webinar", EVENT, "paused"))) ?? "", /check constraint/);
  assert.match((await refusal(() => take("event", EVENT, "finished"))) ?? "", /check constraint/);
});

test("webinar takes: staff with events.manage read them, nobody else", async () => {
  const id = await take("webinar", EVENT);
  const sees = async (uid: string) =>
    (await as<{ id: string }>(uid, `select id from public.recording_sessions where id = $1`, [id])).rows.length;
  assert.equal(await sees(INTERN), 1);
  assert.equal(await sees(ADMIN), 1);
  assert.equal(await sees(STUDENT), 0);
  assert.equal(await sees(HOST), 0, "a mentor without events.manage");
});

test("call takes: the people on the call and admins, nobody else", async () => {
  const id = await take("call", CALL);
  const other = await take("call", OTHER_CALL, "finished", OTHER_MENTOR);
  const sees = async (uid: string) =>
    (await as<{ id: string }>(uid, `select id from public.recording_sessions where id in ($1, $2) order by id`, [id, other]))
      .rows.map((r) => r.id);
  assert.deepEqual(await sees(HOST), [id]);
  assert.deepEqual(await sees(COHOST), [id]);
  assert.deepEqual(await sees(STUDENT), [id]);
  assert.deepEqual(await sees(OTHER_STUDENT), [other]);
  assert.deepEqual(await sees(OTHER_MENTOR), [other]);
  assert.deepEqual(await sees(INTERN), [], "events.manage is not a key to calls");
  assert.deepEqual(await sees(ADMIN), [id, other].sort());
});

test("nobody signed in can write, and anon can't read", async () => {
  const id = await take("call", CALL);
  for (const uid of [HOST, ADMIN, STUDENT]) {
    assert.ok(
      await refusal(() =>
        as(uid, `insert into public.recording_sessions (room_kind, room_id, mime, storage_prefix) values ('call', $1, 'video/webm', 'x')`, [CALL]),
      ),
      `insert as ${uid}`,
    );
    assert.ok(await refusal(() => as(uid, `update public.recording_sessions set status = 'failed' where id = $1`, [id])), `update as ${uid}`);
    assert.ok(await refusal(() => as(uid, `delete from public.recording_sessions where id = $1`, [id])), `delete as ${uid}`);
  }
  await db.exec(`set role anon;`);
  try {
    assert.ok(await refusal(() => q(`select id from public.recording_sessions`)));
  } finally {
    await db.exec(`reset role;`);
  }
  const { rows } = await q<{ status: string }>(`select status from public.recording_sessions where id = $1`, [id]);
  assert.equal(rows[0].status, "finished");
});

test("the read predicate asks about the caller, never about anyone named", async () => {
  // can_view_recording takes a room, not a user: callable over /rpc, it can
  // only ever answer for whoever is signed in.
  const { rows } = await q<{ args: string }>(
    `select pg_get_function_identity_arguments('public.can_view_recording'::regproc) as args`,
  );
  assert.equal(rows[0].args, "p_kind text, p_room uuid");
  const mine = await as<{ ok: boolean }>(STUDENT, `select public.can_view_recording('call', $1) as ok`, [CALL]);
  const theirs = await as<{ ok: boolean }>(STUDENT, `select public.can_view_recording('call', $1) as ok`, [OTHER_CALL]);
  assert.equal(mine.rows[0].ok, true);
  assert.equal(theirs.rows[0].ok, false);
});

test("updated_at moves on update", async () => {
  const id = await take("webinar", "cccccccc-0000-4000-8000-000000000009");
  await q(`update public.recording_sessions set updated_at = now() - interval '1 hour' where id = $1`, [id]);
  await q(`update public.recording_sessions set part_count = 3 where id = $1`, [id]);
  const { rows } = await q<{ fresh: boolean }>(
    `select updated_at > now() - interval '1 minute' as fresh from public.recording_sessions where id = $1`,
    [id],
  );
  assert.equal(rows[0].fresh, true);
});
