-- ============================================================================
-- 0069 — Webinars are on Sundays.
--
-- batch0 runs one webinar a week, on Sunday. The scheduler at /admin/webinars
-- used to take any date, so the calendar now has hosted sessions on weekdays
-- with whatever names were typed at the time. This moves every webinar that
-- hasn't finished yet onto consecutive Sundays — the first onto Sun Sep 20
-- 2026, the next onto Sep 27, then Oct 4, and so on, in the order they were
-- already scheduled — and renames each one after the cohort week it closes:
-- "Week 1 Webinar", "Week 2 Webinar", … A webinar that had a real topic in
-- its title keeps it after a dash ("Week 1 Webinar — Fundraising 101"); one
-- named "test" or "webinar 2" just gets the week name.
--
-- WHAT IS MOVED: rows in `events` with live_mode = 'hosted' whose end is still
-- ahead of now — including one that is live at the moment you run this. Ones
-- that already ended are history (they may have recordings) and are untouched.
--
-- TIME OF DAY: each webinar keeps its own start time (in America/New_York)
-- and its own length; only the date changes. To put them all at one time
-- instead, set `fixed_time` in `params` below — e.g. `time '12:00'`.
--
-- WEEK NUMBERS come from the cohort the webinar belongs to (its cohort_id, or
-- the soonest upcoming cohort when it has none), counting calendar days from
-- `cohorts.starts_on` the same way the course page does (lib/cohort-week.ts):
-- with a cohort starting Mon Sep 14, the Sunday Sep 20 is week 1. A webinar
-- before its cohort starts, or with no cohort at all, is numbered by its slot.
--
-- DAILY ROOMS: each webinar's video room was created with an expiry two hours
-- after its OLD end time, and Daily deletes rooms at expiry. Nothing here
-- touches the room columns — the join page now checks the room before minting
-- a token and makes a fresh one if it's gone (app/dashboard/events/[id]/live),
-- and re-saving an event in /admin/events re-stamps the room's expiry. So the
-- rescheduled webinars work on their new Sundays without any per-row chore.
--
-- Run in Supabase SQL Editor. The statement RETURNS one row per webinar with
-- its old and new name and time (shown in New York time), so you can see
-- exactly what changed. Safe to re-run: the same rows land on the same
-- Sundays in the same order, and the "Week N Webinar" prefix is stripped
-- before being re-applied, so titles don't stack. Assumes 0001..0068 applied.
-- ============================================================================

with params as (
  select
    date '2026-09-20'          as first_sunday,
    'America/New_York'::text   as tz,
    null::time                 as fixed_time   -- e.g. time '12:00'; null keeps each webinar's own time
),

-- Same rule as 0064: the cohort that is kicking off next, else the latest.
fallback_cohort as (
  select coalesce(
    (select id from public.cohorts
       where starts_on >= current_date
       order by starts_on asc
       limit 1),
    (select id from public.cohorts
       order by starts_on desc nulls last
       limit 1)
  ) as id
),

candidates as (
  select
    e.id,
    e.title,
    e.starts_at,
    e.ends_at,
    coalesce(e.cohort_id, f.id) as cohort_id,
    -- 0-based slot in existing schedule order; ties broken by creation so a
    -- re-run assigns the same Sundays. (int: `date + bigint` has no operator.)
    (row_number() over (order by e.starts_at, e.created_at, e.id) - 1)::int as slot
  from public.events e
  cross join fallback_cohort f
  where e.live_mode = 'hosted'
    and coalesce(e.ends_at, e.starts_at + interval '1 hour') >= now()
),

plan as (
  select
    c.id,
    c.title,
    c.starts_at,
    (p.first_sunday + 7 * c.slot)::date as sunday,
    -- Same wall-clock time on the new date, read and re-applied in `tz` so a
    -- 7pm webinar stays a 7pm webinar across a DST change.
    (
      (p.first_sunday + 7 * c.slot)
      + coalesce(p.fixed_time, (c.starts_at at time zone p.tz)::time)
    ) at time zone p.tz as new_starts_at,
    coalesce(c.ends_at - c.starts_at, interval '1 hour') as duration,
    case
      when co.starts_on is not null
       and (p.first_sunday + 7 * c.slot) >= co.starts_on
      then ((p.first_sunday + 7 * c.slot) - co.starts_on) / 7 + 1
      else c.slot + 1
    end as week,
    -- Whatever the title said beyond a name this migration (or the form)
    -- already gave it. Empty when the title was only ever generic.
    nullif(
      btrim(
        regexp_replace(
          regexp_replace(
            c.title,
            '^\s*(week\s*\d+\s*webinar|sunday\s*webinar(\s*[·—–:-]\s*[a-z]{3}\s*\d{1,2})?)\s*([·—–:-]\s*)?',
            '', 'i'
          ),
          '^\s*(test(ing)?(\s+webinar)?|webinar|new\s+webinar|untitled)\s*#?\s*\d*\s*$',
          '', 'i'
        )
      ),
      ''
    ) as topic
  from candidates c
  cross join params p
  left join public.cohorts co on co.id = c.cohort_id
)

update public.events e
set
  starts_at = pl.new_starts_at,
  ends_at   = pl.new_starts_at + pl.duration,
  title     = 'Week ' || pl.week || ' Webinar'
              || coalesce(' — ' || pl.topic, '')
from plan pl, params p
where e.id = pl.id
returning
  e.id,
  pl.title as old_title,
  e.title  as new_title,
  to_char(pl.starts_at at time zone p.tz, 'Dy Mon DD HH24:MI') as old_start_ny,
  to_char(e.starts_at  at time zone p.tz, 'Dy Mon DD HH24:MI') as new_start_ny,
  pl.week;
