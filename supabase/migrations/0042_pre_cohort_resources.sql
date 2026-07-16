-- ============================================================================
-- 0042 — Pre-cohort resources.
--
-- Accepted students whose cohort hasn't started yet get a restricted
-- dashboard (home, application, billing, referrals, settings) plus a
-- "Pre-cohort resources" section. Admins mark a resource as pre-cohort
-- to publish it there.
--
-- Run in Supabase SQL Editor. Idempotent / safe to re-run.
-- Assumes 0001..0041 applied.
-- ============================================================================

alter table public.resources
  add column if not exists pre_cohort boolean not null default false;

-- Read: an applicant whose application passed review (accepted / paid /
-- enrolled) can see pre-cohort resources before they're enrolled — global
-- ones (cohort_id null) or ones scoped to the cohort they were accepted to.
-- This is additive to the existing "resources read" policy (policies OR).
drop policy if exists "resources pre-cohort read" on public.resources;
create policy "resources pre-cohort read" on public.resources
  for select using (
    pre_cohort = true
    and exists (
      select 1 from public.applications a
      where a.user_id = auth.uid()
        and a.status in ('accepted', 'paid', 'enrolled')
        and (resources.cohort_id is null or a.cohort_id = resources.cohort_id)
    )
  );

notify pgrst, 'reload schema';
