-- ============================================================================
-- 0072 — Snapshot the granted PERCENTAGE on a scholarship award.
--
-- 0071 snapshots `scholarship_applications.award_cents` so that editing the
-- catalog next month cannot rewrite what someone was told they had won. That
-- snapshot is a cents figure, and a percentage award can't be one: "half
-- tuition" has to be resolved against the price the student is actually
-- charged, which for someone who hasn't paid yet isn't known until they reach
-- the till. So checkout re-read the percentage off the live `scholarships`
-- row — reopening the exact hole award_cents exists to close, and throwing
-- away a reviewer's per-student override along with it (an override is a flat
-- amount, i.e. a decision that the percentage no longer applies to this
-- student at all).
--
-- Snapshotting the percent alongside the cents closes both: the award carries
-- its own terms, and checkout resolves them against the live price without
-- consulting the catalog. Null means "this award is the flat award_cents
-- figure", which is what an override records.
--
-- The backfill below is part of this migration rather than a follow-up
-- because the two are not separately correct. lib/scholarships.ts treats an
-- ABSENT column as "ask the catalog", so a deploy may safely precede this
-- file — but a column that is present and unpopulated reads as "flat award",
-- and for a percentage award award_cents was snapshotted against the cohort
-- LIST price, so a regionally-priced student's 50% award would clamp to their
-- whole tuition. Adding the column without filling it is the one ordering
-- that loses money.
--
-- Run in Supabase SQL Editor. Idempotent / safe to re-run.
-- Assumes 0001..0071 are applied.
-- ============================================================================

alter table public.scholarship_applications
  add column if not exists award_percent integer
    check (award_percent between 1 and 100);

-- Every award already granted on a percentage scholarship, as the catalog
-- still describes it — the same figure the current code resolves for those
-- rows, so applying this changes nothing about what anybody is owed. The
-- `is null` clause keeps a re-run cheap and stops it from clobbering a
-- snapshot taken since.
update public.scholarship_applications a
set award_percent = s.award_percent
from public.scholarships s
where s.id = a.scholarship_id
  and a.status = 'awarded'
  and a.award_percent is null
  and s.award_percent is not null;

comment on column public.scholarship_applications.award_percent is
  'The granted percentage, snapshotted at award time; null for a flat award.';

notify pgrst, 'reload schema';
