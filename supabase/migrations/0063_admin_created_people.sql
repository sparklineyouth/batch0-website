-- ============================================================================
-- 0063 — Admin-created people (name / optional email / grade).
--
-- Admins can now add a person to batch0 directly from the People area
-- (/admin/students/new) instead of waiting for that person to sign up and
-- apply. The account is minted server-side with the service-role admin API,
-- so the existing `on_auth_user_created` trigger still creates the matching
-- `profiles` row exactly as a normal signup would.
--
-- Two things this migration exists for:
--
--   grade — the school grade the admin captures at creation. It has lived on
--           `applications.grade` (free text, e.g. "10th", "College freshman")
--           since 0001, but an admin-created person may never fill out an
--           application, so the grade belongs on the profile itself. Free text
--           to match the application field — grades aren't a clean enum.
--
-- Email stays `not null` on profiles (many reads assume it), so a person added
-- WITHOUT an email is given a non-deliverable placeholder address at creation
-- (see lib/placeholder-email.ts). The UI hides those placeholders; nothing is
-- ever sent to them.
--
-- Run in Supabase SQL Editor. Idempotent / safe to re-run.
-- Assumes 0001..0062 are applied.
-- ============================================================================

alter table public.profiles
  add column if not exists grade text;
