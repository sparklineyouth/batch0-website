-- ============================================================================
-- 0005 — Platform v2: notifications, audit log, mentor + investor roles,
--         events, teams, referrals, AI conversations, lesson Q&A, quizzes,
--         Stripe webhook idempotency, rate limits.
--
-- Run in Supabase SQL Editor. Idempotent / safe to re-run.
-- Assumes 0001..0004 applied.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Roles: add 'mentor' and 'investor'.
-- is_admin / is_staff stay scoped to admin / admin+professor.
-- New helpers for mentor + investor.
-- ----------------------------------------------------------------------------
alter table public.profiles drop constraint if exists profiles_role_check;
alter table public.profiles
  add constraint profiles_role_check
  check (role in ('student', 'professor', 'admin', 'mentor', 'investor'));

create or replace function public.is_mentor(uid uuid)
returns boolean
language sql
stable
security definer set search_path = public
as $$
  select exists (
    select 1 from public.profiles
    where id = uid and role in ('mentor', 'admin')
  );
$$;

create or replace function public.is_investor(uid uuid)
returns boolean
language sql
stable
security definer set search_path = public
as $$
  select exists (
    select 1 from public.profiles
    where id = uid and role in ('investor', 'admin')
  );
$$;

-- ----------------------------------------------------------------------------
-- Profiles: referral code + AI startup context.
-- ----------------------------------------------------------------------------
alter table public.profiles
  add column if not exists referral_code text unique,
  add column if not exists ai_context jsonb;

-- Backfill referral codes for any existing profiles.
update public.profiles
set referral_code = lower(substring(replace(gen_random_uuid()::text, '-', '') for 8))
where referral_code is null;

-- Make referral_code generated automatically for new rows.
create or replace function public.gen_referral_code()
returns trigger language plpgsql as $$
begin
  if new.referral_code is null then
    new.referral_code := lower(substring(replace(gen_random_uuid()::text, '-', '') for 8));
  end if;
  return new;
end;
$$;

drop trigger if exists profiles_referral_code on public.profiles;
create trigger profiles_referral_code
  before insert on public.profiles
  for each row execute procedure public.gen_referral_code();

-- ----------------------------------------------------------------------------
-- Applications: capture referral source code (separate from free-text source).
-- ----------------------------------------------------------------------------
alter table public.applications
  add column if not exists referral_code text;

-- ----------------------------------------------------------------------------
-- Notifications
-- ----------------------------------------------------------------------------
create table if not exists public.notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  type text not null,
  title text not null,
  body text,
  link text,
  read_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists notifications_user_id_idx
  on public.notifications(user_id, read_at, created_at desc);

alter table public.notifications enable row level security;

drop policy if exists "notifications self select" on public.notifications;
create policy "notifications self select" on public.notifications
  for select using (user_id = auth.uid() or public.is_admin(auth.uid()));

drop policy if exists "notifications self update" on public.notifications;
create policy "notifications self update" on public.notifications
  for update using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ----------------------------------------------------------------------------
-- Audit log
-- ----------------------------------------------------------------------------
create table if not exists public.audit_log (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid references public.profiles(id) on delete set null,
  actor_email text,
  action text not null,
  target_type text,
  target_id text,
  payload jsonb,
  created_at timestamptz not null default now()
);

create index if not exists audit_log_created_at_idx on public.audit_log(created_at desc);
create index if not exists audit_log_action_idx on public.audit_log(action);

alter table public.audit_log enable row level security;

drop policy if exists "audit_log admin read" on public.audit_log;
create policy "audit_log admin read" on public.audit_log
  for select using (public.is_admin(auth.uid()));

