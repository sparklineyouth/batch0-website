-- ============================================================================
-- 0054 — Virtual founder passes.
--
-- Until now every row in founder_passes was a physical object: minting ran the
-- Onshape export, embossed the code into an STL, and the card went to a
-- printer (app/api/admin/passes/mint). That is the only way a pass could exist,
-- which meant handing one to someone remotely was impossible — you had to mail
-- them plastic.
--
-- A virtual pass is the same pass with a different delivery channel. Same
-- serial sequence, same code alphabet, same peppered hash, same redemption
-- path at /pass, same revoke. The ONLY difference is that instead of an STL
-- the code leaves the building in an email, so this migration adds the three
-- facts that email delivery creates and printing doesn't: that the pass was
-- issued digitally, to which address, and when.
--
-- Why these live on founder_passes rather than a side table: every read of the
-- admin list already selects this row, and a virtual pass is not a different
-- kind of thing — it's the same pass with a delivery note attached. A join
-- would buy nothing and would let the two tables disagree about whether a
-- serial exists.
--
-- What deliberately does NOT change: the plaintext code is still never stored
-- for an unredeemed pass. 0039 argues the case (short codes, unrotatable,
-- GPU-cheap against a bare hash) and it holds just as hard here — a virtual
-- code is exactly as much a bearer token as an embossed one. So there is no
-- "resend this pass" column and no way to recover the code after the send:
-- issuing is mint-and-send in one act, and the admin UI shows the code once,
-- the way manifest.csv does for a print run. If a send is lost, revoke that
-- serial and issue a new one.
--
-- House-style notes: additive + idempotent DDL, text status column rather than
-- a pg enum, pgrst schema reload at the end.
-- ============================================================================

alter table public.founder_passes
  -- 'card'    — a 3D-printed card. The historical default, and correct for
  --             every row that existed before this migration ran: they were
  --             all printed, so backfilling via the column default is exact
  --             rather than a guess.
  -- 'virtual' — issued by email, no physical object.
  add column if not exists kind text not null default 'card',

  -- Where a virtual pass was sent. Null for printed cards, which have no
  -- recipient until someone redeems them (that's redeemed_by).
  --
  -- NOT unique: the same address legitimately receives several passes — the
  -- team inbox collects a handful to hand out at an event, and a founder who
  -- lost theirs gets a replacement after the first is revoked.
  add column if not exists issued_to_email text,

  -- When the email was handed to Resend. Distinct from created_at (which is
  -- "when the row appeared") only in principle today, since issuing writes
  -- both in one insert — but it's the column that means "delivered", and
  -- keeping it separate leaves room for a queued send later.
  add column if not exists issued_at timestamptz;

-- Fence the vocabulary. Named explicitly and dropped first so re-running this
-- migration, or widening the roster later, is a two-line edit rather than a
-- hunt for the auto-generated constraint name (see 0051 for how that goes).
alter table public.founder_passes
  drop constraint if exists founder_passes_kind_check;
alter table public.founder_passes
  add constraint founder_passes_kind_check check (kind in ('card', 'virtual'));

-- "Which passes did we send to this person?" is the one question the admin
-- asks that no existing index answers. Partial, because printed cards are the
-- overwhelming majority and every one of them is null here.
create index if not exists founder_passes_issued_to_email_idx
  on public.founder_passes(issued_to_email)
  where issued_to_email is not null;

-- RLS is unchanged and deliberately so. 0039's "self select" policy exposes
-- only rows where redeemed_by = auth.uid(), so issued_to_email is invisible
-- until the recipient claims the pass — at which point it's their own address.
-- Unclaimed virtual passes stay as hidden as unclaimed cards.

notify pgrst, 'reload schema';
