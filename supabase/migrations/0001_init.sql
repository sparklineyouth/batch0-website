-- ============================================================================
-- batch0 — Initial schema
-- Run this in the Supabase SQL Editor (Dashboard → SQL → New query → Run).
-- ============================================================================

-- Extensions
create extension if not exists "pgcrypto";

-- ----------------------------------------------------------------------------
-- profiles: 1:1 with auth.users, holds role + display info
-- ----------------------------------------------------------------------------
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  full_name text,
  role text not null default 'student' check (role in ('student','teacher','admin')),
  stripe_customer_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Auto-create a profile row when a new auth user signs up
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, email, full_name)
  values (new.id, new.email, coalesce(new.raw_user_meta_data->>'full_name', ''));
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- ----------------------------------------------------------------------------
-- cohorts
-- ----------------------------------------------------------------------------
create table if not exists public.cohorts (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  starts_on date,
  ends_on date,
  capacity integer not null default 24,
  status text not null default 'upcoming' check (status in ('upcoming','active','completed','cancelled')),
  price_cents integer not null default 9700,
  created_at timestamptz not null default now()
);

-- Seed first cohort
insert into public.cohorts (name, starts_on, ends_on, capacity, status, price_cents)
select 'Summer 2026', '2026-06-15', '2026-07-13', 24, 'upcoming', 9700
where not exists (select 1 from public.cohorts);

-- ----------------------------------------------------------------------------
-- applications
-- Lifecycle: draft -> submitted -> accepted|rejected -> paid -> enrolled
-- ----------------------------------------------------------------------------
create table if not exists public.applications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  cohort_id uuid references public.cohorts(id) on delete set null,
  status text not null default 'draft' check (status in ('draft','submitted','accepted','rejected','paid','enrolled','withdrawn')),
  -- Application fields
  full_name text,
  age integer,
  grade text,
  school text,
  city text,
  country text,
  parent_email text,
  why_join text,
  startup_idea text,
  experience text,
  hours_per_week integer,
  referral_source text,
  -- Workflow
  submitted_at timestamptz,
  reviewed_at timestamptz,
  reviewed_by uuid references auth.users(id),
  review_notes text,
  paid_at timestamptz,
  stripe_session_id text,
  stripe_payment_intent_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, cohort_id)
);

create index if not exists applications_user_id_idx on public.applications(user_id);
create index if not exists applications_status_idx on public.applications(status);

-- ----------------------------------------------------------------------------
-- enrollments: only after payment confirmed
-- ----------------------------------------------------------------------------
create table if not exists public.enrollments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  cohort_id uuid not null references public.cohorts(id) on delete cascade,
  application_id uuid references public.applications(id) on delete set null,
  enrolled_at timestamptz not null default now(),
  unique (user_id, cohort_id)
);

-- ----------------------------------------------------------------------------
-- modules + lessons (course content)
-- ----------------------------------------------------------------------------
create table if not exists public.modules (
  id uuid primary key default gen_random_uuid(),
  cohort_id uuid references public.cohorts(id) on delete cascade,
  week integer not null default 1,
  title text not null,
  summary text,
  position integer not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists public.lessons (
  id uuid primary key default gen_random_uuid(),
  module_id uuid not null references public.modules(id) on delete cascade,
  title text not null,
  description text,
  video_path text,        -- path in storage bucket 'course-videos' (private)
  video_url text,         -- optional external URL fallback
  duration_seconds integer,
  materials jsonb default '[]'::jsonb,  -- [{title, path}] for files in 'course-materials'
  position integer not null default 0,
  created_at timestamptz not null default now()
);

create index if not exists lessons_module_id_idx on public.lessons(module_id);

-- ----------------------------------------------------------------------------
-- lesson_progress: per-user watch tracking
-- ----------------------------------------------------------------------------
create table if not exists public.lesson_progress (
  user_id uuid not null references public.profiles(id) on delete cascade,
  lesson_id uuid not null references public.lessons(id) on delete cascade,
  watched_seconds integer not null default 0,
  completed_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (user_id, lesson_id)
);

-- ----------------------------------------------------------------------------
-- payments: ledger of Stripe events
-- ----------------------------------------------------------------------------
create table if not exists public.payments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  application_id uuid references public.applications(id) on delete set null,
  cohort_id uuid references public.cohorts(id) on delete set null,
  stripe_session_id text,
  stripe_payment_intent_id text,
  amount_cents integer not null,
  currency text not null default 'usd',
  status text not null check (status in ('pending','succeeded','failed','refunded')),
  created_at timestamptz not null default now()
);

