-- ============================================================================
-- 0056 — A per-pass tuition discount, set by hand.
--
-- 0055 gave a pass a TIER, which is a named package an admin picks off a
-- shelf. That covers the common cases and keeps the promise text honest,
-- but it can't express "this one person gets $45 off" — and that is exactly
-- what gets asked for when you're negotiating with one student in front of
-- you, or matching what a partner school already offered.
--
-- So: an OPTIONAL override, in cents, on the pass itself.
--
--   NULL  — use the tier's discount. Every pass ever issued reads this way,
--           so this migration changes nothing for anyone.
--   0..n  — waive exactly this many cents instead, whatever the tier says.
--
-- Why an override column rather than more tiers: the tier is a package with a
-- name the recipient reads ("issued as Founding"), and minting a tier per
-- dollar amount would turn that vocabulary into noise. The override is
-- deliberately NOT named — it renders as a number in the perk line and
-- nowhere else.
--
-- The column stores CENTS, integer, like every other money column in this
-- schema (applications/cohorts price_cents, payments amount_cents). Never
-- dollars, never a float: a $12.30 discount is 1230, and there is exactly one
-- place — the admin input — where dollars are parsed into it.
--
-- Note what this does NOT do: it cannot make a pass worth MORE than the bill.
-- Resolution clamps to the price the applicant would actually pay (see
-- grantDiscountCents in lib/founder-pass-tiers.ts), so a $500 override on a
-- $130 tuition is a full ride, not a $370 refund. That clamp lives in code
-- rather than a check constraint on purpose: the ceiling is the applicant's
-- regional price, which this table has no way to know.
--
-- House-style notes: additive + idempotent DDL, pgrst schema reload at the
-- end. Safe to re-run.
-- ============================================================================

alter table public.founder_passes
  add column if not exists discount_cents integer;

-- Non-negative only. A negative discount would ADD to someone's tuition, which
-- no code path intends and every code path would silently honour.
alter table public.founder_passes
  drop constraint if exists founder_passes_discount_cents_check;
alter table public.founder_passes
  add constraint founder_passes_discount_cents_check
  check (discount_cents is null or discount_cents >= 0);

-- RLS unchanged: discount_cents rides on founder_passes, whose "self select"
-- policy (0039) shows a row only to the account that redeemed it. A holder can
-- read their own discount — they should, it's on their pass page and in their
-- email — and nobody can read anyone else's.

notify pgrst, 'reload schema';
