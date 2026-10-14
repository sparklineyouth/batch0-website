import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";

/**
 * Migration 0093 (assignment tracker), run for real in PGlite, applied twice,
 * then queried AS signed-in users so the policies' decisions are asserted:
 * a student, a student in another cohort, a mentor scoped to the cohort, a
 * mentor with no scope, and an admin.
 */

const migration = await readFile(
  new URL("../supabase/migrations/0093_assignments.sql", import.meta.url),
  "utf8",
);

const FALL = "6350c6ac-70f0-4f53-93d5-c99e397185a9";
const OTHER = "0c0c0c0c-0000-4000-8000-000000000002";
const ADMIN = "aaaaaaaa-0000-4000-8000-000000000001";
const MENTOR = "aaaaaaaa-0000-4000-8000-000000000002"; // cohort-wide mentor for FALL
const LONE_MENTOR = "aaaaaaaa-0000-4000-8000-000000000003"; // no mentor_assignments
const DIRECT_MENTOR = "aaaaaaaa-0000-4000-8000-000000000004"; // assigned to ANA only, no cohort
const ANA = "aaaaaaaa-0000-4000-8000-000000000005"; // FALL
const BEN = "aaaaaaaa-0000-4000-8000-000000000006"; // FALL
const OLA = "aaaaaaaa-0000-4000-8000-000000000007"; // OTHER cohort
const INTERN = "aaaaaaaa-0000-4000-8000-000000000008";
const LESSON = "11111111-0000-4000-8000-000000000001";
const LESSON2 = "11111111-0000-4000-8000-000000000002";
const LESSON3 = "11111111-0000-4000-8000-000000000003";

