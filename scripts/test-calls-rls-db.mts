/** Isolated PostgreSQL integration test for migration 0097; NEVER connects to
 * linked Supabase.
 *
 * Run: node --test scripts/test-calls-rls-db.mts
 * Requires @electric-sql/pglite (dev dependency), or set BATCH0_PGLITE_MODULE
 * to an absolute installed module path.
 *
 * Applies the REAL office-hours slice of 0011 (+0026), 0059, 0061, 0092 and
 * then 0097 (twice), and checks, as each kind of signed-in user with RLS in
 * force, that:
 *   - no client write policy is left on call_invites, call_invite_cohosts,
 *     interview_requests, mentor_bookings or mentor_slots, and re-running
 *     0097 changes nothing
 *   - nobody signed in (student, host, co-host, admin) can insert, update or
 *     delete those rows — the student repointing host_id is the attack
 *   - everyone who could read before still reads exactly what they did
 *   - mentor_slots no longer hands every signed-in user each zoom_url
 *   - the service role (the server actions) still writes all of it
 *   - notifications into the removed office-hours pages now open 1:1 calls
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

const packagePath = process.env.BATCH0_PGLITE_MODULE;
const moduleName = packagePath ? pathToFileURL(packagePath).href : "@electric-sql/pglite";
const { PGlite } = await import(moduleName);
const db = new PGlite();

async function q<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }> {
  return (await db.query(sql, params)) as { rows: T[] };
}

const ADMIN = "bbbbbbbb-0000-4000-8000-000000000001";
const HOST = "bbbbbbbb-0000-4000-8000-000000000002";
const COHOST = "bbbbbbbb-0000-4000-8000-000000000003";
const OTHER_MENTOR = "bbbbbbbb-0000-4000-8000-000000000004";
const STUDENT = "bbbbbbbb-0000-4000-8000-000000000005";
const OTHER_STUDENT = "bbbbbbbb-0000-4000-8000-000000000006";

const file = (name: string) =>
  readFile(new URL(`../supabase/migrations/${name}`, import.meta.url), "utf8");

/** 0011's office-hours section only: the rest of that file is other features. */
function officeHoursSlice(sql: string): string {
  const start = sql.indexOf("-- OFFICE HOURS");
  const end = sql.indexOf("-- COMPLETION CERTIFICATES");
  assert.ok(start > 0 && end > start, "0011 office-hours markers moved");
  return sql.slice(start, end).replace(/^-- =+$/gm, "");
}

// The slice of 0001..0096 these migrations depend on, plus a settable
// auth.uid() and Supabase's default grants, so a missing write policy (and a
// revoked privilege) is tested for real.
await db.exec(`
  create role anon; create role authenticated; create role service_role;
  create schema if not exists auth;
  create or replace function auth.uid() returns uuid language sql stable as $$
    select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  grant usage on schema auth to anon, authenticated;
  grant usage on schema public to anon, authenticated;
  alter default privileges in schema public grant all on tables to anon, authenticated;
  alter default privileges in schema public grant execute on functions to anon, authenticated;

  create table public.profiles (id uuid primary key, full_name text, role text not null default 'student');
  create table public.app_roles (slug text primary key, permissions text[] not null default '{}');
  insert into public.app_roles values
    ('admin', array['*']),
    ('mentor', array['mentor.panel', 'calls.invite']),
    ('investor', array['investor.panel', 'calls.invite']),
    ('student', array['student.dashboard']);
  create table public.cohorts (id uuid primary key default gen_random_uuid(), name text);
  create table public.notifications (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null,
    type text not null,
    link text
  );

  create or replace function public.is_admin(uid uuid)
  returns boolean language sql stable security definer set search_path = public as $$
    select exists (select 1 from public.profiles p join public.app_roles r on r.slug = p.role
                   where p.id = uid and r.permissions @> array['*']::text[]) $$;
  create or replace function public.has_permission(uid uuid, perm text)
  returns boolean language sql stable security definer set search_path = public as $$
    select exists (select 1 from public.profiles p join public.app_roles r on r.slug = p.role
                   where p.id = uid and (r.permissions @> array['*']::text[] or r.permissions @> array[perm])) $$;
  create or replace function public.is_mentor(uid uuid)
  returns boolean language sql stable security definer set search_path = public as $$
    select exists (select 1 from public.profiles where id = uid and role = 'mentor') $$;
  create or replace function public.touch_updated_at()
  returns trigger language plpgsql as $$ begin new.updated_at = now(); return new; end $$;

  insert into public.profiles (id, full_name, role) values
    ('${ADMIN}', 'An Admin', 'admin'),
    ('${HOST}', 'Marcus Mentor', 'mentor'),
    ('${COHOST}', 'Priya Investor', 'investor'),
    ('${OTHER_MENTOR}', 'Other Mentor', 'mentor'),
    ('${STUDENT}', 'Ana Student', 'student'),
    ('${OTHER_STUDENT}', 'Ben Student', 'student');
`);