-- ----------------------------------------------------------------------------
-- Events (Demo Day, office hours, workshops)
-- ----------------------------------------------------------------------------
create table if not exists public.events (
  id uuid primary key default gen_random_uuid(),
  cohort_id uuid references public.cohorts(id) on delete cascade,
  type text not null check (type in ('demo_day','office_hours','workshop','other')),
  title text not null,
  description text,
  starts_at timestamptz not null,
  ends_at timestamptz,
  location text,
  zoom_url text,
  recording_url text,
  visibility text not null default 'enrolled' check (visibility in ('enrolled','staff','public')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists events_cohort_idx on public.events(cohort_id, starts_at);

drop trigger if exists touch_events on public.events;
create trigger touch_events before update on public.events
  for each row execute procedure public.touch_updated_at();

alter table public.events enable row level security;

drop policy if exists "events read" on public.events;
create policy "events read" on public.events
  for select using (
    visibility = 'public'
    or public.is_staff(auth.uid())
    or (
      visibility = 'enrolled'
      and exists (
        select 1 from public.enrollments e
        where e.user_id = auth.uid() and e.cohort_id = events.cohort_id
      )
    )
  );

drop policy if exists "events staff write" on public.events;
create policy "events staff write" on public.events
  for all using (public.is_staff(auth.uid())) with check (public.is_staff(auth.uid()));

-- ----------------------------------------------------------------------------
-- Mentor assignments
-- ----------------------------------------------------------------------------
create table if not exists public.mentor_assignments (
  id uuid primary key default gen_random_uuid(),
  mentor_id uuid not null references public.profiles(id) on delete cascade,
  student_id uuid not null references public.profiles(id) on delete cascade,
  cohort_id uuid references public.cohorts(id) on delete cascade,
  notes text,
  created_at timestamptz not null default now(),
  unique (mentor_id, student_id)
);

create index if not exists mentor_assignments_mentor_idx on public.mentor_assignments(mentor_id);
create index if not exists mentor_assignments_student_idx on public.mentor_assignments(student_id);

alter table public.mentor_assignments enable row level security;

drop policy if exists "mentor_assignments read" on public.mentor_assignments;
create policy "mentor_assignments read" on public.mentor_assignments
  for select using (
    mentor_id = auth.uid()
    or student_id = auth.uid()
    or public.is_admin(auth.uid())
  );

drop policy if exists "mentor_assignments admin write" on public.mentor_assignments;
create policy "mentor_assignments admin write" on public.mentor_assignments
  for all using (public.is_admin(auth.uid())) with check (public.is_admin(auth.uid()));

drop policy if exists "mentor_assignments mentor notes" on public.mentor_assignments;
create policy "mentor_assignments mentor notes" on public.mentor_assignments
  for update using (mentor_id = auth.uid()) with check (mentor_id = auth.uid());

-- ----------------------------------------------------------------------------
-- Cohorts: add slug for public URLs
-- ----------------------------------------------------------------------------
alter table public.cohorts add column if not exists slug text unique;
update public.cohorts set slug = lower(regexp_replace(name, '[^a-zA-Z0-9]+', '-', 'g'))
  where slug is null;

-- ----------------------------------------------------------------------------
-- Teams + members
-- ----------------------------------------------------------------------------
create table if not exists public.teams (
  id uuid primary key default gen_random_uuid(),
  cohort_id uuid not null references public.cohorts(id) on delete cascade,
  slug text not null,
  name text not null,
  tagline text,
  description text,
  logo_url text,
  pitch_video_url text,
  pitch_deck_url text,
  website_url text,
  is_public boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (cohort_id, slug)
);

drop trigger if exists touch_teams on public.teams;
create trigger touch_teams before update on public.teams
  for each row execute procedure public.touch_updated_at();

alter table public.teams enable row level security;

drop policy if exists "teams read" on public.teams;
create policy "teams read" on public.teams
  for select using (
    is_public
    or public.is_staff(auth.uid())
    or public.is_investor(auth.uid())
    or exists (
      select 1 from public.team_members tm
      where tm.team_id = teams.id and tm.user_id = auth.uid()
    )
  );

drop policy if exists "teams member write" on public.teams;
create policy "teams member write" on public.teams
  for update using (
    public.is_staff(auth.uid())
    or exists (
      select 1 from public.team_members tm
      where tm.team_id = teams.id and tm.user_id = auth.uid()
    )
  ) with check (
    public.is_staff(auth.uid())
    or exists (
      select 1 from public.team_members tm
      where tm.team_id = teams.id and tm.user_id = auth.uid()
    )
  );

drop policy if exists "teams admin write" on public.teams;
create policy "teams admin write" on public.teams
  for all using (public.is_admin(auth.uid())) with check (public.is_admin(auth.uid()));

create table if not exists public.team_members (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references public.teams(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  role text not null default 'member',
  created_at timestamptz not null default now(),
  unique (team_id, user_id)
);

create index if not exists team_members_team_idx on public.team_members(team_id);
create index if not exists team_members_user_idx on public.team_members(user_id);

alter table public.team_members enable row level security;

drop policy if exists "team_members read" on public.team_members;
create policy "team_members read" on public.team_members
  for select using (
    public.is_staff(auth.uid())
    or public.is_investor(auth.uid())
    or user_id = auth.uid()
    or exists (
      select 1 from public.team_members tm
      where tm.team_id = team_members.team_id and tm.user_id = auth.uid()
    )
  );

drop policy if exists "team_members admin write" on public.team_members;
create policy "team_members admin write" on public.team_members
  for all using (public.is_admin(auth.uid())) with check (public.is_admin(auth.uid()));

-- ----------------------------------------------------------------------------
-- Investor interests
-- ----------------------------------------------------------------------------
create table if not exists public.investor_interests (
  id uuid primary key default gen_random_uuid(),
  investor_id uuid not null references public.profiles(id) on delete cascade,
  team_id uuid not null references public.teams(id) on delete cascade,
  level text not null check (level in ('watching','interested','committed','passed')),
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (investor_id, team_id)
);

create index if not exists investor_interests_team_idx on public.investor_interests(team_id);
create index if not exists investor_interests_investor_idx on public.investor_interests(investor_id);

drop trigger if exists touch_investor_interests on public.investor_interests;
create trigger touch_investor_interests before update on public.investor_interests
  for each row execute procedure public.touch_updated_at();

alter table public.investor_interests enable row level security;

drop policy if exists "investor_interests own" on public.investor_interests;
create policy "investor_interests own" on public.investor_interests
  for all using (
    investor_id = auth.uid() or public.is_admin(auth.uid())
  ) with check (
    investor_id = auth.uid() or public.is_admin(auth.uid())
  );

-- ----------------------------------------------------------------------------
-- Lesson Q&A (threaded)
-- ----------------------------------------------------------------------------
create table if not exists public.lesson_comments (
  id uuid primary key default gen_random_uuid(),
  lesson_id uuid not null references public.lessons(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  parent_id uuid references public.lesson_comments(id) on delete cascade,
  body text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists lesson_comments_lesson_idx
  on public.lesson_comments(lesson_id, created_at);

drop trigger if exists touch_lesson_comments on public.lesson_comments;
create trigger touch_lesson_comments before update on public.lesson_comments
  for each row execute procedure public.touch_updated_at();

alter table public.lesson_comments enable row level security;

drop policy if exists "lesson_comments read enrolled" on public.lesson_comments;
create policy "lesson_comments read enrolled" on public.lesson_comments
  for select using (
    public.is_staff(auth.uid())
    or exists (
      select 1 from public.lessons l
      join public.modules m on m.id = l.module_id
      join public.enrollments e on e.cohort_id = m.cohort_id
      where l.id = lesson_comments.lesson_id and e.user_id = auth.uid()
    )
  );

drop policy if exists "lesson_comments self insert" on public.lesson_comments;
create policy "lesson_comments self insert" on public.lesson_comments
  for insert with check (
    user_id = auth.uid() and (
      public.is_staff(auth.uid())
      or exists (
        select 1 from public.lessons l
        join public.modules m on m.id = l.module_id
        join public.enrollments e on e.cohort_id = m.cohort_id
        where l.id = lesson_comments.lesson_id and e.user_id = auth.uid()
      )
    )
  );

drop policy if exists "lesson_comments self update" on public.lesson_comments;
create policy "lesson_comments self update" on public.lesson_comments
  for update using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists "lesson_comments self delete" on public.lesson_comments;
create policy "lesson_comments self delete" on public.lesson_comments
  for delete using (user_id = auth.uid() or public.is_staff(auth.uid()));

-- ----------------------------------------------------------------------------
-- Lesson quizzes
-- ----------------------------------------------------------------------------
create table if not exists public.quizzes (
  id uuid primary key default gen_random_uuid(),
  lesson_id uuid not null references public.lessons(id) on delete cascade,
  title text,
  created_at timestamptz not null default now(),
  unique (lesson_id)
);

alter table public.quizzes enable row level security;

drop policy if exists "quizzes read enrolled" on public.quizzes;
create policy "quizzes read enrolled" on public.quizzes
  for select using (
    public.is_staff(auth.uid())
    or exists (
      select 1 from public.lessons l
      join public.modules m on m.id = l.module_id
      join public.enrollments e on e.cohort_id = m.cohort_id
      where l.id = quizzes.lesson_id and e.user_id = auth.uid()
    )
  );

drop policy if exists "quizzes staff write" on public.quizzes;
create policy "quizzes staff write" on public.quizzes
  for all using (public.is_staff(auth.uid())) with check (public.is_staff(auth.uid()));

create table if not exists public.quiz_questions (
  id uuid primary key default gen_random_uuid(),
  quiz_id uuid not null references public.quizzes(id) on delete cascade,
  question text not null,
  options jsonb not null,
  correct_option_id text not null,
  position integer not null default 0
);

create index if not exists quiz_questions_quiz_idx on public.quiz_questions(quiz_id, position);

alter table public.quiz_questions enable row level security;

drop policy if exists "quiz_questions read enrolled" on public.quiz_questions;
create policy "quiz_questions read enrolled" on public.quiz_questions
  for select using (
    public.is_staff(auth.uid())
    or exists (
      select 1 from public.quizzes q
      join public.lessons l on l.id = q.lesson_id
      join public.modules m on m.id = l.module_id
      join public.enrollments e on e.cohort_id = m.cohort_id
      where q.id = quiz_questions.quiz_id and e.user_id = auth.uid()
    )
  );

drop policy if exists "quiz_questions staff write" on public.quiz_questions;
create policy "quiz_questions staff write" on public.quiz_questions
  for all using (public.is_staff(auth.uid())) with check (public.is_staff(auth.uid()));

create table if not exists public.quiz_attempts (
  id uuid primary key default gen_random_uuid(),
  quiz_id uuid not null references public.quizzes(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  answers jsonb not null,
  score integer not null,
  total integer not null,
  created_at timestamptz not null default now()
);

create index if not exists quiz_attempts_user_idx on public.quiz_attempts(user_id, quiz_id, created_at desc);

alter table public.quiz_attempts enable row level security;

drop policy if exists "quiz_attempts self all" on public.quiz_attempts;
create policy "quiz_attempts self all" on public.quiz_attempts
  for all using (user_id = auth.uid() or public.is_staff(auth.uid()))
  with check (user_id = auth.uid() or public.is_staff(auth.uid()));

-- ----------------------------------------------------------------------------
-- AI conversations + messages
-- ----------------------------------------------------------------------------
create table if not exists public.ai_conversations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  title text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists ai_conversations_user_idx
  on public.ai_conversations(user_id, updated_at desc);

drop trigger if exists touch_ai_conv on public.ai_conversations;
create trigger touch_ai_conv before update on public.ai_conversations
  for each row execute procedure public.touch_updated_at();

alter table public.ai_conversations enable row level security;

drop policy if exists "ai_conversations self all" on public.ai_conversations;
create policy "ai_conversations self all" on public.ai_conversations
  for all using (user_id = auth.uid() or public.is_admin(auth.uid()))
  with check (user_id = auth.uid() or public.is_admin(auth.uid()));

create table if not exists public.ai_messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.ai_conversations(id) on delete cascade,
  role text not null check (role in ('user','assistant','system')),
  content text not null,
  created_at timestamptz not null default now()
);

create index if not exists ai_messages_conv_idx
  on public.ai_messages(conversation_id, created_at);

alter table public.ai_messages enable row level security;

drop policy if exists "ai_messages self all" on public.ai_messages;
create policy "ai_messages self all" on public.ai_messages
  for all using (
    exists (
      select 1 from public.ai_conversations c
      where c.id = ai_messages.conversation_id
        and (c.user_id = auth.uid() or public.is_admin(auth.uid()))
    )
  )
  with check (
    exists (
      select 1 from public.ai_conversations c
      where c.id = ai_messages.conversation_id
        and (c.user_id = auth.uid() or public.is_admin(auth.uid()))
    )
  );

-- ----------------------------------------------------------------------------
-- Stripe webhook idempotency
-- ----------------------------------------------------------------------------
create table if not exists public.processed_stripe_events (
  event_id text primary key,
  event_type text not null,
  processed_at timestamptz not null default now()
);

-- ----------------------------------------------------------------------------
-- Rate limits (simple counter w/ window)
-- ----------------------------------------------------------------------------
create table if not exists public.rate_limits (
  key text primary key,
  window_started_at timestamptz not null default now(),
  count integer not null default 0
);

-- Helper to atomically check + increment a rate-limit counter.
-- Returns the new count after increment. If older than `window_seconds`,
-- the counter resets first.
create or replace function public.rate_limit_check(
  p_key text,
  p_window_seconds integer
) returns integer
language plpgsql
security definer set search_path = public
as $$
declare
  v_count integer;
begin
  insert into public.rate_limits (key, window_started_at, count)
  values (p_key, now(), 1)
  on conflict (key) do update
    set window_started_at = case
          when public.rate_limits.window_started_at < now() - (p_window_seconds || ' seconds')::interval
            then now()
          else public.rate_limits.window_started_at
        end,
        count = case
          when public.rate_limits.window_started_at < now() - (p_window_seconds || ' seconds')::interval
            then 1
          else public.rate_limits.count + 1
        end
  returning count into v_count;
  return v_count;
end;
$$;

-- ----------------------------------------------------------------------------
-- Storage: public team assets bucket (logos, deck thumbnails, etc.)
-- ----------------------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('team-assets', 'team-assets', true)
on conflict (id) do nothing;

drop policy if exists "team-assets staff write" on storage.objects;
create policy "team-assets staff write" on storage.objects
  for all to authenticated
  using (
    bucket_id = 'team-assets' and (
      public.is_staff(auth.uid())
      or exists (
        select 1 from public.team_members tm
        where tm.user_id = auth.uid()
          and (storage.foldername(name))[1] = tm.team_id::text
      )
    )
  )
  with check (
    bucket_id = 'team-assets' and (
      public.is_staff(auth.uid())
      or exists (
        select 1 from public.team_members tm
        where tm.user_id = auth.uid()
          and (storage.foldername(name))[1] = tm.team_id::text
      )
    )
  );

-- ----------------------------------------------------------------------------
-- Site settings: seed v2 keys (idempotent).
-- ----------------------------------------------------------------------------
insert into public.site_settings (key, value) values
  ('discord_guild_id', '""'),
  ('discord_channel_id_announcements', '""'),
  ('discord_role_id_student', '""')
on conflict (key) do nothing;

notify pgrst, 'reload schema';
