-- ============================================================================
-- 0003 — Professor role, Stripe price sync columns, application links,
--         and richer site settings keys.
--
-- Run this in the Supabase SQL Editor. Safe to re-run.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Roles: rename 'teacher' -> 'professor', keep 'student' and 'admin'.
-- ----------------------------------------------------------------------------
update public.profiles set role = 'professor' where role = 'teacher';

alter table public.profiles drop constraint if exists profiles_role_check;
alter table public.profiles
  add constraint profiles_role_check
  check (role in ('student', 'professor', 'admin'));

-- is_admin() is preserved for backwards compatibility but now tightened to
-- ONLY admins (not professors). Use is_staff() for "admin OR professor".
create or replace function public.is_admin(uid uuid)
returns boolean
language sql
stable
security definer set search_path = public
as $$
  select exists (
    select 1 from public.profiles
    where id = uid and role = 'admin'
  );
$$;

create or replace function public.is_staff(uid uuid)
returns boolean
language sql
stable
security definer set search_path = public
as $$
  select exists (
    select 1 from public.profiles
    where id = uid and role in ('admin', 'professor')
  );
$$;

-- ----------------------------------------------------------------------------
-- Cohorts: track Stripe Product/Price so price changes stay in sync.
-- ----------------------------------------------------------------------------
alter table public.cohorts add column if not exists stripe_product_id text;
alter table public.cohorts add column if not exists stripe_price_id text;

-- ----------------------------------------------------------------------------
-- Applications: optional links the applicant can attach.
-- ----------------------------------------------------------------------------
alter table public.applications add column if not exists linkedin_url text;
alter table public.applications add column if not exists resume_url text;
alter table public.applications add column if not exists portfolio_url text;

-- ----------------------------------------------------------------------------
-- RLS refresh: professors get read access to staff-relevant tables; only
-- admins can write business data. Modules/lessons reads stay enrollment-
-- scoped for students; staff still see everything.
-- ----------------------------------------------------------------------------

-- profiles
drop policy if exists "profiles self read" on public.profiles;
create policy "profiles self read" on public.profiles
  for select using (auth.uid() = id or public.is_staff(auth.uid()));

drop policy if exists "profiles admin update" on public.profiles;
create policy "profiles admin update" on public.profiles
  for update using (public.is_admin(auth.uid())) with check (public.is_admin(auth.uid()));

-- cohorts
drop policy if exists "cohorts admin write" on public.cohorts;
create policy "cohorts admin write" on public.cohorts
  for all using (public.is_admin(auth.uid())) with check (public.is_admin(auth.uid()));

-- applications: professors read; only admins write
drop policy if exists "applications self select" on public.applications;
create policy "applications self select" on public.applications
  for select using (user_id = auth.uid() or public.is_staff(auth.uid()));

drop policy if exists "applications admin all" on public.applications;
create policy "applications admin all" on public.applications
  for all using (public.is_admin(auth.uid())) with check (public.is_admin(auth.uid()));

-- enrollments: professors read; only admins write
drop policy if exists "enrollments self select" on public.enrollments;
create policy "enrollments self select" on public.enrollments
  for select using (user_id = auth.uid() or public.is_staff(auth.uid()));

drop policy if exists "enrollments admin write" on public.enrollments;
create policy "enrollments admin write" on public.enrollments
  for all using (public.is_admin(auth.uid())) with check (public.is_admin(auth.uid()));

-- modules: enrolled students + all staff read; only admins write
drop policy if exists "modules read enrolled" on public.modules;
create policy "modules read enrolled" on public.modules
  for select using (
    public.is_staff(auth.uid())
    or exists (
      select 1 from public.enrollments e
      where e.user_id = auth.uid() and e.cohort_id = modules.cohort_id
    )
  );

drop policy if exists "modules admin write" on public.modules;
create policy "modules admin write" on public.modules
  for all using (public.is_admin(auth.uid())) with check (public.is_admin(auth.uid()));

-- lessons: enrolled students + all staff read; only admins write
drop policy if exists "lessons read enrolled" on public.lessons;
create policy "lessons read enrolled" on public.lessons
  for select using (
    public.is_staff(auth.uid())
    or exists (
      select 1 from public.modules m
      join public.enrollments e on e.cohort_id = m.cohort_id
      where m.id = lessons.module_id and e.user_id = auth.uid()
    )
  );

drop policy if exists "lessons admin write" on public.lessons;
create policy "lessons admin write" on public.lessons
  for all using (public.is_admin(auth.uid())) with check (public.is_admin(auth.uid()));

-- lesson_progress: professors read; only the student writes their own
drop policy if exists "progress admin read" on public.lesson_progress;
create policy "progress staff read" on public.lesson_progress
  for select using (public.is_staff(auth.uid()));

-- payments: only admins (financial data)
drop policy if exists "payments self select" on public.payments;
create policy "payments self select" on public.payments
  for select using (user_id = auth.uid() or public.is_admin(auth.uid()));

drop policy if exists "payments admin all" on public.payments;
create policy "payments admin all" on public.payments
  for all using (public.is_admin(auth.uid())) with check (public.is_admin(auth.uid()));

-- site_settings: any authenticated user can read; only admins write
drop policy if exists "settings admin write" on public.site_settings;
create policy "settings admin write" on public.site_settings
  for all using (public.is_admin(auth.uid())) with check (public.is_admin(auth.uid()));

-- Storage buckets: admins write; reads happen via service-role signed URLs.
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

-- ----------------------------------------------------------------------------
-- Site settings: seed extra keys used by the new typed admin form.
-- Existing values are preserved (on conflict do nothing).
-- ----------------------------------------------------------------------------
insert into public.site_settings (key, value) values
  ('discord_url', '""'),
  ('demo_day_date', 'null'),
  ('maintenance_mode', 'false'),
  ('applications_closed_message',
   '"Applications are currently closed. Check back soon for the next cohort."'),
  ('active_cohort_id', 'null')
on conflict (key) do nothing;

notify pgrst, 'reload schema';
