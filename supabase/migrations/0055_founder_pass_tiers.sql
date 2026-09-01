-- ============================================================================
-- 0055 — Founder pass tiers, and who the pass was for.
--
-- 0054 made a pass issuable to one named person by email. This migration makes
-- that person's pass ABLE TO DIFFER: an admin picks a tier before the code is
-- generated, and the tier travels with the pass forever — into checkout, into
-- the applications gate, into the feedback-credit ceiling, into the decision
-- clock. See lib/founder-pass-tiers.ts, which is the one place those numbers
-- live; this file only stores the key and fences the vocabulary.
--
-- Why a key rather than a column per perk: the perks are a PACKAGE a human
-- picks by name, not four independent dials. Storing 'founding' means a later
-- change to what "founding" includes reaches every founding pass at once,
-- which is what you want for a promise like "2 feedback credits" that was
-- never quoted to the holder as a contract. Storing four frozen numbers would
-- pin each pass to the moment it was issued and leave no record of what was
-- intended. The trade is that a tier's meaning can drift under existing
-- holders, so the roster is append-mostly: change what a tier gives
-- deliberately, and never repurpose a key for a different audience.
--
-- House-style notes: additive + idempotent DDL, text key + check constraint
-- rather than a pg enum, pgrst schema reload at the end. Safe to re-run.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. The tier, and who the pass was addressed to.
-- ----------------------------------------------------------------------------
alter table public.founder_passes
  -- Matches PASS_TIERS in lib/founder-pass-tiers.ts. 'standard' is the pass
  -- everyone has always had, so the column default backfills every existing
  -- row — printed and virtual alike — to exactly what it already was. Nobody's
  -- perks change when this runs.
  add column if not exists tier text not null default 'standard',

  -- The recipient's name, as the sender typed it, for the greeting on the
  -- invite email. Distinct from profiles.full_name on purpose: this is who we
  -- MEANT to send it to, captured before any account exists, and it stays
  -- truthful even if someone else ends up redeeming the code.
  add column if not exists recipient_name text;

-- Fence the vocabulary. Dropped by name first so widening the roster later is
-- a two-line edit rather than a hunt for the auto-generated constraint name
-- (0051 documents how that goes wrong).
alter table public.founder_passes
  drop constraint if exists founder_passes_tier_check;
alter table public.founder_passes
  add constraint founder_passes_tier_check
  check (tier in ('standard', 'founding', 'full_ride'));

-- ----------------------------------------------------------------------------
-- 2. Feedback credits: from "one ever" to "one OPEN at a time".
--
-- 0041 enforced the single credit with a partial unique index on user_id
-- `where status <> 'declined'`. Because a DELIVERED request is not declined,
-- that index also meant one credit for life — the ceiling and the concurrency
-- guard were the same object. Tiers need those separated: a founding pass
-- carries two credits, but still only one open request at a time.
--
-- So the index narrows to the OPEN statuses, and the lifetime ceiling moves
-- into code (createFeedbackRequest, which reads the holder's tier).
--
-- That split is safe against races, which is the only reason it's acceptable
-- to move a limit out of the database. To exceed the ceiling you would need
-- two requests to pass the count check concurrently — and this index makes the
-- second one fail, because a holder with a request already open cannot open
-- another no matter what their tier says. The code check only ever runs when
-- nothing is open, i.e. serially.
--
-- Behaviour for existing standard holders is unchanged: their ceiling is 1,
-- and a delivered request still spends it. A declined request still hands the
-- credit back, exactly as before.
-- ----------------------------------------------------------------------------
drop index if exists public.founder_pass_feedback_one_live;

create unique index if not exists founder_pass_feedback_one_open
  on public.founder_pass_feedback_requests(user_id)
  where status in ('requested', 'scheduled');

-- Counting a holder's spent credits is now a per-request read on the /pass
-- page, so give it an index rather than a sequential scan that grows with
-- every credit ever filed.
create index if not exists founder_pass_feedback_user_status_idx
  on public.founder_pass_feedback_requests(user_id, status);

-- ----------------------------------------------------------------------------
-- RLS is unchanged. tier and recipient_name ride on founder_passes, whose
-- "self select" policy (0039) exposes a row only to the account that redeemed
-- it — so a holder can read their own tier, and the unissued roster stays
-- invisible. Writes still go through the service-role client in server
-- actions, which is where the tier is chosen.
-- ----------------------------------------------------------------------------

notify pgrst, 'reload schema';
