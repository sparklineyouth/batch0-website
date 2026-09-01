-- ============================================================================
-- 0040 — Remember the code at redemption, so the ticket can wear it.
--
-- The pass ticket (app/pass/founder-pass-ticket.tsx) displays the code that
-- is embossed on the physical card — it's the holder's identity mark, more
-- theirs than the serial. But founder_passes deliberately stores only an
-- HMAC of the code (see 0039), so at display time there is nothing to show.
--
-- This column captures the plaintext code AT REDEMPTION, written by
-- redeemPass() in the same UPDATE that binds the card. Storing it then is
-- safe where storing it at mint time would not be:
--
--   * A redeemed code is inert. redeemPass() only matches rows where
--     redeemed_by IS NULL, so knowing a claimed card's code grants nothing.
--   * There is deliberately no un-redeem: the only admin action is revoke
--     (app/admin/passes/actions.ts), which kills the card forever. A code
--     can therefore never return to the redeemable pool after being stored
--     here. If an unbind action is ever added, it MUST null this column and
--     the card must be treated as burned — see that file's comments.
--   * Unredeemed rows keep NULL here, so a dump of this table still yields
--     nothing usable for the cards that are still live. The hash column
--     remains the only record of those.
--
-- Passes redeemed before this migration keep NULL (the plaintext was never
-- seen by the server outside one request); the ticket falls back to the
-- serial for them.
-- ============================================================================

alter table public.founder_passes
  add column if not exists redeemed_code text;

notify pgrst, 'reload schema';
