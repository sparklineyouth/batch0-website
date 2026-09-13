-- ============================================================================
-- 0065 — Kickoff resources: the Week 1 reading list.
--
-- The companion readings for kickoff and the introductory week. Same shape as
-- the standard pre-cohort library in 0043: global rows (cohort_id null) marked
-- pre_cohort, so the 0042 RLS policy shows them to every accepted student of
-- every cohort — before AND after enrollment — with zero per-cohort setup.
--
-- These point at batch0's own guides on batch0.org/blog, one per idea students
-- meet in Week 1 (finding a problem, talking to customers, MVPs, validating
-- demand). They surface in the "Pre-cohort resources" section for accepted
-- students right now (so there's something to read for kickoff tomorrow), and
-- group under a "readings" heading once the cohort starts and the full
-- Resources page unlocks. They're ordinary resources rows: edit, re-categorize,
-- swap the link for an uploaded file, or delete them at /admin/resources.
--
-- Run in Supabase SQL Editor. Idempotent / safe to re-run — each row is keyed
-- on its title, so a re-run won't duplicate and a deliberate rename/delete
-- won't be fought. Assumes 0001..0064 applied.
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
      'Read Before Kickoff: How to Find a Problem Worth Solving',
      'The best ideas start with a problem, not a product. How to find one worth building by mining your own life and communities — and what makes a problem worth your time. Read this before Week 1.',
      'https://batch0.org/blog/how-to-find-a-startup-problem-worth-solving',
      true
    ),
    (
      null::uuid,
      'readings',
      'The Mom Test: Asking Questions That Get Honest Answers',
      'People lie to be nice, and it wrecks your customer interviews. The Mom Test shows you how to ask about real behavior instead of opinions, so you hear the truth about your idea.',
      'https://batch0.org/blog/mom-test-for-teen-founders',
      true
    ),
    (
      null::uuid,
      'readings',
      'How to Do Customer Interviews as a Beginner',
      'A beginner''s script for talking to strangers and getting the truth: ask about the past, not the future. Pair this with the Mom Test before you start your ten interviews.',
      'https://batch0.org/blog/customer-interviews-beginners-guide',
      true
    ),
    (
      null::uuid,
      'readings',
      'What Is an MVP? A Plain-English Definition',
      'An MVP is the smallest version of your product that lets a real user do the one thing that matters. What an MVP is, what it isn''t, and how to scope your first one.',
      'https://batch0.org/blog/what-is-an-mvp',
      true
    ),
    (
      null::uuid,
      'readings',
      'How to Validate a Startup Idea in High School',
      'The exact process teen founders use to test an idea in a week — talk to ten potential customers before you build anything. Your playbook for the back half of Week 1.',
      'https://batch0.org/blog/how-to-validate-startup-idea-high-school',
      true
    ),
    (
      null::uuid,
      'readings',
      'Prove Demand: Get People to Pay Before You Build',
      'The strongest validation is a paying customer. How to presell your product and collect real commitment — money, emails, time — before you build it, even as a teenager.',
      'https://batch0.org/blog/presell-before-you-build',
      true
    ),
    (
      null::uuid,
      'readings',
      'The Concierge MVP: Validate by Doing It Manually First',
      'Before you automate anything, do it by hand for real customers. How a concierge MVP proves demand without building a product — the fastest way to test an idea this week.',
      'https://batch0.org/blog/concierge-mvp-explained',
      true
    )
) as seed(cohort_id, category, title, description, external_url, pre_cohort)
where not exists (
  select 1 from public.resources r where r.title = seed.title
);

notify pgrst, 'reload schema';
