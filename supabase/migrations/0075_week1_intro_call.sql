-- ============================================================================
-- 0075 — The Week 1 webinar becomes a Sunday-noon intro call.
--
-- 0069 placed the Week 1 webinar on Sun Sep 20 2026 and named it "Week 1
-- Webinar", keeping its old 8pm start. This pulls it earlier — to noon (12:00)
-- America/New_York, same Sunday — and renames it after what it actually is:
-- the intro call for Week 1, "Finding a Problem Worth Building", the on-ramp
-- week seeded by 0064.
--
-- WHAT IS MOVED: the single hosted event on Sun Sep 20 2026 (in New York time)
-- that 0069 named "Week 1 Webinar". Its length is preserved — only the start
-- moves, and the end follows by the same interval.
--
-- DAILY ROOM: the video room's expiry sits two hours past the OLD 8pm end,
-- which is LATER than the new noon start — so the room is still alive at the
-- new time and moving earlier needs no per-row chore. (Re-saving the event in
-- /admin/events would re-stamp it regardless, and the join page mints a fresh
-- room if Daily has reaped the old one — app/dashboard/events/[id]/live.)
--
-- NOTE: this puts a Week 1 session on a Sunday at noon rather than the series'
-- usual evening slot — a deliberate one-off for the intro call, not a change
-- to the Sundays rule (lib/webinar-schedule.ts).
--
-- Run in Supabase SQL Editor. RETURNS the row it changed, times shown in New
-- York, so you can eyeball the result. Safe to re-run and order-independent:
-- the WHERE also matches the new title, so whether the reschedule was already
-- done by hand or not, a run lands the row on the same instant with the same
-- name. In an environment without that webinar it matches nothing and is a
-- no-op. Assumes 0001..0074 applied.
-- ============================================================================

update public.events e
set
  starts_at = (date '2026-09-20' + time '12:00') at time zone 'America/New_York',
  ends_at   = (date '2026-09-20' + time '12:00') at time zone 'America/New_York'
              + coalesce(e.ends_at - e.starts_at, interval '1 hour'),
  title     = 'Intro Call — Finding a Problem Worth Building'
where e.live_mode = 'hosted'
  and (e.starts_at at time zone 'America/New_York')::date = date '2026-09-20'
  and (
    e.title ilike 'Week 1 Webinar%'
    or e.title = 'Intro Call — Finding a Problem Worth Building'
  )
returning
  e.id,
  e.title as new_title,
  to_char(e.starts_at at time zone 'America/New_York', 'Dy Mon DD HH24:MI') as new_start_ny,
  to_char(e.ends_at   at time zone 'America/New_York', 'Dy Mon DD HH24:MI') as new_end_ny;
