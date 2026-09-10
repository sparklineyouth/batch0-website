-- ============================================================================
-- 0062 — Scheduled application acceptances.
--
-- A reviewer can decide "yes" now but not want the acceptance to LAND now:
-- an application that arrives Monday afternoon should go out at 6am Tuesday,
-- not at 2am when the reviewer happens to be clearing the queue. So instead of
-- flipping status to `accepted` immediately, they can PARK the acceptance —
-- store when it should fire and the notes to send — and leave the application
-- `submitted`. A cron (`/api/cron/scheduled-accepts`) picks it up once the
-- moment has passed and runs the exact same acceptance the Accept button runs.
--
-- Deliberately three columns on `applications`, NOT a side table: an
-- application has at most one pending acceptance at a time (you can't schedule
-- two different accept times for one person), the data is small, and keeping
-- it on the row means every place that already reads the application for its
-- decision UI sees the pending schedule for free.
--
--   scheduled_accept_at    — when the auto-accept should fire (UTC). NULL =
--                            nothing scheduled. The cron matches rows where
--                            this is <= now() and the app is still decidable.
--   scheduled_accept_notes — the reviewer's acceptance notes, captured at
--                            schedule time and replayed verbatim when it fires,
--                            so the scheduled accept reads identically to one
--                            clicked by hand.
--   scheduled_accept_by    — who scheduled it, so the auto-accept is attributed
--                            to a real reviewer (reviewed_by + audit) rather
--                            than an anonymous system actor.
--
-- The three are cleared together the instant the acceptance fires, and also
-- whenever a manual decision is made — a hand-clicked Accept/Reject/Waitlist
-- supersedes and cancels any parked acceptance (see lib actions).
--
-- Run in Supabase SQL Editor. Idempotent / safe to re-run.
-- Assumes 0001..0061 are applied.
-- ============================================================================

alter table public.applications
  add column if not exists scheduled_accept_at timestamptz,
  add column if not exists scheduled_accept_notes text,
  add column if not exists scheduled_accept_by uuid references public.profiles(id) on delete set null;

-- The cron's hot query is "any acceptances due?" — a partial index over just
-- the parked rows keeps that a cheap scan of a handful of rows, never the whole
-- applications table.
create index if not exists idx_applications_scheduled_accept_at
  on public.applications (scheduled_accept_at)
  where scheduled_accept_at is not null;
