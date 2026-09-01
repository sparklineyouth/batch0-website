-- ============================================================================
-- 0043 — Standard pre-cohort resources.
--
-- Every cohort ships with the same starter library: global rows
-- (cohort_id null) marked pre_cohort, so the 0042 RLS policy shows them to
-- every accepted student of every cohort — current and future — with zero
-- per-cohort setup. They're ordinary resources rows: admins can edit,
-- re-categorize, swap the link for an uploaded file, or delete them from
-- /admin/resources like anything else.
--
-- Run in Supabase SQL Editor. Idempotent / safe to re-run (each row is
-- keyed on its title; a deliberate admin delete or rename won't be fought
-- beyond a re-run of this file). Assumes 0001..0042 applied.
-- ============================================================================

insert into public.resources
  (cohort_id, category, title, description, external_url, pre_cohort)
select seed.cohort_id, seed.category, seed.title, seed.description,
       seed.external_url, seed.pre_cohort
from (
  values
    (
      null::uuid,
      'readings',
      'How to Get Startup Ideas — Paul Graham',
      'The canonical essay on finding ideas worth building: notice problems you have yourself instead of "thinking up" startups. Read this first.',
      'https://paulgraham.com/startupideas.html',
      true
    ),
    (
      null::uuid,
      'readings',
      'Do Things That Don''t Scale — Paul Graham',
      'Why the first version of your startup should be hand-made: recruit users one at a time and delight them. Required reading before week one.',
      'https://paulgraham.com/ds.html',
      true
    ),
    (
      null::uuid,
      'readings',
      'The Mom Test',
      'How to talk to customers and learn whether your idea is any good — even when everyone is politely lying to you. Read at least the first three chapters before kickoff.',
      'https://www.momtestbook.com/',
      true
    ),
    (
      null::uuid,
      'guides',
      'YC Startup Library',
      'Y Combinator''s collection of essays, talks, and videos covering every stage of starting a company. Skim broadly; bookmark what applies to you.',
      'https://www.ycombinator.com/library',
      true
    ),
    (
      null::uuid,
      'templates',
      'Business Model Canvas',
      'The one-page template for sketching how your idea creates, delivers, and captures value. Fill one out for your idea and bring it to kickoff.',
      'https://www.strategyzer.com/canvas/business-model-canvas',
      true
    ),
    (
      null::uuid,
      'tools',
      'Startup School by Y Combinator',
      'YC''s free online course for founders — short video lessons on ideas, users, product, and growth. Work through a couple of lessons before the cohort starts.',
      'https://www.startupschool.org/',
      true
    ),
    (
      null::uuid,
      'tools',
      'Y Combinator on YouTube',
      'Talks from YC partners and founders — pricing, pitching, talking to users, and more. Good background listening while you prep.',
      'https://www.youtube.com/@ycombinator',
      true
    )
) as seed(cohort_id, category, title, description, external_url, pre_cohort)
where not exists (
  select 1 from public.resources r where r.title = seed.title
);

notify pgrst, 'reload schema';