create index if not exists payments_user_id_idx on public.payments(user_id);

-- ----------------------------------------------------------------------------
-- site_settings: key/value for admin-controlled site config
-- ----------------------------------------------------------------------------
create table if not exists public.site_settings (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);

insert into public.site_settings (key, value) values
  ('contact_email', '"batch0.youth@gmail.com"'),
  ('applications_open', 'true'),
  ('active_cohort_name', '"Summer 2026"')
on conflict (key) do nothing;

-- ============================================================================
-- Helper: is_admin()
-- ============================================================================
create or replace function public.is_admin(uid uuid)
returns boolean
language sql
stable
security definer set search_path = public
as $$
  select exists (
    select 1 from public.profiles
    where id = uid and role in ('admin','teacher')
  );
$$;

-- ============================================================================
-- Row Level Security
-- ============================================================================
alter table public.profiles enable row level security;
alter table public.cohorts enable row level security;
alter table public.applications enable row level security;
alter table public.enrollments enable row level security;
alter table public.modules enable row level security;
alter table public.lessons enable row level security;
alter table public.lesson_progress enable row level security;
alter table public.payments enable row level security;
alter table public.site_settings enable row level security;

-- profiles
drop policy if exists "profiles self read" on public.profiles;
create policy "profiles self read" on public.profiles
  for select using (auth.uid() = id or public.is_admin(auth.uid()));

drop policy if exists "profiles self update" on public.profiles;
create policy "profiles self update" on public.profiles
  for update using (auth.uid() = id) with check (auth.uid() = id);

drop policy if exists "profiles admin update" on public.profiles;
create policy "profiles admin update" on public.profiles
  for update using (public.is_admin(auth.uid())) with check (public.is_admin(auth.uid()));

-- cohorts: readable by all signed-in users; writable by admins
drop policy if exists "cohorts read" on public.cohorts;
create policy "cohorts read" on public.cohorts
  for select using (auth.role() = 'authenticated');

drop policy if exists "cohorts admin write" on public.cohorts;
create policy "cohorts admin write" on public.cohorts
  for all using (public.is_admin(auth.uid())) with check (public.is_admin(auth.uid()));

-- applications: own + admin
drop policy if exists "applications self select" on public.applications;
create policy "applications self select" on public.applications
  for select using (user_id = auth.uid() or public.is_admin(auth.uid()));

drop policy if exists "applications self insert" on public.applications;
create policy "applications self insert" on public.applications
  for insert with check (user_id = auth.uid());

drop policy if exists "applications self update draft" on public.applications;
-- Users can only update their own application while it's still a draft, and the
-- new status must remain draft or transition to 'submitted'. Status changes
-- beyond that (accepted, rejected, paid, enrolled) must come from the
-- service-role admin client.
create policy "applications self update draft" on public.applications
  for update
  using (user_id = auth.uid() and status = 'draft')
  with check (user_id = auth.uid() and status in ('draft','submitted'));

drop policy if exists "applications admin all" on public.applications;
create policy "applications admin all" on public.applications
  for all using (public.is_admin(auth.uid())) with check (public.is_admin(auth.uid()));

-- enrollments: own + admin (writes via service role / webhook)
drop policy if exists "enrollments self select" on public.enrollments;
create policy "enrollments self select" on public.enrollments
  for select using (user_id = auth.uid() or public.is_admin(auth.uid()));

