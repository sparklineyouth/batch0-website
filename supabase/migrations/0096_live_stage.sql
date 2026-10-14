-- ============================================================================
-- 0096 — The webinar's primary host.
--
-- With more than one host on air, every viewer picked "the main video" for
-- themselves, by connection order — two students could be watching two
-- different people. A webinar now has one PRIMARY host: the stage everyone
-- sees whenever nobody is presenting.
--
--   - The first host to go live takes the seat, and a host who joins (or
--     heartbeats) while its holder is gone takes it over — both as a
--     compare-and-set from the server (claimStage in lib/live-access.ts).
--   - Staff can "pin for everyone": setPrimaryHost in app/live/actions.ts,
--     only for a host who is in the room right now.
--
-- Written by the service role only, from those two server paths. The value
-- reaches clients through the join and heartbeat answers (PresenceResult.room)
-- — never through the public stage channel, which anyone can publish on.
-- `on delete set null`: a deleted profile frees the seat.
--
-- No new policy: the column rides on the existing `events` policies, and the
-- id it names is a host already shown on camera to everyone in the room.
--
-- The app tolerates this migration not being applied (the room runs with no
-- primary). Run in Supabase SQL Editor. Idempotent / safe to re-run.
-- Needs only public.events and public.profiles; independent of 0093..0095.
-- ============================================================================

alter table public.events
  add column if not exists live_primary_host_id uuid
    references public.profiles(id) on delete set null;

comment on column public.events.live_primary_host_id is
  'Webinar primary host (pinned for everyone). Server-written: claimStage / setPrimaryHost.';
