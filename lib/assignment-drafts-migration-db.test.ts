import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { MIGRATION_CHECKS } from "./migration-plan.ts";
import { checkDraft } from "./assignment-drafts.ts";

/**
 * Migration 0105 (private assignment drafts), run for real in PGlite on top of
 * the real 0093, applied twice, then exercised the way production does: saves
 * through save_course_assignment_draft() as the service role (the server
 * action), reads AS signed-in users so the owner-only policy is asserted.
 *
 * What it pins: a stale tab can't overwrite newer text — including after a
 * submit cleared the draft and a new one was started, when a reused version
 * number would have matched — a retried save isn't mistaken for a stale one,
 * losing access stops the saves, a draft is never a submission, and nobody
 * but the student reads it — not their mentor, not an admin.
 */

const assignments = await readFile(
  new URL("../supabase/migrations/0093_assignments.sql", import.meta.url),
  "utf8",
);
const migration = await readFile(
  new URL("../supabase/migrations/0105_assignment_drafts.sql", import.meta.url),
  "utf8",
);

const RUNNING = "0c0c0c0c-0000-4000-8000-000000000001";
const UPCOMING = "0c0c0c0c-0000-4000-8000-000000000002";
const ADMIN = "aaaaaaaa-0000-4000-8000-000000000001";
const MENTOR = "aaaaaaaa-0000-4000-8000-000000000002"; // cohort-wide mentor for RUNNING
const ANA = "aaaaaaaa-0000-4000-8000-000000000005"; // RUNNING
const BEN = "aaaaaaaa-0000-4000-8000-000000000006"; // RUNNING
const OLA = "aaaaaaaa-0000-4000-8000-000000000007"; // UPCOMING (hasn't started)

const OPEN = "b0000000-0000-4000-8000-000000000001";
const JUST_ANA = "b0000000-0000-4000-8000-000000000002";
const FUTURE = "b0000000-0000-4000-8000-000000000003";
const UNSTARTED = "b0000000-0000-4000-8000-000000000004";
const OTHER_OPEN = "b0000000-0000-4000-8000-000000000005";