drop policy if exists "enrollments admin write" on public.enrollments;
create policy "enrollments admin write" on public.enrollments
  for all using (public.is_admin(auth.uid())) with check (public.is_admin(auth.uid()));

-- modules + lessons: enrolled users see their cohort; admins see all
drop policy if exists "modules read enrolled" on public.modules;
create policy "modules read enrolled" on public.modules
  for select using (
    public.is_admin(auth.uid())
    or exists (
      select 1 from public.enrollments e
      where e.user_id = auth.uid() and e.cohort_id = modules.cohort_id
    )
  );

drop policy if exists "modules admin write" on public.modules;
create policy "modules admin write" on public.modules
  for all using (public.is_admin(auth.uid())) with check (public.is_admin(auth.uid()));

drop policy if exists "lessons read enrolled" on public.lessons;
create policy "lessons read enrolled" on public.lessons
  for select using (
    public.is_admin(auth.uid())
    or exists (
      select 1 from public.modules m
      join public.enrollments e on e.cohort_id = m.cohort_id
      where m.id = lessons.module_id and e.user_id = auth.uid()
    )
  );

drop policy if exists "lessons admin write" on public.lessons;
create policy "lessons admin write" on public.lessons
  for all using (public.is_admin(auth.uid())) with check (public.is_admin(auth.uid()));

-- lesson_progress: own + admin read
drop policy if exists "progress self all" on public.lesson_progress;
create policy "progress self all" on public.lesson_progress
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists "progress admin read" on public.lesson_progress;
create policy "progress admin read" on public.lesson_progress
  for select using (public.is_admin(auth.uid()));

-- payments: own + admin
drop policy if exists "payments self select" on public.payments;
create policy "payments self select" on public.payments
  for select using (user_id = auth.uid() or public.is_admin(auth.uid()));

drop policy if exists "payments admin all" on public.payments;
create policy "payments admin all" on public.payments
  for all using (public.is_admin(auth.uid())) with check (public.is_admin(auth.uid()));

-- site_settings: anyone signed in can read; admins write
drop policy if exists "settings read" on public.site_settings;
create policy "settings read" on public.site_settings
  for select using (true);

drop policy if exists "settings admin write" on public.site_settings;
create policy "settings admin write" on public.site_settings
  for all using (public.is_admin(auth.uid())) with check (public.is_admin(auth.uid()));

-- ============================================================================
-- updated_at triggers
-- ============================================================================
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end;
$$;

drop trigger if exists touch_profiles on public.profiles;
create trigger touch_profiles before update on public.profiles
  for each row execute procedure public.touch_updated_at();

drop trigger if exists touch_applications on public.applications;
create trigger touch_applications before update on public.applications
  for each row execute procedure public.touch_updated_at();

drop trigger if exists touch_progress on public.lesson_progress;
create trigger touch_progress before update on public.lesson_progress
  for each row execute procedure public.touch_updated_at();

-- ============================================================================
-- Storage buckets (private; signed URLs only)
-- ============================================================================
insert into storage.buckets (id, name, public)
values ('course-videos', 'course-videos', false)
on conflict (id) do nothing;

insert into storage.buckets (id, name, public)
values ('course-materials', 'course-materials', false)
on conflict (id) do nothing;

-- Storage RLS: only admins can write; enrolled users + admins can read via signed URLs
drop policy if exists "course-videos admin write" on storage.objects;
create policy "course-videos admin write" on storage.objects
  for all to authenticated
  using (bucket_id = 'course-videos' and public.is_admin(auth.uid()))
  with check (bucket_id = 'course-videos' and public.is_admin(auth.uid()));

drop policy if exists "course-materials admin write" on storage.objects;
create policy "course-materials admin write" on storage.objects
  for all to authenticated
  using (bucket_id = 'course-materials' and public.is_admin(auth.uid()))
  with check (bucket_id = 'course-materials' and public.is_admin(auth.uid()));

-- (Read access is granted via signed URLs generated server-side; no broad read
-- policy needed since the service role generates URLs scoped per-request.)