await db.exec(officeHoursSlice(await file("0011_phase2_features.sql")));
await db.exec(await file("0026_booking_recaps.sql"));
await db.exec(await file("0059_call_invites.sql"));
await db.exec(await file("0061_interview_requests.sql"));
await db.exec(await file("0092_call_cohosts.sql"));

// Rows that exist before 0097, as in production.
const seeded = await q<{ call: string; req: string; slot: string; booking: string }>(`
  with call as (
    insert into public.call_invites (host_id, invitee_id, starts_at, topic, status)
    values ('${HOST}', '${STUDENT}', now() + interval '1 day', 'Pricing', 'invited') returning id
  ), co as (
    insert into public.call_invite_cohosts (invite_id, profile_id) select id, '${COHOST}' from call returning invite_id
  ), req as (
    insert into public.interview_requests (student_id, preferred_at, status)
    values ('${STUDENT}', now() + interval '2 days', 'requested') returning id
  ), slot as (
    insert into public.mentor_slots (mentor_id, starts_at, ends_at, zoom_url)
    values ('${HOST}', now() + interval '3 days', now() + interval '3 days 30 minutes', 'https://zoom.example/secret')
    returning id
  ), booking as (
    insert into public.mentor_bookings (slot_id, student_id, topic) select id, '${STUDENT}', 'Help' from slot returning id
  )
  select (select id from call) as call, (select id from req) as req,
         (select id from slot) as slot, (select id from booking) as booking,
         (select count(*) from co) as _co
`);
const { call: CALL, req: REQ, slot: SLOT, booking: BOOKING } = seeded.rows[0];
await q(
  `insert into public.notifications (user_id, type, link) values
     ($1, 'office_hours_recap', '/dashboard/office-hours'),
     ($2, 'office_hours_booked', '/mentor/office-hours?x=1'),
     ($1, 'call_invited', '/dashboard/calls')`,
  [STUDENT, HOST],
);

const MIGRATION = await file("0097_calls.sql");
await db.exec(MIGRATION);

/** Run `sql` as a signed-in user, with RLS in force. */
async function as<T = Record<string, unknown>>(uid: string, sql: string, params: unknown[] = []) {
  await db.exec(`set role authenticated; select set_config('request.jwt.claim.sub', '${uid}', false);`);
  try {
    return await q<T>(sql, params);
  } finally {
    await db.exec(`reset role; select set_config('request.jwt.claim.sub', '', false);`);
  }
}

