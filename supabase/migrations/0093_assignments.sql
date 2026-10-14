-- ============================================================================
-- 0093 — Assignment tracker (replaces weekly check-ins).
--
-- Three tables. New names on purpose: `assignments` / `assignment_submissions`
-- were created in 0004 and dropped in 0013, and re-running either of those
-- files must never touch these.
--
--   course_assignments            what's due, for which cohort, when.
--                                 opens_at/due_at are stored; course_week rows
--                                 keep week + due offset/time so the app can
--                                 recompute them when the cohort start or a
--                                 module's week moves (America/New_York).
--   course_assignment_targets     audience = 'students': who it's for.
--   course_assignment_submissions one row per (assignment, student).
--
-- Every write goes through a service-role server action. Signed-in users get
-- READ policies only, and insert/update/delete is revoked as well.
--
-- Also: check-in tables become read-only, retired permission keys are removed
-- from roles, check-in links in notifications/lessons/Demo Day are repointed,
-- the check-in reminder email is disabled, and the running Fall cohort gets a
-- "Weekly update" series (weeks 5–9) plus its Demo Day submission.
--
-- Run in Supabase SQL Editor. Idempotent / safe to re-run.
-- Assumes 0001..0092 are applied.
-- ============================================================================

create table if not exists public.course_assignments (
  id uuid primary key default gen_random_uuid(),
  cohort_id uuid not null references public.cohorts(id) on delete cascade,
  module_id uuid references public.modules(id) on delete set null,
  lesson_id uuid references public.lessons(id) on delete set null,
  series_id uuid,
  week smallint check (week between 1 and 52),
  title text not null check (char_length(btrim(title)) between 1 and 200),
  instructions text not null default '' check (char_length(instructions) <= 20000),
  audience text not null default 'cohort' check (audience in ('cohort', 'students')),
  release_mode text not null default 'now' check (release_mode in ('now', 'date', 'course_week')),
  opens_at timestamptz,
  due_at timestamptz,
  due_day_offset smallint check (due_day_offset between 0 and 13),
  due_local_time time,
  submission_type text not null default 'text_or_link'
    check (submission_type in ('text_or_link', 'link', 'text')),
  status text not null default 'published' check (status in ('draft', 'published', 'archived')),
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint course_assignments_window check (due_at is null or opens_at is null or due_at > opens_at),
  constraint course_assignments_week check (release_mode <> 'course_week' or week is not null)
);

create index if not exists course_assignments_cohort_due_idx
  on public.course_assignments (cohort_id, due_at);
create index if not exists course_assignments_lesson_idx
  on public.course_assignments (lesson_id) where lesson_id is not null;
create index if not exists course_assignments_module_idx
  on public.course_assignments (module_id) where module_id is not null;
create index if not exists course_assignments_series_idx
  on public.course_assignments (series_id) where series_id is not null;

drop trigger if exists touch_course_assignments on public.course_assignments;
create trigger touch_course_assignments before update on public.course_assignments
  for each row execute procedure public.touch_updated_at();

