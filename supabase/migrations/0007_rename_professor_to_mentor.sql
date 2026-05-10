-- ============================================================================
-- 0007 — Collapse the 'professor' role into 'mentor'.
--
-- The /professor and /mentor user-facing panels were duplicative. We're
-- consolidating to a single 'mentor' role (which inherits the former
-- professor's tooling: course content, assignments, grading).
--
-- Run in Supabase SQL Editor. Idempotent / safe to re-run.
-- Assumes 0001..0006 are applied.
-- ============================================================================

-- 1) Migrate any existing 'professor' rows to 'mentor'.
update public.profiles set role = 'mentor' where role = 'professor';

-- 2) Tighten the role check constraint so 'professor' is no longer valid.
alter table public.profiles drop constraint if exists profiles_role_check;
alter table public.profiles
  add constraint profiles_role_check
  check (role in ('student', 'admin', 'mentor', 'investor'));

-- 3) Update is_staff() to treat 'mentor' as staff (was admin+professor).
create or replace function public.is_staff(uid uuid)
returns boolean
language sql
stable
security definer set search_path = public
as $$
  select exists (
    select 1 from public.profiles
    where id = uid and role in ('admin', 'mentor')
  );
$$;

notify pgrst, 'reload schema';