async function setup() {
  const db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated;
    create schema if not exists auth;
    create or replace function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    grant usage on schema auth to anon, authenticated;
    grant usage on schema public to anon, authenticated;
    alter default privileges in schema public grant all on tables to anon, authenticated;
    alter default privileges in schema public grant execute on functions to anon, authenticated;

    create table public.profiles (id uuid primary key, full_name text, role text not null default 'student');
    create table public.app_roles (slug text primary key, permissions text[] not null default '{}', description text);
    insert into public.app_roles values
      ('admin', array['*']),
      ('mentor', array['mentor.panel']),
      ('student', array['student.dashboard']),
      ('intern', array['people.view', 'pulse.view', 'interventions.manage', 'course.manage']);

    -- 0048_custom_roles.sql
    create or replace function public.has_permission(uid uuid, perm text)
    returns boolean language sql stable security definer set search_path = public as $$
      select exists (
        select 1 from public.profiles p join public.app_roles r on r.slug = p.role
        where p.id = uid and (r.permissions @> array['*']::text[] or r.permissions @> array[perm])
      ) $$;
    create or replace function public.is_admin(uid uuid)
    returns boolean language sql stable security definer set search_path = public as $$
      select exists (
        select 1 from public.profiles p join public.app_roles r on r.slug = p.role
        where p.id = uid and r.permissions @> array['*']::text[]
      ) $$;
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
    alter table public.enrollments enable row level security;
    create policy "enrollments self or admin" on public.enrollments
      for select using (user_id = auth.uid() or public.is_admin(auth.uid()));
    create table public.modules (id uuid primary key default gen_random_uuid(), cohort_id uuid references public.cohorts(id) on delete cascade, week int);
    create table public.lessons (
      id uuid primary key, module_id uuid references public.modules(id) on delete cascade, title text, description text
    );
    create table public.mentor_assignments (
      id uuid primary key default gen_random_uuid(),
      mentor_id uuid not null, student_id uuid not null, cohort_id uuid
    );

    -- 0010: check-ins, with their original policies.
    create table public.student_checkins (
      id uuid primary key default gen_random_uuid(), user_id uuid not null references public.profiles(id),
      week_start date not null, accomplished text, next_up text, blockers text,
      created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
      unique (user_id, week_start)
    );
    alter table public.student_checkins enable row level security;
    create policy "checkins self all" on public.student_checkins
      for all using (user_id = auth.uid()) with check (user_id = auth.uid());
    create policy "checkins staff read" on public.student_checkins for select using (public.is_staff(auth.uid()));
    create table public.checkin_feedback (
      id uuid primary key default gen_random_uuid(), checkin_id uuid not null references public.student_checkins(id),
      author_id uuid not null references public.profiles(id), body text not null,
      created_at timestamptz not null default now()
    );
    alter table public.checkin_feedback enable row level security;
    create policy "checkin_feedback read" on public.checkin_feedback for select using (public.is_staff(auth.uid()));
    create policy "checkin_feedback staff write" on public.checkin_feedback
      for all using (public.is_staff(auth.uid())) with check (public.is_staff(auth.uid()));

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
      ('${LONE_MENTOR}', 'Lone', 'mentor'), ('${DIRECT_MENTOR}', 'Direct', 'mentor'),
      ('${ANA}', 'Ana', 'student'), ('${BEN}', 'Ben', 'student'), ('${OLA}', 'Ola', 'student'),
      ('${INTERN}', 'Intern', 'intern');
    insert into public.cohorts values
      ('${FALL}', 'Fall 2026', '2026-09-14', '2026-11-13', 'active'),
      ('${OTHER}', 'Winter 2027', '2027-01-11', '2027-03-12', 'upcoming');
    insert into public.enrollments (user_id, cohort_id) values
      ('${ANA}', '${FALL}'), ('${BEN}', '${FALL}'), ('${OLA}', '${OTHER}');
    insert into public.mentor_assignments (mentor_id, student_id, cohort_id) values
      ('${MENTOR}', '${BEN}', '${FALL}'),
      ('${DIRECT_MENTOR}', '${ANA}', null);
    insert into public.modules (id, cohort_id, week) values ('22222222-0000-4000-8000-000000000001', '${FALL}', 1);
    insert into public.lessons (id, module_id, title, description) values
      ('${LESSON}', '22222222-0000-4000-8000-000000000001', 'Ship list',
       '- [Check-in](/dashboard/checkin): once a week.' || chr(10) || 'Submit your [check-in](/dashboard/checkin). See /dashboard/checkin?x=1'),
      ('${LESSON2}', '22222222-0000-4000-8000-000000000001', 'The One-Sentence Startup and Your First Check-in',
       $md$## Your first check-in

The [weekly check-in](/dashboard/checkin) asks three things. The blockers box is the one we read first.

4. Submit your [check-in](/dashboard/checkin). Numbers in the first box, the demand test in the second, and at least one honest line in blockers, even if it's small.

| 10 | Weekly check-in | Submitted |$md$),
      ('${LESSON3}', '22222222-0000-4000-8000-000000000001', 'Cofounders', 'Hold a weekly check-in with your cofounder.');
    update public.app_roles set description = 'Works with students and teams: check-ins, office hours, course feedback.'
    where slug = 'mentor';
    insert into public.notifications (user_id, type, title, link) values
      ('${ANA}', 'checkin_feedback', 'Feedback', '/dashboard/checkin'),
      ('${MENTOR}', 'checkin_submitted', 'Ana posted', '/mentor/checkins?week=2026-10-12'),
      ('${MENTOR}', 'intervention', 'Ben needs a nudge', '/mentor/students/x'),
      ('${ADMIN}', 'discord_blocker', 'Blocker flagged in Discord', '/admin/interventions'),
      ('${ADMIN}', 'at_risk', 'Two students at risk', '/admin/interventions?x=1'),
      ('${ADMIN}', 'pulse', 'Weekly pulse', '/admin/pulse'),
      ('${ADMIN}', 'health', 'Cohort health', '/admin/cohorts/${FALL}/health');
    insert into public.email_templates (id, key) values ('33333333-0000-4000-8000-000000000001', 'cohort.checkin_reminder');
    insert into public.email_templates (key, description, body_html) values
      ('cohort.next_steps', 'Next steps.',
       '<li><strong>Post your check-in.</strong> What you shipped, what''s next, what''s in the way. A mentor replies on it.</li>' ||
       '<p>If you''re behind, don''t try to catch up on all four. Do the deliverable, post the check-in saying you''re behind, and we''ll sort the rest out with you.</p>'),
      ('cohort.week3',
       'Deliberately written about the SHAPE of the week (module, deliverable, check-in, office hours, live session) rather than a sprint title.',
       '<li><strong>Your check-in</strong>, same three questions as always.</li>' ||
       '<p><strong>What''s expected of you:</strong> 5–10 focused hours, the deliverable shipped by the end of the week, and a check-in that tells the truth about how it went.</p>' ||
       '<p>That''s the process working, not you failing — but bring it to office hours or your check-in before you rebuild everything on a hunch.</p>');
    insert into public.email_automations (id) values ('44444444-0000-4000-8000-000000000001');
    insert into public.email_automation_steps (automation_id, template_id) values
      ('44444444-0000-4000-8000-000000000001', '33333333-0000-4000-8000-000000000001');
    insert into public.events (cohort_id, type, description) values ('${FALL}', 'demo_day',
      'Students prepare a demo. Submit through Files and include the links in your Check-in by Wednesday, November 11 at 8:00 p.m.');
    -- Week 4 (Mon Oct 5 to Sun Oct 11): before the seeded series, so not carried over.
    insert into public.student_checkins (user_id, week_start, accomplished, created_at)
    values ('${ANA}', '2026-10-05', 'shipped', '2026-10-06T15:00:00Z');
  `);
  await db.exec(migration);
  return db;
}

async function as<T = any>(db: PGlite, uid: string, sql: string, params: unknown[] = []) {
  await db.exec(`set role authenticated; select set_config('request.jwt.claim.sub', '${uid}', false);`);
  try {
    return await db.query<T>(sql, params);
  } finally {
    await db.exec(`reset role; select set_config('request.jwt.claim.sub', '', false);`);
  }
}

/** Fixture assignments with dates relative to now(), so the run date never matters. */
async function seedFixtures(db: PGlite) {
  await db.exec(`
    insert into public.course_assignments (id, cohort_id, title, audience, release_mode, opens_at, due_at, status) values
      ('b0000000-0000-4000-8000-000000000001', '${FALL}', 'Open', 'cohort', 'now', now() - interval '1 day', now() + interval '2 days', 'published'),
      ('b0000000-0000-4000-8000-000000000002', '${FALL}', 'Future', 'cohort', 'date', now() + interval '3 days', now() + interval '9 days', 'published'),
      ('b0000000-0000-4000-8000-000000000003', '${FALL}', 'Draft', 'cohort', 'now', now() - interval '1 day', null, 'draft'),
      ('b0000000-0000-4000-8000-000000000004', '${FALL}', 'Just Ana', 'students', 'now', now() - interval '1 day', null, 'published'),
      ('b0000000-0000-4000-8000-000000000005', '${OTHER}', 'Other cohort', 'cohort', 'now', now() - interval '1 day', null, 'published');
    insert into public.course_assignment_targets values ('b0000000-0000-4000-8000-000000000004', '${ANA}');
    insert into public.course_assignment_submissions (assignment_id, user_id, body, submitted_at) values
      ('b0000000-0000-4000-8000-000000000001', '${ANA}', 'ana work', now()),
      ('b0000000-0000-4000-8000-000000000001', '${BEN}', 'ben work', now()),
      ('b0000000-0000-4000-8000-000000000005', '${OLA}', 'ola work', now());
  `);
}

const titles = (rows: any[]) => rows.map((r) => r.title).sort();

test("0093 applies twice; signed-in users hold read policies only", async () => {
  const db = await setup();
  await db.exec(migration);
  const { rows } = await db.query<any>(
    `select tablename, cmd from pg_policies where tablename like 'course\\_assignment%' order by 1, 2`,
  );
  assert.equal(rows.length, 3);
  for (const r of rows) assert.equal(r.cmd, "SELECT", `${r.tablename} has a ${r.cmd} policy`);
});

test("Fall seed: weekly update weeks 5–9 (DST-correct) and Demo Day, once", async () => {
  const db = await setup();
  await db.exec(migration);
  const { rows } = await db.query<any>(
    `select week, title, due_day_offset, to_char(opens_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI') as opens,
            to_char(due_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI') as due
     from public.course_assignments where cohort_id = $1 order by week nulls last`,
    [FALL],
  );
  assert.equal(rows.length, 6);
  assert.deepEqual(rows.slice(0, 5).map((r) => r.week), [5, 6, 7, 8, 9]);
  const byWeek = Object.fromEntries(rows.filter((r) => r.week).map((r) => [r.week, r]));
  assert.equal(byWeek[5].opens, "2026-10-12T04:00");
  assert.equal(byWeek[5].due, "2026-10-19T03:59");
  assert.equal(byWeek[6].due, "2026-10-26T03:59"); // EDT
  assert.equal(byWeek[7].opens, "2026-10-26T04:00");
  assert.equal(byWeek[7].due, "2026-11-02T04:59"); // EST — DST ended Nov 1
  assert.equal(byWeek[8].opens, "2026-11-02T05:00");
  assert.deepEqual(rows.slice(0, 4).map((r) => r.due_day_offset), [6, 6, 6, 6]);
  // The cohort ends Friday Nov 13 (Demo Day): week 9 is due then, not Sunday.
  assert.equal(byWeek[9].due, "2026-11-14T04:59");
  assert.equal(byWeek[9].due_day_offset, 4);
  const demo = rows.find((r) => r.title === "Demo Day submission");
  assert.equal(demo.due, "2026-11-12T01:00");
});

test("a re-run after the app is in use leaves deleted seeded assignments deleted", async () => {
  const db = await setup();
  const WEEK8 = "a0930000-0000-4000-8000-000000000008";
  const DEMO = "a0930000-0000-4000-8000-0000000000dd";
  await db.query(`delete from public.course_assignments where id in ($1, $2)`, [WEEK8, DEMO]);
  await db.exec(migration);
  await db.exec(migration);
  const { rows } = await db.query<any>(
    `select id from public.course_assignments where id in ($1, $2)`,
    [WEEK8, DEMO],
  );
  assert.deepEqual(rows, []);
  const left = await db.query<any>(
    `select count(*)::int as n from public.course_assignments where cohort_id = $1`,
    [FALL],
  );
  assert.equal(left.rows[0].n, 4);
});

test("check-ins already posted for a seeded week carry over as that week's update", async () => {
  const db = await setup();
  const WEEK5 = "a0930000-0000-4000-8000-000000000005";
  await db.exec(`
    insert into public.student_checkins (id, user_id, week_start, accomplished, next_up, blockers, created_at) values
      -- Ben, Tuesday of week 5. A mentor replied twice.
      ('c0000000-0000-4000-8000-000000000001', '${BEN}', '2026-10-12', ' 4 interviews ', 'pricing page', '', '2026-10-13T15:00:00Z'),
      -- Ana, Sunday Oct 18 at 10 p.m. ET: UTC files it under the next week, but it is week 5's,
      -- and the later of her two week-5 check-ins.
      ('c0000000-0000-4000-8000-000000000002', '${ANA}', '2026-10-19', 'landing page live', null, 'no replies yet', '2026-10-19T02:00:00Z'),
      ('c0000000-0000-4000-8000-000000000005', '${ANA}', '2026-10-12', 'early draft', null, null, '2026-10-12T16:00:00Z'),
      -- Ola is in another cohort.
      ('c0000000-0000-4000-8000-000000000003', '${OLA}', '2026-10-12', 'hi', null, null, '2026-10-13T15:00:00Z'),
      -- Ben, Sunday Oct 11 at 9 p.m. ET: week 4, not carried over.
      ('c0000000-0000-4000-8000-000000000004', '${BEN}', '2026-10-05', 'week four', null, null, '2026-10-12T01:00:00Z');
    insert into public.checkin_feedback (checkin_id, author_id, body, created_at) values
      ('c0000000-0000-4000-8000-000000000001', '${DIRECT_MENTOR}', 'Good.', '2026-10-13T18:00:00Z'),
      ('c0000000-0000-4000-8000-000000000001', '${MENTOR}', 'Ship the pricing page.', '2026-10-14T18:00:00Z');
  `);
  // Ana already handed in week 6 in the app: a re-run must not touch it.
  await db.exec(`
    insert into public.course_assignment_submissions (assignment_id, user_id, body, submitted_at)
    values ('a0930000-0000-4000-8000-000000000006', '${ANA}', 'from the app', '2026-10-20T15:00:00Z');
  `);
  await db.exec(migration);
  await db.exec(migration);
  const { rows } = await db.query<any>(
    `select assignment_id, user_id, body, status, late, feedback, reviewed_by,
            to_char(submitted_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI') as submitted
     from public.course_assignment_submissions order by assignment_id, user_id`,
  );
  assert.equal(rows.length, 3);
  const ben = rows.find((r) => r.user_id === BEN);
  assert.equal(ben.assignment_id, WEEK5);
  assert.equal(ben.body, "Shipped: 4 interviews\n\nNext: pricing page");
  assert.equal(ben.status, "reviewed");
  assert.equal(ben.feedback, "Good.\n\nShip the pricing page.");
  assert.equal(ben.reviewed_by, MENTOR);
  assert.equal(ben.submitted, "2026-10-13T15:00");
  assert.equal(ben.late, false);
  const ana = rows.filter((r) => r.user_id === ANA);
  assert.deepEqual(ana.map((r) => r.assignment_id), [WEEK5, "a0930000-0000-4000-8000-000000000006"]);
  assert.equal(ana[0].body, "Shipped: landing page live\n\nBlockers: no replies yet");
  assert.equal(ana[0].status, "submitted");
  assert.equal(ana[0].feedback, null);
  assert.equal(ana[1].body, "from the app");
});

test("a student sees released, published work for their cohort and nothing else", async () => {
  const db = await setup();
  await seedFixtures(db);
  const ana = await as(db, ANA, `select title from public.course_assignments where title not in ('Weekly update', 'Demo Day submission')`);
  assert.deepEqual(titles(ana.rows), ["Just Ana", "Open"]);
  const ben = await as(db, BEN, `select title from public.course_assignments where title not in ('Weekly update', 'Demo Day submission')`);
  assert.deepEqual(titles(ben.rows), ["Open"]);
  const ola = await as(db, OLA, `select title from public.course_assignments`);
  assert.deepEqual(titles(ola.rows), ["Other cohort"]);
  // Reading assignments and targets together must not recurse.
  const joined = await as(
    db,
    ANA,
    `select a.title from public.course_assignments a join public.course_assignment_targets t on t.assignment_id = a.id`,
  );
  assert.deepEqual(titles(joined.rows), ["Just Ana"]);
  const targets = await as(db, BEN, `select * from public.course_assignment_targets`);
  assert.equal(targets.rows.length, 0);
});

test("a student reads only their own submission and cannot write anything", async () => {
  const db = await setup();
  await seedFixtures(db);
  const own = await as(db, ANA, `select body from public.course_assignment_submissions`);
  assert.deepEqual(own.rows.map((r: any) => r.body), ["ana work"]);
  await assert.rejects(
    as(db, ANA, `insert into public.course_assignment_submissions (assignment_id, user_id, body) values ('b0000000-0000-4000-8000-000000000004', '${ANA}', 'x')`),
    /permission denied|row-level security/,
  );
  await assert.rejects(
    as(db, ANA, `update public.course_assignment_submissions set status = 'reviewed' where user_id = '${ANA}'`),
    /permission denied|row-level security/,
  );
  await assert.rejects(
    as(db, ANA, `delete from public.course_assignments`),
    /permission denied|row-level security/,
  );
  await assert.rejects(
    as(db, ADMIN, `insert into public.course_assignment_targets values ('b0000000-0000-4000-8000-000000000001', '${BEN}')`),
    /permission denied|row-level security/,
  );
});

test("mentors read submissions in their scope only; admins read all", async () => {
  const db = await setup();
  await seedFixtures(db);
  const bodies = async (uid: string) =>
    (await as(db, uid, `select body from public.course_assignment_submissions`)).rows.map((r: any) => r.body).sort();
  assert.deepEqual(await bodies(MENTOR), ["ana work", "ben work"]); // cohort-wide row in FALL
  assert.deepEqual(await bodies(DIRECT_MENTOR), ["ana work"]); // assigned to Ana only
  assert.deepEqual(await bodies(LONE_MENTOR), []);
  assert.deepEqual(await bodies(ADMIN), ["ana work", "ben work", "ola work"]);
  // Staff see assignment definitions (course content), drafts included.
  const lone = await as(db, LONE_MENTOR, `select title from public.course_assignments where status = 'draft'`);
  assert.deepEqual(titles(lone.rows), ["Draft"]);
  // The predicate only ever answers for the caller.
  const rpc = await as(db, ANA, `select public.mentor_covers_student($1) as ok`, [BEN]);
  assert.equal(rpc.rows[0].ok, false);
});

test("CHECKs: https links, content, one row per student, cascade with the cohort", async () => {
  const db = await setup();
  await seedFixtures(db);
  const a = "b0000000-0000-4000-8000-000000000004";
  await assert.rejects(
    db.query(`insert into public.course_assignment_submissions (assignment_id, user_id, link_url) values ($1, $2, 'http://x.co')`, [a, ANA]),
    /check/,
  );
  await assert.rejects(
    db.query(`insert into public.course_assignment_submissions (assignment_id, user_id, link_url) values ($1, $2, 'https://x.co/a b')`, [a, ANA]),
    /check/,
  );
  await assert.rejects(
    db.query(`insert into public.course_assignment_submissions (assignment_id, user_id) values ($1, $2)`, [a, ANA]),
    /course_assignment_submissions_content/,
  );
  await db.query(`insert into public.course_assignment_submissions (assignment_id, user_id, status) values ($1, $2, 'excused')`, [a, ANA]);
  await assert.rejects(
    db.query(`insert into public.course_assignment_submissions (assignment_id, user_id, body) values ($1, $2, 'again')`, [a, ANA]),
    /unique|duplicate/,
  );
  await assert.rejects(
    db.query(`insert into public.course_assignments (cohort_id, title, release_mode) values ($1, 'x', 'course_week')`, [FALL]),
    /course_assignments_week/,
  );
  await assert.rejects(
    db.query(`insert into public.course_assignments (cohort_id, title, opens_at, due_at) values ($1, 'x', now(), now() - interval '1 hour')`, [FALL]),
    /course_assignments_window/,
  );
  await db.query(`delete from public.cohorts where id = $1`, [FALL]);
  const left = await db.query<any>(`select count(*)::int as n from public.course_assignment_submissions`);
  assert.equal(left.rows[0].n, 1); // only Ola's, in the other cohort
});

test("check-ins become read-only; roles, links, lessons, email and Demo Day are cleaned up", async () => {
  const db = await setup();
  await db.exec(migration); // twice
  const read = await as(db, ANA, `select accomplished from public.student_checkins`);
  assert.equal(read.rows.length, 1);
  await assert.rejects(
    as(db, ANA, `insert into public.student_checkins (user_id, week_start) values ('${ANA}', '2026-10-12')`),
    /row-level security/,
  );
  const upd = await as(db, ANA, `update public.student_checkins set accomplished = 'x' returning id`);
  assert.equal(upd.rows.length, 0);
  await assert.rejects(
    as(db, MENTOR, `insert into public.checkin_feedback (checkin_id, author_id, body) values (gen_random_uuid(), '${MENTOR}', 'x')`),
    /row-level security/,
  );

  const roles = await db.query<any>(`select slug, permissions from public.app_roles order by slug`);
  const intern = roles.rows.find((r) => r.slug === "intern").permissions;
  assert.deepEqual(intern, ["people.view", "course.manage", "assignments.manage"]);
  assert.deepEqual(roles.rows.find((r) => r.slug === "admin").permissions, ["*"]);

  const notes = await db.query<any>(`select type, link, read_at from public.notifications`);
  const note = (type: string) => notes.rows.find((r) => r.type === type);
  assert.equal(note("checkin_feedback").link, "/dashboard/assignments");
  assert.equal(note("checkin_submitted").link, "/mentor/assignments");
  assert.equal(note("intervention").link, "/mentor/students/x");
  assert.equal(note("discord_blocker").link, null); // the at-risk queue never showed blockers
  assert.equal(note("at_risk").link, "/admin/assignments?filter=missing");
  assert.equal(note("pulse").link, "/admin");
  assert.equal(note("health").link, "/admin/assignments");
  assert.notEqual(note("intervention").read_at, null);
  assert.notEqual(note("checkin_submitted").read_at, null);
  assert.equal(note("checkin_feedback").read_at, null);

  const lessons = await db.query<any>(`select id, title, description from public.lessons`);
  const lesson = (id: string) => lessons.rows.find((r) => r.id === id);
  assert.equal(
    lesson(LESSON).description,
    "- [Assignments](/dashboard/assignments): once a week.\nSubmit your [weekly update](/dashboard/assignments). See /dashboard/assignments?x=1",
  );
  assert.equal(lesson(LESSON2).title, "The One-Sentence Startup and Your First Weekly Update");
  assert.equal(
    lesson(LESSON2).description,
    [
      "## Your first weekly update",
      "",
      "The [weekly update](/dashboard/assignments) asks three things. The blockers line is the one we read first.",
      "",
      "4. Submit your [weekly update](/dashboard/assignments). Numbers first, then the demand test, and at least one honest line on blockers, even if it's small.",
      "",
      "| 10 | Weekly update | Submitted |",
    ].join("\n"),
  );
  // A lesson that never linked the check-in page is left alone.
  assert.equal(lesson(LESSON3).description, "Hold a weekly check-in with your cofounder.");

  const mentorRole = await db.query<any>(`select description from public.app_roles where slug = 'mentor'`);
  assert.equal(mentorRole.rows[0].description, "Works with students and teams: assignments, office hours, course feedback.");

  const emails = await db.query<any>(`select key, description, body_html from public.email_templates`);
  const email = (key: string) => emails.rows.find((r) => r.key === key);
  assert.equal(
    email("cohort.next_steps").body_html,
    "<li><strong>Submit your weekly update.</strong> What you shipped, what's next, what's in the way. A mentor replies on it.</li>" +
      "<p>If you're behind, don't try to catch up on all four. Do the deliverable, say you're behind in your weekly update, and we'll sort the rest out with you.</p>",
  );
  assert.equal(
    email("cohort.week3").body_html,
    "<li><strong>Your weekly update</strong>, in Assignments.</li>" +
      "<p><strong>What's expected of you:</strong> 5–10 focused hours, the deliverable shipped by the end of the week, and a weekly update that tells the truth about how it went.</p>" +
      "<p>That's the process working, not you failing — but bring it to office hours or your weekly update before you rebuild everything on a hunch.</p>",
  );
  assert.match(email("cohort.week3").description, /module, deliverable, weekly update, office hours/);

  const tpl = await db.query<any>(`select enabled from public.email_templates where key = 'cohort.checkin_reminder'`);
  assert.equal(tpl.rows[0].enabled, false);
  const steps = await db.query<any>(`select enabled from public.email_automation_steps`);
  assert.equal(steps.rows[0].enabled, false);
  const autos = await db.query<any>(`select enabled from public.email_automations`);
  assert.equal(autos.rows[0].enabled, false);

  const ev = await db.query<any>(`select description from public.events`);
  assert.equal(ev.rows[0].description, "Students prepare a demo. Submit your links in Assignments by Wednesday, November 11 at 8:00 p.m.");
});