async function setup() {
  const db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    create schema if not exists auth;
    create or replace function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    grant usage on schema auth to anon, authenticated, service_role;
    grant usage on schema public to anon, authenticated, service_role;
    -- What Supabase does: every new table and function is granted to the API
    -- roles, so a migration has to revoke what it doesn't want callable.
    alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
    alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;

    create table public.profiles (id uuid primary key, full_name text, role text not null default 'student');
    create table public.app_roles (slug text primary key, permissions text[] not null default '{}', description text);
    insert into public.app_roles values
      ('admin', array['*']), ('mentor', array['mentor.panel']), ('student', array['student.dashboard']);
    create or replace function public.has_permission(uid uuid, perm text)
    returns boolean language sql stable security definer set search_path = public as $$
      select exists (
        select 1 from public.profiles p join public.app_roles r on r.slug = p.role
        where p.id = uid and (r.permissions @> array['*']::text[] or r.permissions @> array[perm])
      ) $$;
    create or replace function public.is_admin(uid uuid)
    returns boolean language sql stable security definer set search_path = public as $$
      select public.has_permission(uid, '*') $$;
    create or replace function public.is_staff(uid uuid)
    returns boolean language sql stable security definer set search_path = public as $$
      select public.has_permission(uid, 'mentor.panel') $$;
    create or replace function public.touch_updated_at() returns trigger language plpgsql as $$
      begin new.updated_at = now(); return new; end $$;

    create table public.cohorts (id uuid primary key, name text, starts_on date, ends_on date, status text);
    create table public.enrollments (
      id uuid primary key default gen_random_uuid(),
      user_id uuid not null references public.profiles(id) on delete cascade,
      cohort_id uuid not null references public.cohorts(id) on delete cascade,
      enrolled_at timestamptz not null default now(),
      unique (user_id, cohort_id)
    );
    create table public.modules (id uuid primary key default gen_random_uuid(), cohort_id uuid references public.cohorts(id) on delete cascade, week int);
    create table public.lessons (id uuid primary key, module_id uuid references public.modules(id) on delete cascade, title text, description text);
    create table public.mentor_assignments (
      id uuid primary key default gen_random_uuid(), mentor_id uuid not null, student_id uuid not null, cohort_id uuid
    );
    -- What 0093 itself touches, so the real file runs.
    create table public.student_checkins (
      id uuid primary key default gen_random_uuid(), user_id uuid not null references public.profiles(id),
      week_start date not null, accomplished text, next_up text, blockers text,
      created_at timestamptz not null default now(), updated_at timestamptz not null default now()
    );
    alter table public.student_checkins enable row level security;
    create table public.checkin_feedback (
      id uuid primary key default gen_random_uuid(), checkin_id uuid not null references public.student_checkins(id),
      author_id uuid not null references public.profiles(id), body text not null, created_at timestamptz not null default now()
    );
    alter table public.checkin_feedback enable row level security;
    create table public.notifications (
      id uuid primary key default gen_random_uuid(), user_id uuid not null, type text not null,
      title text not null, link text, read_at timestamptz
    );
    create table public.email_templates (
      id uuid primary key default gen_random_uuid(), key text unique not null, enabled boolean not null default true,
      description text, body_html text not null default ''
    );
    create table public.email_automations (id uuid primary key default gen_random_uuid(), enabled boolean not null default true);
    create table public.email_automation_steps (
      id uuid primary key default gen_random_uuid(), automation_id uuid not null references public.email_automations(id),
      template_id uuid not null references public.email_templates(id), enabled boolean not null default true
    );
    create table public.events (id uuid primary key default gen_random_uuid(), cohort_id uuid, type text, description text);

    insert into public.profiles (id, full_name, role) values
      ('${ADMIN}', 'Admin', 'admin'), ('${MENTOR}', 'Mentor', 'mentor'),
      ('${ANA}', 'Ana', 'student'), ('${BEN}', 'Ben', 'student'), ('${OLA}', 'Ola', 'student');
    insert into public.cohorts values
      ('${RUNNING}', 'Running', current_date - 30, current_date + 30, 'active'),
      ('${UPCOMING}', 'Upcoming', current_date + 30, current_date + 90, 'upcoming');
    insert into public.enrollments (user_id, cohort_id) values
      ('${ANA}', '${RUNNING}'), ('${BEN}', '${RUNNING}'), ('${OLA}', '${UPCOMING}');
    insert into public.mentor_assignments (mentor_id, student_id, cohort_id) values ('${MENTOR}', '${ANA}', '${RUNNING}');
  `);
  await db.exec(assignments);
  // The doc's verify query reads "not run" until 0105 has.
  const before = await db.query<{ ok: boolean }>(MIGRATION_CHECKS["0105"]);
  assert.equal(before.rows[0].ok, false);
  await db.exec(migration);
  const after = await db.query<{ ok: boolean }>(MIGRATION_CHECKS["0105"]);
  assert.equal(after.rows[0].ok, true);
  await db.exec(`
    insert into public.course_assignments (id, cohort_id, title, audience, release_mode, opens_at, due_at, status) values
      ('${OPEN}', '${RUNNING}', 'Open', 'cohort', 'now', now() - interval '1 day', now() + interval '2 days', 'published'),
      ('${JUST_ANA}', '${RUNNING}', 'Just Ana', 'students', 'now', now() - interval '1 day', null, 'published'),
      ('${FUTURE}', '${RUNNING}', 'Future', 'cohort', 'date', now() + interval '3 days', now() + interval '9 days', 'published'),
      ('${UNSTARTED}', '${UPCOMING}', 'Week 1', 'cohort', 'now', now() - interval '1 day', null, 'published'),
      ('${OTHER_OPEN}', '${RUNNING}', 'Another', 'cohort', 'now', now() - interval '1 day', null, 'published');
    insert into public.course_assignment_targets values ('${JUST_ANA}', '${ANA}');
  `);
  return db;
}

/** As the server action: the service role, passing the signed-in user's id. */
async function save(
  db: PGlite,
  user: string,
  assignment: string,
  body: string | null,
  baseVersion: number,
  link: string | null = null,
): Promise<{ outcome: string; version?: number | null; saved_at?: string | null }> {
  await db.exec(`set role service_role;`);
  try {
    const { rows } = await db.query<{ r: any }>(
      `select public.save_course_assignment_draft($1, $2, $3, $4, $5) as r`,
      [user, assignment, body, link, baseVersion],
    );
    return rows[0].r;
  } finally {
    await db.exec(`reset role;`);
  }
}

/** As submitAssignment, after it has stored the submission. */
async function clear(
  db: PGlite,
  user: string,
  assignment: string,
  upTo: number,
): Promise<{ cleared: boolean; version: number }> {
  await db.exec(`set role service_role;`);
  try {
    const { rows } = await db.query<{ r: any }>(`select public.clear_course_assignment_draft($1, $2, $3) as r`, [
      user,
      assignment,
      upTo,
    ]);
    return rows[0].r;
  } finally {
    await db.exec(`reset role;`);
  }
}

async function as<T = any>(db: PGlite, uid: string, sql: string, params: unknown[] = []) {
  await db.exec(`set role authenticated; select set_config('request.jwt.claim.sub', '${uid}', false);`);
  try {
    return await db.query<T>(sql, params);
  } finally {
    await db.exec(`reset role; select set_config('request.jwt.claim.sub', '', false);`);
  }
}

async function draftOf(db: PGlite, user: string, assignment: string) {
  const { rows } = await db.query<any>(
    `select body, link_url, version, cleared_at is not null as cleared from public.course_assignment_drafts where user_id = $1 and assignment_id = $2`,
    [user, assignment],
  );
  return rows[0] ?? null;
}

test("0105 applies twice; the only policy is the owner's read, and clients can't write or call the saver", async () => {
  const db = await setup();
  await db.exec(migration);
  const { rows: policies } = await db.query<any>(
    `select policyname, cmd, qual from pg_policies where tablename = 'course_assignment_drafts'`,
  );
  assert.equal(policies.length, 1);
  assert.equal(policies[0].cmd, "SELECT");
  // No staff or permission clause: drafts are private until submitted.
  assert.doesNotMatch(policies[0].qual, /is_staff|has_permission|is_admin/);

  const { rows: grants } = await db.query<any>(
    `select grantee, privilege_type from information_schema.role_table_grants
     where table_name = 'course_assignment_drafts' and grantee in ('anon', 'authenticated')
       and privilege_type in ('INSERT', 'UPDATE', 'DELETE')`,
  );
  assert.deepEqual(grants, []);

  const sig = "public.save_course_assignment_draft(uuid, uuid, text, text, integer)";
  const clearSig = "public.clear_course_assignment_draft(uuid, uuid, integer)";
  for (const fn of [sig, clearSig]) {
    const { rows: exec } = await db.query<any>(
      `select has_function_privilege('anon', '${fn}', 'execute') as anon,
              has_function_privilege('authenticated', '${fn}', 'execute') as authed,
              has_function_privilege('service_role', '${fn}', 'execute') as service`,
    );
    assert.deepEqual(exec[0], { anon: false, authed: false, service: true }, fn);
  }

  // Half-run (table, no function) reads as not done — false, not an error —
  // and a re-run finishes it.
  await db.exec(`drop function ${sig}`);
  assert.equal((await db.query<{ ok: boolean }>(MIGRATION_CHECKS["0105"])).rows[0].ok, false);
  await db.exec(migration);
  assert.equal((await db.query<{ ok: boolean }>(MIGRATION_CHECKS["0105"])).rows[0].ok, true);
  // An earlier draft of this file (no clear function) reads as not done.
  await db.exec(`drop function ${clearSig}`);
  assert.equal((await db.query<{ ok: boolean }>(MIGRATION_CHECKS["0105"])).rows[0].ok, false);
  await db.exec(migration);
  // A grant to clients (Supabase's default for a new function) fails it too.
  for (const fn of [sig, clearSig]) {
    await db.exec(`grant execute on function ${fn} to authenticated`);
    assert.equal((await db.query<{ ok: boolean }>(MIGRATION_CHECKS["0105"])).rows[0].ok, false, fn);
    await db.exec(migration);
  }
  assert.equal((await db.query<{ ok: boolean }>(MIGRATION_CHECKS["0105"])).rows[0].ok, true);

  // A signed-in student calling it over /rest/v1/rpc with someone else's id.
  await assert.rejects(
    as(db, BEN, `select public.save_course_assignment_draft($1, $2, 'mine now', null, 0)`, [ANA, OPEN]),
    /permission denied/,
  );
  await assert.rejects(
    as(db, ANA, `insert into public.course_assignment_drafts (assignment_id, user_id, body) values ($1, $2, 'x')`, [OPEN, ANA]),
    /permission denied/,
  );
  await assert.rejects(as(db, BEN, `select public.clear_course_assignment_draft($1, $2, 99)`, [ANA, OPEN]), /permission denied/);
});

test("save, save again, restore: each save names the version it was typed on", async () => {
  const db = await setup();
  const first = await save(db, ANA, OPEN, "first thoughts", 0);
  assert.equal(first.outcome, "saved");
  assert.equal(first.version, 1);
  assert.ok(first.saved_at);
  const second = await save(db, ANA, OPEN, "first thoughts, then more", 1, "https://docs.google.com/d/1");
  assert.deepEqual([second.outcome, second.version], ["saved", 2]);
  // What a reload reads back (through the student's own client).
  const { rows } = await as(db, ANA, `select body, link_url, version from public.course_assignment_drafts where assignment_id = $1`, [OPEN]);
  assert.deepEqual(rows, [{ body: "first thoughts, then more", link_url: "https://docs.google.com/d/1", version: 2 }]);
  // A half-typed link is a normal draft.
  assert.equal((await save(db, ANA, OPEN, null, 2, "https://docs.goo")).outcome, "saved");
});

test("a stale tab can't overwrite newer text", async () => {
  const db = await setup();
  await save(db, ANA, OPEN, "v1", 0);
  // Tab A and tab B both loaded version 1. A saves first.
  assert.equal((await save(db, ANA, OPEN, "newer, from tab A", 1)).outcome, "saved");
  const fromB = await save(db, ANA, OPEN, "older, from tab B", 1);
  assert.equal(fromB.outcome, "stale");
  assert.equal(fromB.version, 2);
  assert.equal((await draftOf(db, ANA, OPEN)).body, "newer, from tab A");
  // A tab that loaded before any draft existed doesn't clobber one made since.
  await save(db, BEN, OPEN, "phone draft", 0);
  const laptop = await save(db, BEN, OPEN, "laptop draft", 0);
  assert.equal(laptop.outcome, "stale");
  assert.equal((await draftOf(db, BEN, OPEN)).body, "phone draft");
  // The draft was submitted (and cleared) from another tab: a tab still
  // holding its old version is told so rather than resurrecting it.
  assert.deepEqual(await clear(db, ANA, OPEN, 2), { cleared: true, version: 3 });
  const after = await save(db, ANA, OPEN, "late keystroke", 2);
  assert.deepEqual([after.outcome, after.version], ["stale", 3]);
  assert.deepEqual(await draftOf(db, ANA, OPEN), { body: null, link_url: null, version: 3, cleared: true });
});

test("versions never repeat: a submit empties the draft rather than deleting it", async () => {
  // Reviewer's case (a). Phone and laptop both open on v1. The laptop
  // submits (clearing it), then keeps typing. The phone, still on v1, saves
  // its older text: with a deleted row the laptop's new draft would be back
  // at v1 and the phone's write would have replaced it.
  const db = await setup();
  await save(db, ANA, OPEN, "v1 text", 0);
  assert.deepEqual(await clear(db, ANA, OPEN, 1), { cleared: true, version: 2 });
  const laptop = await save(db, ANA, OPEN, "Y newer laptop text", 2);
  assert.deepEqual([laptop.outcome, laptop.version], ["saved", 3]);
  const phone = await save(db, ANA, OPEN, "X old phone text", 1);
  assert.deepEqual([phone.outcome, phone.version], ["stale", 3]);
  assert.equal((await draftOf(db, ANA, OPEN)).body, "Y newer laptop text");

  // Case (b). Tab A sits on v3 and never autosaves. Tab B submits, then
  // types new work. Tab A's submit clears only up to v3: B's new draft stays.
  await save(db, BEN, OPEN, "b1", 0);
  await save(db, BEN, OPEN, "b2", 1);
  await save(db, BEN, OPEN, "b3", 2);
  assert.deepEqual(await clear(db, BEN, OPEN, 3), { cleared: true, version: 4 });
  assert.equal((await save(db, BEN, OPEN, "B's newer unsubmitted work", 4)).outcome, "saved");
  assert.deepEqual(await clear(db, BEN, OPEN, 3), { cleared: false, version: 5 });
  assert.deepEqual(await draftOf(db, BEN, OPEN), { body: "B's newer unsubmitted work", link_url: null, version: 5, cleared: false });
});

test("a cleared draft: saving on top of it is a draft again; a tab that never saw it can't", async () => {
  const db = await setup();
  await save(db, ANA, OPEN, "before submit", 0);
  assert.deepEqual(await clear(db, ANA, OPEN, 1), { cleared: true, version: 2 });
  // Submitting again (nothing typed since) is already clear: same version.
  assert.deepEqual(await clear(db, ANA, OPEN, 2), { cleared: true, version: 2 });
  // A tab that loaded before any draft existed is behind the clear.
  assert.equal((await save(db, ANA, OPEN, "from a tab that saw nothing", 0)).outcome, "stale");
  // The tab that submitted saves on top of the version the clear left.
  const next = await save(db, ANA, OPEN, "after submit", 2);
  assert.deepEqual([next.outcome, next.version], ["saved", 3]);
  assert.deepEqual(await draftOf(db, ANA, OPEN), { body: "after submit", link_url: null, version: 3, cleared: false });
  // Nothing to clear: no row is "clear" at version 0.
  assert.deepEqual(await clear(db, BEN, OPEN, 0), { cleared: true, version: 0 });
  assert.equal(await draftOf(db, BEN, OPEN), null);
});

test("a save retried after its answer was lost is the same save, not a stale one", async () => {
  const db = await setup();
  await save(db, ANA, OPEN, "first", 0);
  // v1 → v2 lands, but the browser never hears back; it retries from v1.
  assert.equal((await save(db, ANA, OPEN, "first, then more", 1, "https://docs.google.com/d/1")).outcome, "saved");
  const retry = await save(db, ANA, OPEN, "first, then more", 1, "https://docs.google.com/d/1");
  assert.deepEqual([retry.outcome, retry.version], ["saved", 2]);
  // Same for a first save (base 0) whose answer was lost.
  await save(db, BEN, OPEN, "ben's first", 0);
  assert.deepEqual(
    [(await save(db, BEN, OPEN, "ben's first", 0)).outcome, (await draftOf(db, BEN, OPEN)).version],
    ["saved", 1],
  );
  // Different text on the old version is still stale…
  assert.equal((await save(db, ANA, OPEN, "first, then something else", 1)).outcome, "stale");
  // …and so is the old text of a cleared draft: a clear isn't that text.
  await clear(db, ANA, OPEN, 2);
  assert.equal((await save(db, ANA, OPEN, "first, then more", 2, "https://docs.google.com/d/1")).outcome, "stale");
  assert.equal((await draftOf(db, ANA, OPEN)).version, 3);
});

test("who may save: enrolled, targeted, open, started, not yet reviewed", async () => {
  const db = await setup();
  assert.equal((await save(db, ANA, JUST_ANA, "for me", 0)).outcome, "saved");
  assert.equal((await save(db, BEN, JUST_ANA, "not for me", 0)).outcome, "forbidden");
  assert.equal((await save(db, OLA, OPEN, "other cohort", 0)).outcome, "forbidden");
  assert.equal((await save(db, ANA, FUTURE, "too early", 0)).outcome, "closed");
  assert.equal((await save(db, OLA, UNSTARTED, "cohort hasn't started", 0)).outcome, "closed");
  assert.equal((await save(db, ANA, "b0000000-0000-4000-8000-0000000000ff", "no such", 0)).outcome, "closed");
  // Needs changes: still editable, so still saving.
  await db.exec(`insert into public.course_assignment_submissions (assignment_id, user_id, body, status, submitted_at)
                 values ('${OTHER_OPEN}', '${ANA}', 'handed in', 'returned', now())`);
  assert.equal((await save(db, ANA, OTHER_OPEN, "fixing it", 0)).outcome, "saved");
  for (const status of ["reviewed", "excused"]) {
    await db.exec(`update public.course_assignment_submissions set status = '${status}' where assignment_id = '${OTHER_OPEN}'`);
    assert.equal((await save(db, ANA, OTHER_OPEN, "after review", 1)).outcome, "locked", status);
  }
  assert.equal((await draftOf(db, ANA, OTHER_OPEN)).body, "fixing it");
});

test("losing access stops the saves at once, and leaves the draft as it was", async () => {
  const db = await setup();
  await save(db, ANA, OPEN, "before", 0);
  await save(db, ANA, JUST_ANA, "before", 0);

  await db.exec(`delete from public.course_assignment_targets where assignment_id = '${JUST_ANA}' and user_id = '${ANA}'`);
  assert.equal((await save(db, ANA, JUST_ANA, "after removal", 1)).outcome, "forbidden");

  await db.exec(`update public.course_assignments set status = 'archived' where id = '${OPEN}'`);
  assert.equal((await save(db, ANA, OPEN, "after archive", 1)).outcome, "closed");
  await db.exec(`update public.course_assignments set status = 'published' where id = '${OPEN}'`);
  assert.equal((await save(db, ANA, OPEN, "republished", 1)).outcome, "saved");

  await db.exec(`delete from public.enrollments where user_id = '${ANA}'`);
  assert.equal((await save(db, ANA, OPEN, "after unenrolment", 2)).outcome, "forbidden");
  assert.equal((await draftOf(db, ANA, OPEN)).body, "republished");
  assert.equal((await draftOf(db, ANA, JUST_ANA)).body, "before");
});

test("a draft is never a submission, and nobody but its owner reads it", async () => {
  const db = await setup();
  await save(db, ANA, OPEN, "ana's private draft", 0);
  await save(db, BEN, OPEN, "ben's private draft", 0);

  const { rows: subs } = await db.query<any>(`select count(*)::int as n from public.course_assignment_submissions`);
  assert.equal(subs[0].n, 0);

  const read = `select user_id, body from public.course_assignment_drafts order by body`;
  assert.deepEqual((await as(db, ANA, read)).rows.map((r) => r.body), ["ana's private draft"]);
  assert.deepEqual((await as(db, BEN, read)).rows.map((r) => r.body), ["ben's private draft"]);
  // Ana's own mentor, and an admin, see none of it.
  assert.deepEqual((await as(db, MENTOR, read)).rows, []);
  assert.deepEqual((await as(db, ADMIN, read)).rows, []);
  // Signed out.
  await db.exec(`set role anon;`);
  try {
    assert.deepEqual((await db.query(read)).rows, []);
  } finally {
    await db.exec(`reset role;`);
  }
});

test("caps match a submission's, and drafts go with their assignment or account", async () => {
  const db = await setup();
  await assert.rejects(save(db, ANA, OPEN, "x".repeat(10001), 0), /check constraint/);
  await assert.rejects(save(db, ANA, OPEN, null, 0, `https://x.co/${"y".repeat(2048)}`), /check constraint/);
  assert.equal((await save(db, ANA, OPEN, "x".repeat(10000), 0)).outcome, "saved");
  await save(db, BEN, OPEN, "ben", 0);

  await db.exec(`delete from public.profiles where id = '${BEN}'`);
  assert.equal(await draftOf(db, BEN, OPEN), null);
  await db.exec(`delete from public.course_assignments where id = '${OPEN}'`);
  assert.equal(await draftOf(db, ANA, OPEN), null);
});

test("Postgres refuses a NUL character, so the save path drops it before it gets here", async () => {
  const db = await setup();
  // What every autosave of a pasted NUL hit: an error, retried forever.
  await assert.rejects(() => save(db, ANA, OPEN, "pasted\u0000text", 0));
  assert.equal(await draftOf(db, ANA, OPEN), null);
  // checkDraft (what the draft route saves through) drops it; that saves.
  const checked = checkDraft({ body: "pasted\u0000text", link: "https://docs.google.com/d/1\u0000" });
  assert.ok(checked.ok);
  const saved = await save(db, ANA, OPEN, checked.body, 0, checked.link);
  assert.equal(saved.outcome, "saved");
  assert.deepEqual(await draftOf(db, ANA, OPEN), {
    body: "pastedtext",
    link_url: "https://docs.google.com/d/1",
    version: 1,
    cleared: false,
  });
});
