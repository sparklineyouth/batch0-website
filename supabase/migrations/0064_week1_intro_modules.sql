-- ============================================================================
-- 0064 — Week 1 course content: "Finding a Problem Worth Building".
--
-- Seeds the first week of the course for the cohort that is kicking off next
-- (the soonest cohort whose start date is today or later; falls back to the
-- most recent cohort if none are upcoming). This is the introductory week —
-- the on-ramp before anyone builds anything: how to think like a founder,
-- where real ideas come from, how to tell if a problem is worth solving, what
-- an MVP actually is, and how to prove demand before you build.
--
-- Creates one Week 1 MODULE and five LESSONS inside it. The module shows on
-- the course page (/app/course and /dashboard/course) grouped under "Week 1",
-- and each lesson opens the video player at /dashboard/course/[id]. Lessons
-- ship with no video yet — the player shows "No video uploaded yet." until a
-- staff member uploads one at /admin/course — but the titles and the written
-- overview in each lesson's description are live immediately.
--
-- WHY THIS TARGETS A COHORT (not global like resources): modules and lessons
-- are cohort-scoped by schema (modules.cohort_id). The course page is also
-- gated until the cohort's start date, so Week 1 becomes visible to enrolled
-- students exactly at kickoff. If you want this on a DIFFERENT cohort, replace
-- the `target` CTE below with `select '<cohort-uuid>'::uuid as id`.
--
-- Run in Supabase SQL Editor. Idempotent / safe to re-run — the module is
-- keyed on (cohort, week, title) and each lesson on (module, title), so a
-- re-run won't duplicate rows, and a deliberate admin edit/delete won't be
-- fought beyond re-running this file. Assumes 0001..0063 applied.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1) The Week 1 module.
-- ----------------------------------------------------------------------------
with target as (
  select coalesce(
    (select id from public.cohorts
       where starts_on >= current_date
       order by starts_on asc
       limit 1),
    (select id from public.cohorts
       order by starts_on desc nulls last
       limit 1)
  ) as id
)
insert into public.modules (cohort_id, week, title, summary, position)
select t.id, 1,
  'Week 1 — Finding a Problem Worth Building',
  'Before you build anything, you find something worth building. This week is your on-ramp: how to think like a founder, where real ideas come from, how to tell whether a problem is worth your time, what an MVP actually is, and how to test real demand before you write a line of code or design a single screen.',
  1
from target t
where t.id is not null
  and not exists (
    select 1 from public.modules m
    where m.cohort_id = t.id
      and m.week = 1
      and m.title = 'Week 1 — Finding a Problem Worth Building'
  );

-- ----------------------------------------------------------------------------
-- 2) The five lessons, inside that module.
--
-- `wk1` re-resolves the same target cohort and finds the module by its title,
-- so this statement stands on its own (the SQL editor runs statements in
-- order, but keeping each self-contained makes the file re-runnable in pieces).
-- ----------------------------------------------------------------------------
with target as (
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
wk1 as (
  select m.id
  from public.modules m
  join target t on t.id = m.cohort_id
  where m.week = 1
    and m.title = 'Week 1 — Finding a Problem Worth Building'
  limit 1
)
insert into public.lessons (module_id, title, description, position)
select wk1.id, seed.title, seed.description, seed.position
from wk1,
  (values
    (
      'Welcome to batch0: How to Think Like a Founder',
      'Start here. Over the next four weeks you''ll go from an idea to something real people actually use. This lesson sets the mindset for everything that follows: founders don''t start with a product, they start with a problem they understand better than anyone else. The trap to watch for is falling in love with your solution before you''ve proven a single person wants it. Your only job this week is to find a problem worth solving and gather evidence that it''s real — the building comes later.',
      1
    ),
    (
      'Where Good Ideas Come From: Finding a Problem Worth Solving',
      'The best ideas aren''t invented at a whiteboard — they''re noticed. Mine your own life: what''s annoying, repetitive, or broken for you and the people around you — classmates, teammates, family, your community? What to look for in a problem: it happens often, it genuinely hurts, and it affects a group of people you can actually reach and talk to. This week, write down five problems, not five products. A sharp problem you understand deeply beats a "big" idea you can only describe in vague words.',
      2
    ),
    (
      'Talk to Customers Without Fooling Yourself',
      'Everyone will tell you your idea is great — and that''s exactly the problem. People lie to be nice, and that flattery quietly kills startups. The fix is the Mom Test: ask about their real past behavior, not their opinion of your idea. Ask "when did you last run into this, and what did you do about it?" instead of "would you use this?" What to look for: specific stories, real frustration, and time or money already spent on workarounds. Vague enthusiasm like "cool idea!" is a red flag, not a green light. Aim to talk to ten people this week.',
      3
    ),
    (
      'What an MVP Actually Is',
      'An MVP is the smallest version of your product that lets a real person do the one thing that matters — nothing more. It is not a tiny, worse copy of everything you dream of building; it''s one job, done well enough to test. What to look for: can you strip your idea down to a single core action? You often don''t need code at all — a landing page, a spreadsheet, a Google Form, or simply doing the work by hand ("concierge") can be your first MVP. Done is better than perfect here, because learning, not polish, is the whole point.',
      4
    ),
    (
      'Prove Demand Before You Build',
      'The strongest validation isn''t a compliment — it''s someone handing over their email, their time, or their money before the product even exists. This lesson covers the fast ways to test real demand: a waitlist or landing page, a "fake door" that measures clicks, a concierge MVP you run manually, or a straight pre-sale. What to look for: are people taking an action that actually costs them something? Ten signups from strangers beat a hundred "I''d totally use that"s from friends. And if you can''t get anyone to say yes now, that''s the cheapest lesson you''ll ever learn. Bring your evidence into Week 2.',
      5
    )
  ) as seed(title, description, position)
where wk1.id is not null
  and not exists (
    select 1 from public.lessons l
    where l.module_id = wk1.id
      and l.title = seed.title
  );

notify pgrst, 'reload schema';