create table if not exists public.course_assignment_targets (
  assignment_id uuid not null references public.course_assignments(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (assignment_id, user_id)
);

create index if not exists course_assignment_targets_user_idx
  on public.course_assignment_targets (user_id);

create table if not exists public.course_assignment_submissions (
  id uuid primary key default gen_random_uuid(),
  assignment_id uuid not null references public.course_assignments(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  body text check (body is null or char_length(body) <= 10000),
  link_url text check (
    link_url is null
    or (char_length(link_url) <= 2048 and link_url ~* '^https://[^[:space:]]+$')
  ),
  status text not null default 'submitted'
    check (status in ('submitted', 'reviewed', 'returned', 'excused')),
  submitted_at timestamptz,
  -- Stamped by the server: submitted after due_at.
  late boolean not null default false,
  feedback text check (feedback is null or char_length(feedback) <= 4000),
  reviewed_by uuid references public.profiles(id) on delete set null,
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (assignment_id, user_id),
  constraint course_assignment_submissions_content
    check (status = 'excused' or body is not null or link_url is not null)
);

create index if not exists course_assignment_submissions_user_idx
  on public.course_assignment_submissions (user_id, updated_at desc);
create index if not exists course_assignment_submissions_queue_idx
  on public.course_assignment_submissions (assignment_id, status);

drop trigger if exists touch_course_assignment_submissions on public.course_assignment_submissions;
create trigger touch_course_assignment_submissions before update on public.course_assignment_submissions
  for each row execute procedure public.touch_updated_at();

alter table public.course_assignments enable row level security;
alter table public.course_assignment_targets enable row level security;
alter table public.course_assignment_submissions enable row level security;

-- ----------------------------------------------------------------------------
-- Mentor scope, the same rule as lib/mentor-scope.ts: a direct
-- mentor_assignments row for the student, or one in any cohort they're
-- enrolled in. Reads auth.uid() itself (0089/0092 style), so over /rest/v1/rpc
-- it only ever answers for the caller.
-- ----------------------------------------------------------------------------
create or replace function public.mentor_covers_student(p_student uuid)
returns boolean
language sql
stable
security definer set search_path = public
as $$
  select exists (
    select 1 from public.mentor_assignments m
    where m.mentor_id = auth.uid()
      and (
        m.student_id = p_student
        or m.cohort_id in (select e.cohort_id from public.enrollments e where e.user_id = p_student)
      )
  );
$$;

-- ----------------------------------------------------------------------------
-- Read policies. Staff (mentor.panel) see every assignment definition, which is
-- course content; student work is limited to the mentor's scope.
-- The targets policy doesn't reference course_assignments, so no recursion.
-- ----------------------------------------------------------------------------
drop policy if exists "course_assignments read" on public.course_assignments;
create policy "course_assignments read" on public.course_assignments
  for select using (
    public.has_permission(auth.uid(), 'assignments.manage')
    or public.is_staff(auth.uid())
    or (
      status = 'published'
      and (opens_at is null or opens_at <= now())
      and exists (
        select 1 from public.enrollments e
        where e.user_id = auth.uid() and e.cohort_id = course_assignments.cohort_id
      )
      and (
        audience = 'cohort'
        or exists (
          select 1 from public.course_assignment_targets t
          where t.assignment_id = course_assignments.id and t.user_id = auth.uid()
        )
      )
    )
  );

drop policy if exists "course_assignment_targets read" on public.course_assignment_targets;
create policy "course_assignment_targets read" on public.course_assignment_targets
  for select using (
    user_id = auth.uid()
    or public.has_permission(auth.uid(), 'assignments.manage')
    or public.is_staff(auth.uid())
  );

drop policy if exists "course_assignment_submissions read" on public.course_assignment_submissions;
create policy "course_assignment_submissions read" on public.course_assignment_submissions
  for select using (
    user_id = auth.uid()
    or public.has_permission(auth.uid(), 'assignments.manage')
    or (public.is_staff(auth.uid()) and public.mentor_covers_student(course_assignment_submissions.user_id))
  );

revoke insert, update, delete on public.course_assignments from anon, authenticated;
revoke insert, update, delete on public.course_assignment_targets from anon, authenticated;
revoke insert, update, delete on public.course_assignment_submissions from anon, authenticated;

-- ----------------------------------------------------------------------------
-- Check-ins: kept for the record, read-only from now on.
-- ----------------------------------------------------------------------------
drop policy if exists "checkins self all" on public.student_checkins;
drop policy if exists "checkins self read" on public.student_checkins;
create policy "checkins self read" on public.student_checkins
  for select using (user_id = auth.uid());

drop policy if exists "checkin_feedback staff write" on public.checkin_feedback;

-- ----------------------------------------------------------------------------
-- Roles: Pulse and the at-risk queue are gone. An intern who runs the course
-- also runs its assignments (0059 pattern).
-- ----------------------------------------------------------------------------
update public.app_roles
set permissions = array_remove(array_remove(permissions, 'pulse.view'), 'interventions.manage')
where permissions && array['pulse.view', 'interventions.manage']::text[];

update public.app_roles
set permissions = array_append(permissions, 'assignments.manage')
where slug = 'intern'
  and permissions @> array['course.manage']::text[]
  and not (permissions @> array['assignments.manage']::text[])
  and not (permissions @> array['*']::text[]);

-- ----------------------------------------------------------------------------
-- Old links and prompts.
-- ----------------------------------------------------------------------------
update public.notifications set link = '/dashboard/assignments'
where link like '/dashboard/checkin%';
update public.notifications set link = '/mentor/assignments'
where link like '/mentor/checkins%';
-- "Post your check-in" / "X missed two check-ins" can no longer be acted on.
update public.notifications set read_at = now()
where type in ('checkin_nudge', 'intervention') and read_at is null;

update public.lessons
set description = replace(replace(replace(replace(replace(description,
  '[Check-in](/dashboard/checkin)', '[Assignments](/dashboard/assignments)'),
  '[weekly check-in](/dashboard/checkin)', '[weekly update](/dashboard/assignments)'),
  '[check-in](/dashboard/checkin)', '[weekly update](/dashboard/assignments)'),
  'If something is a milestone (first stranger interview, first kill, first signup), mark it. The cohort should see that those happen.',
  'If something is a milestone (first stranger interview, first kill, first signup), say so.'),
  '/dashboard/checkin', '/dashboard/assignments')
where description like '%/dashboard/checkin%';

-- The check-in reminder email: disabled (system rows can't be deleted), and
-- any automation step sending it switched off.
update public.email_automation_steps set enabled = false
where enabled
  and template_id in (select id from public.email_templates where key = 'cohort.checkin_reminder');
update public.email_automations a set enabled = false
where a.enabled
  and exists (
    select 1 from public.email_automation_steps s
    join public.email_templates t on t.id = s.template_id
    where s.automation_id = a.id and t.key = 'cohort.checkin_reminder'
  )
  and not exists (
    select 1 from public.email_automation_steps s
    where s.automation_id = a.id and s.enabled
  );
update public.email_templates
set enabled = false, description = 'Retired with weekly check-ins (0093). Assignments send their own reminders.'
where key = 'cohort.checkin_reminder' and (enabled or coalesce(description, '') not like 'Retired%');

-- ----------------------------------------------------------------------------
-- Fall 2026 (running, week 5 of 9). Fixed ids, so a re-run inserts nothing.
-- Dates follow the cohort's start date in New York time.
-- ----------------------------------------------------------------------------
insert into public.course_assignments (
  id, cohort_id, series_id, week, title, instructions, audience, release_mode,
  opens_at, due_at, due_day_offset, due_local_time, submission_type, status
)
select
  ('a0930000-0000-4000-8000-00000000000' || w)::uuid,
  c.id,
  'a0930000-0000-4000-8000-000000000000'::uuid,
  w,
  'Weekly update',
  E'What you shipped this week, what''s next, and what''s in the way.\n\nNumbers over adjectives. Write it here or link a Google Doc.',
  'cohort',
  'course_week',
  ((c.starts_on + 7 * (w - 1))::timestamp) at time zone 'America/New_York',
  ((c.starts_on + 7 * (w - 1) + 6)::timestamp + time '23:59') at time zone 'America/New_York',
  6,
  time '23:59',
  'text_or_link',
  'published'
from public.cohorts c
cross join generate_series(5, 9) as w
where c.id = '6350c6ac-70f0-4f53-93d5-c99e397185a9'
  and c.starts_on is not null
on conflict (id) do nothing;

insert into public.course_assignments (
  id, cohort_id, title, instructions, audience, release_mode,
  opens_at, due_at, submission_type, status
)
select
  'a0930000-0000-4000-8000-0000000000dd'::uuid,
  c.id,
  'Demo Day submission',
  E'Put your three-minute demo recording (or written narration), PDF pitch deck and claims/evidence appendix in one Google Drive folder shared as "Anyone with the link can view". Submit the folder link. Teammates can submit the same link.',
  'cohort',
  'now',
  now(),
  '2026-11-12T01:00:00Z'::timestamptz,
  'link',
  'published'
from public.cohorts c
where c.id = '6350c6ac-70f0-4f53-93d5-c99e397185a9'
on conflict (id) do nothing;

update public.events
set description = replace(description,
  'Submit through Files and include the links in your Check-in by',
  'Submit your links in Assignments by')
where cohort_id = '6350c6ac-70f0-4f53-93d5-c99e397185a9'
  and type = 'demo_day'
  and description like '%Submit through Files and include the links in your Check-in by%';

comment on table public.course_assignments is
  'Assignment tracker (0093). Writes via service-role server actions only.';

notify pgrst, 'reload schema';
