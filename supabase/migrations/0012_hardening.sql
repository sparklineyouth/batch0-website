-- ============================================================================
-- 0012 — Production hardening.
--   - Close MFA forgery: only the service role (via /api/mfa/record) writes
--     into mfa_verifications. Client INSERT is no longer allowed.
--   - Notification dedupe: optional dedupe_key + partial unique index so
--     repeated cron / announcement fan-outs are idempotent.
--   - Submission late flag: stamped at submit time, used by mentor UI to
--     surface late submissions and (optionally) by admins to penalize.
--   - Quiz attempt cap + deadline: per-quiz max_attempts and lesson-level
--     deadline already flow via assignments — expose a column for the cap.
--
-- Run in Supabase SQL Editor. Idempotent / safe to re-run.
-- Assumes 0001..0011 applied.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- MFA: remove the self-insert policy. /api/mfa/record uses the service role
-- (which bypasses RLS) and validates the session's AAL claim before writing.
-- ----------------------------------------------------------------------------
drop policy if exists "mfa_verifications self insert" on public.mfa_verifications;

-- ----------------------------------------------------------------------------
-- Notifications: optional dedupe_key so callers can guarantee at-most-once
-- delivery. A partial unique index lets us keep the old "type + free-form"
-- inserts working while letting cron/announcement code opt in.
-- ----------------------------------------------------------------------------
alter table public.notifications
  add column if not exists dedupe_key text;

create unique index if not exists notifications_user_dedupe_uniq
  on public.notifications (user_id, dedupe_key)
  where dedupe_key is not null;

-- ----------------------------------------------------------------------------
-- assignment_submissions: late flag stamped at submit time. Soft signal —
-- caller decides what to do with it.
-- ----------------------------------------------------------------------------
alter table public.assignment_submissions
  add column if not exists late boolean not null default false;

create index if not exists assignment_submissions_late_idx
  on public.assignment_submissions (assignment_id, late)
  where late;

-- ----------------------------------------------------------------------------
-- Quizzes: per-quiz attempt cap. Null = unlimited; default 3 keeps it
-- sensible without forcing existing quizzes to be edited. (Migration
-- 0013 drops the quizzes table entirely; this is harmless if so.)
-- ----------------------------------------------------------------------------
alter table public.quizzes
  add column if not exists max_attempts int default 3
    check (max_attempts is null or max_attempts >= 1);

-- ----------------------------------------------------------------------------
-- Stripe webhook: split "claim" from "complete". The handler claims the
-- event_id at the start (INSERT). If anything throws mid-flow, the row
-- stays in claim-only state and Stripe's next delivery retries —
-- without this, the dedupe insert succeeded and Stripe would never try
-- again, silently losing the side effect.
-- ----------------------------------------------------------------------------
alter table public.processed_stripe_events
  add column if not exists completed_at timestamptz;

-- Backfill: any existing rows were fully processed under the old
-- semantics; mark them complete so the new logic doesn't replay them.
update public.processed_stripe_events
  set completed_at = processed_at
  where completed_at is null;

notify pgrst, 'reload schema';
