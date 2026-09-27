-- ============================================================================
-- 0088 — Hackathons, part 2 (contract). Apply AFTER the 0087 code is live.
--
-- 0087 narrowed "challenge_submissions self insert" instead of dropping it,
-- because the pre-0087 code inserts entries through it. Once the new code is
-- deployed nothing uses it: every registration and submission is written by a
-- server action on the service role, after validating answers and the
-- referral gate. Left in place it would let a signed-in user insert a
-- 'submitted' row directly through PostgREST and skip both.
--
-- Also re-stamps submitted_at for any entry the old code wrote during the
-- deploy window (it never set the column), so those entries don't read as
-- drafts in admin or sort last in the export.
--
-- Idempotent.
-- ============================================================================

drop policy if exists "challenge_submissions self insert"
  on public.challenge_submissions;

update public.challenge_submissions
set submitted_at = created_at
where submitted_at is null and status <> 'draft';

-- Same for registrations: an entry the old code wrote in the window has no
-- registration row yet.
insert into public.challenge_registrations (challenge_id, user_id, referral_code, created_at)
select s.challenge_id, s.user_id, s.referral_code, s.created_at
from public.challenge_submissions s
where s.status <> 'draft'
on conflict (challenge_id, user_id) do nothing;

notify pgrst, 'reload schema';
