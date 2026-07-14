-- ============================================================================
-- 0038 — Repair the live application_questions row after the batch0 rebrand.
--
-- WHY THIS EXISTS
-- 0035 seeds site_settings.application_questions with `on conflict (key) do
-- nothing`, which is correct — it must never clobber an admin's edits. But it
-- means the seed only ever applies to a FRESH database. Production already had
-- the row, so when the rebrand updated 0035's JSON (and the code defaults in
-- lib/application-questions.ts) from "Why Sparkline Youth?" to "Why batch0?",
-- production kept the old label. The repo said batch0; the live form asked
-- every applicant "Why Sparkline Youth?" — a dead brand, on the money path.
--
-- Renaming a seed does not rename the data it already seeded. Any future
-- content change to 0035 needs a companion patch like this one.
--
-- WHAT IT DOES
-- Patches two fields on the `why_join` question, and only when they still hold
-- the exact stale strings — so a deliberate admin edit is never overwritten:
--   label       "Why Sparkline Youth?"                     -> "Why batch0?"
--   placeholder "What do you want to get out of these 4 weeks?"
--                                       -> "What do you want to get out of the program?"
--
-- The "4 weeks" placeholder was also wrong on the facts: Cohort 1 runs
-- 2026-08-17 → 2026-10-18 (~9 weeks), so the copy now carries no duration
-- claim at all.
--
-- Idempotent / safe to re-run: the WHERE clauses stop matching after the first
-- successful run.
-- ============================================================================

-- 1) The brand.
update public.site_settings
set value = jsonb_set(value, '{why_join,label}', '"Why batch0?"'::jsonb, false)
where key = 'application_questions'
  and value #>> '{why_join,label}' = 'Why Sparkline Youth?';

-- 2) The stale duration claim.
update public.site_settings
set value = jsonb_set(
  value,
  '{why_join,placeholder}',
  '"What do you want to get out of the program?"'::jsonb,
  false
)
where key = 'application_questions'
  and value #>> '{why_join,placeholder}' = 'What do you want to get out of these 4 weeks?';

notify pgrst, 'reload schema';
