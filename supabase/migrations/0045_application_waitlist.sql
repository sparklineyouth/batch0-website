-- ============================================================================
-- 0045 — Application waitlist.
--
-- Adds 'waitlisted' to the application lifecycle: a middle decision between
-- accept and reject. A waitlisted application is still decidable (admins can
-- accept or reject it later), grants NO access (it is deliberately absent
-- from every accepted/paid/enrolled RLS clause and from ACCEPTED_STATUSES in
-- lib/pre-cohort.ts), and blocks re-applying while the applicant waits.
--
-- Run in Supabase SQL Editor. Idempotent / safe to re-run.
-- Assumes 0001..0044 applied.
-- ============================================================================

alter table public.applications
  drop constraint if exists applications_status_check;

alter table public.applications
  add constraint applications_status_check
  check (status in (
    'draft', 'submitted', 'accepted', 'waitlisted',
    'rejected', 'paid', 'enrolled', 'withdrawn'
  ));

notify pgrst, 'reload schema';
