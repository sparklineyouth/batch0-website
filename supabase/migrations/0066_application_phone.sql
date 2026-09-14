-- ============================================================================
-- 0066 — Phone number on applications.
--
-- The application form now asks every applicant for a phone number, mapped
-- 1:1 to this column like every other question (see lib/application-questions
-- and app/apply/actions.ts). It's a required field going forward.
--
-- Students accepted BEFORE this field existed have no number on file. They're
-- collected retroactively: an admin sends the "we need your phone number"
-- email (/admin/email/phone-request) to accepted students still missing one,
-- and each lands on /dashboard/phone, which writes their number back here.
-- Because RLS only lets a student self-update an application while it's a
-- draft, that page writes through the service-role client, scoped to their
-- own row.
--
-- Nullable: existing rows (drafts, past decisions) predate the question, and
-- the required-ness is enforced by the submit schema, not the column.
--
-- Run in Supabase SQL Editor. Idempotent / safe to re-run.
-- Assumes 0001..0065 are applied.
-- ============================================================================

alter table public.applications
  add column if not exists phone text;