/** The error a statement raises as `uid`, or null if it ran. */
async function refusal(uid: string, sql: string, params: unknown[] = []): Promise<string | null> {
  try {
    await as(uid, sql, params);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

const TABLES = [
  "call_invites",
  "call_invite_cohosts",
  "interview_requests",
  "mentor_bookings",
  "mentor_slots",
];

async function policies() {
  const { rows } = await q<{ tablename: string; policyname: string; cmd: string; qual: string | null }>(
    `select tablename, policyname, cmd, qual from pg_policies
      where tablename = any($1) order by tablename, policyname`,
    [TABLES],
  );
  return rows;
}

test("0097 leaves only read policies, and re-applies without changing anything", async () => {
  const before = await policies();
  assert.deepEqual(
    before.map((p) => `${p.tablename}: ${p.policyname} (${p.cmd})`),
    [
      "call_invite_cohosts: call_invite_cohosts read (SELECT)",
      "call_invites: call_invites read (SELECT)",
      "interview_requests: interview_requests read (SELECT)",
      "mentor_bookings: mentor_bookings read (SELECT)",
      "mentor_slots: mentor_slots read (SELECT)",
    ],
  );
  await db.exec(MIGRATION);
  await db.exec(MIGRATION);
  assert.deepEqual(await policies(), before);
  // The write privileges are gone for both API roles.
  const { rows } = await q<{ n: number }>(
    `select count(*)::int as n from information_schema.role_table_grants
      where table_schema = 'public' and table_name = any($1)
        and grantee in ('anon', 'authenticated')
        and privilege_type in ('INSERT', 'UPDATE', 'DELETE')`,
    [TABLES],
  );
  assert.equal(rows[0].n, 0);
});

test("the student can no longer rewrite their own call", async () => {
  for (const sql of [
    `update public.call_invites set host_id = '${OTHER_MENTOR}' where id = '${CALL}'`,
    `update public.call_invites set status = 'completed' where id = '${CALL}'`,
    `update public.call_invites set starts_at = now() where id = '${CALL}'`,
    `delete from public.call_invites where id = '${CALL}'`,
  ]) {
    const err = await refusal(STUDENT, sql);
    assert.match(err ?? "", /permission denied/i, sql);
  }
  const { rows } = await q<{ host_id: string; status: string }>(
    "select host_id, status from public.call_invites where id = $1",
    [CALL],
  );
  assert.deepEqual(rows[0], { host_id: HOST, status: "invited" });
});

test("nobody signed in writes calls, co-hosts or requests — staff included", async () => {
  for (const uid of [HOST, COHOST, ADMIN, STUDENT]) {
    const attempts = [
      `insert into public.call_invites (host_id, invitee_id, starts_at) values ('${uid}', '${OTHER_STUDENT}', now())`,
      `update public.call_invites set topic = 'x' where id = '${CALL}'`,
      `insert into public.call_invite_cohosts (invite_id, profile_id) values ('${CALL}', '${OTHER_MENTOR}')`,
      `delete from public.call_invite_cohosts where invite_id = '${CALL}'`,
      `insert into public.interview_requests (student_id, status) values ('${uid}', 'requested')`,
      `update public.interview_requests set status = 'scheduled' where id = '${REQ}'`,
    ];
    for (const sql of attempts) {
      assert.match((await refusal(uid, sql)) ?? "", /permission denied/i, `${uid}: ${sql}`);
    }
  }
});

test("office-hours rows are read-only history", async () => {
  for (const uid of [STUDENT, HOST, ADMIN]) {
    for (const sql of [
      `update public.mentor_bookings set recap_notes = 'x', status = 'completed' where id = '${BOOKING}'`,
      `insert into public.mentor_bookings (slot_id, student_id) values ('${SLOT}', '${uid}')`,
      `update public.mentor_slots set zoom_url = 'https://evil.example' where id = '${SLOT}'`,
      `delete from public.mentor_slots where id = '${SLOT}'`,
    ]) {
      assert.match((await refusal(uid, sql)) ?? "", /permission denied/i, `${uid}: ${sql}`);
    }
  }
});

test("everyone who could read still reads exactly their own", async () => {
  const sees = async (uid: string, sql: string, params: unknown[] = []) =>
    (await as(uid, sql, params)).rows.length;
  const call = "select id from public.call_invites where id = $1";
  const team = "select profile_id from public.call_invite_cohosts where invite_id = $1";
  for (const uid of [STUDENT, HOST, COHOST, ADMIN]) {
    assert.equal(await sees(uid, call, [CALL]), 1, `${uid} reads the call`);
    assert.equal(await sees(uid, team, [CALL]), 1, `${uid} reads who is on it`);
  }
  for (const uid of [OTHER_STUDENT, OTHER_MENTOR]) {
    assert.equal(await sees(uid, call, [CALL]), 0, `${uid} sees no call`);
    assert.equal(await sees(uid, team, [CALL]), 0, `${uid} sees no team`);
  }

  const req = "select id from public.interview_requests where id = $1";
  assert.equal(await sees(STUDENT, req, [REQ]), 1);
  assert.equal(await sees(ADMIN, req, [REQ]), 1);
  assert.equal(await sees(HOST, req, [REQ]), 1, "calls.invite holders read the queue");
  assert.equal(await sees(OTHER_STUDENT, req, [REQ]), 0);

  const booking = "select id from public.mentor_bookings where id = $1";
  assert.equal(await sees(STUDENT, booking, [BOOKING]), 1);
  assert.equal(await sees(HOST, booking, [BOOKING]), 1);
  assert.equal(await sees(OTHER_STUDENT, booking, [BOOKING]), 0);
});

test("a slot's zoom link is no longer readable by every signed-in user", async () => {
  const slot = "select zoom_url from public.mentor_slots where id = $1";
  assert.equal((await as(OTHER_STUDENT, slot, [SLOT])).rows.length, 0);
  assert.equal((await as(OTHER_MENTOR, slot, [SLOT])).rows.length, 0);
  assert.equal((await as(HOST, slot, [SLOT])).rows.length, 1, "its mentor");
  assert.equal((await as(ADMIN, slot, [SLOT])).rows.length, 1, "admins");
  // Reading a booking (whose policy reads mentor_slots) does not recurse.
  for (const uid of [STUDENT, HOST, ADMIN, OTHER_STUDENT]) {
    const err = await refusal(
      uid,
      "select b.id, s.starts_at from public.mentor_bookings b left join public.mentor_slots s on s.id = b.slot_id",
    );
    assert.equal(err, null, `${uid}: ${err}`);
  }
});

test("the service role (the server actions) still writes all of it", async () => {
  await q("update public.call_invites set status = 'completed' where id = $1", [CALL]);
  await q("update public.interview_requests set status = 'cancelled' where id = $1", [REQ]);
  await q("update public.mentor_bookings set recap_notes = 'ok' where id = $1", [BOOKING]);
  const { rows } = await q<{ status: string }>("select status from public.call_invites where id = $1", [CALL]);
  assert.equal(rows[0].status, "completed");
});

test("notifications into the removed office-hours pages open 1:1 calls", async () => {
  const { rows } = await q<{ type: string; link: string }>(
    "select type, link from public.notifications order by type",
  );
  assert.deepEqual(rows, [
    { type: "call_invited", link: "/dashboard/calls" },
    { type: "office_hours_booked", link: "/mentor/calls" },
    { type: "office_hours_recap", link: "/dashboard/calls" },
  ]);
});
