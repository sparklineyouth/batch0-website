-- ============================================================================
-- 0074 — Scholarship perks: tickable extras that stack with money, or stand
--        alone.
--
-- 0071 gave a scholarship ONE payout — money off tuition OR a grant of mentor
-- calls, never both, and nothing else. This migration makes the two halves
-- independent and adds three more non-money perks, each ticked per
-- scholarship:
--
--   mentor_calls           (0071)  extra 1:1 calls, spent when the team
--                                  schedules one.
--   perk_feedback_credits  written feedback credits — the same pool a founder
--                                  pass draws on (founder_pass_feedback_requests),
--                                  so the ceiling in createFeedbackRequest reads
--                                  both sources and counts every request once.
--   perk_demo_day_tickets  complimentary Demo Day tickets the student sends to
--                                  guests. Each becomes a real demo_day_tickets
--                                  row at $0, tagged with the award that funded
--                                  it — see the changes to that table below.
--   perk_ai_boost          doubles the AI co-founder's free monthly allowance.
--                                  Read by lib/ai/usage.ts when billing overage.
--
-- `award_type` stays, as a DERIVED summary the code writes on every save
-- (lib/scholarship-award.ts awardTypeOf): 'discount' for money alone, 'perks'
-- for perks alone, 'both' for both. The old 'mentor_calls' value is rewritten
-- to 'perks' below and remains legal so a row the update somehow missed still
-- reads. Nothing about what any existing scholarship pays out changes: every
-- new column defaults to "nothing extra".
--
-- The award-shape constraint is REPLACED. It used to key on award_type; now it
-- says the only thing that matters — a scholarship must be worth something —
-- as the disjunction of every half it can carry.
--
-- SNAPSHOTS. 0071 snapshots the granted money and calls onto the application
-- row at award time so editing the catalog can't rewrite what someone was told
-- they had won. The new perks get the same treatment. "Used" counts are not
-- columns: feedback credits are counted from founder_pass_feedback_requests,
-- and guest tickets from demo_day_tickets, each keyed back to the award — a
-- count derived from the rows that actually exist can't drift from them.
--
-- Run in Supabase SQL Editor. Idempotent / safe to re-run.
-- Assumes 0001..0073 are applied.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. The catalog: the perks a scholarship offers.
-- ---------------------------------------------------------------------------

alter table public.scholarships
  add column if not exists perk_feedback_credits integer not null default 0,
  add column if not exists perk_demo_day_tickets integer not null default 0,
  add column if not exists perk_ai_boost boolean not null default false;

-- Ceilings match MAX_* in lib/scholarship-award.ts. Named, and dropped by
-- name first, so raising one is a two-line edit.
alter table public.scholarships
  drop constraint if exists scholarships_perk_feedback_credits_check;
alter table public.scholarships
  add constraint scholarships_perk_feedback_credits_check
  check (perk_feedback_credits between 0 and 10);

alter table public.scholarships
  drop constraint if exists scholarships_perk_demo_day_tickets_check;
alter table public.scholarships
  add constraint scholarships_perk_demo_day_tickets_check
  check (perk_demo_day_tickets between 0 and 10);

-- The shape constraint no longer cares which half is filled, only that one is.
-- A scholarship worth nothing is a form that wastes an applicant's time, and
-- is still rejected at the column level so no admin screen can create one by
-- forgetting a field.
--
-- ORDER MATTERS: this replaces 0071's constraint BEFORE award_type is
-- rewritten below. The old one keyed on award_type ('mentor_calls' needs
-- calls, 'discount' needs money), so rewriting a row to 'perks' while it
-- still stood would fail every legacy learner's grant. The PGlite test
-- (scripts/test-scholarships-db.mts) executes this file against such a row.
alter table public.scholarships
  drop constraint if exists scholarships_award_shape;
alter table public.scholarships
  add constraint scholarships_award_shape check (
    award_cents > 0
    or award_percent is not null
    or mentor_calls > 0
    or perk_feedback_credits > 0
    or perk_demo_day_tickets > 0
    or perk_ai_boost
  );

-- award_type widens to the derived vocabulary. 'mentor_calls' stays legal —
-- see the header — but nothing writes it any more.
alter table public.scholarships
  drop constraint if exists scholarships_award_type_check;
alter table public.scholarships
  add constraint scholarships_award_type_check
  check (award_type in ('discount', 'mentor_calls', 'perks', 'both'));

update public.scholarships
  set award_type = 'perks'
  where award_type = 'mentor_calls';

comment on column public.scholarships.award_type is
  'Derived summary of the terms: discount | perks | both (mentor_calls = legacy perks). Written by lib/scholarship-award.ts awardTypeOf().';
comment on column public.scholarships.perk_feedback_credits is
  'Feedback credits granted with the award; drawn from the founder-pass credit pool.';
comment on column public.scholarships.perk_demo_day_tickets is
  'Complimentary Demo Day tickets the student may send to guests.';
comment on column public.scholarships.perk_ai_boost is
  'Doubles the free monthly AI co-founder allowance while the award is live.';

-- ---------------------------------------------------------------------------
-- 2. The award: what was actually granted, snapshotted like mentor_calls_awarded.
-- ---------------------------------------------------------------------------

alter table public.scholarship_applications
  add column if not exists feedback_credits_awarded integer not null default 0,
  add column if not exists demo_day_tickets_awarded integer not null default 0,
  add column if not exists ai_boost_awarded boolean not null default false;

alter table public.scholarship_applications
  drop constraint if exists scholarship_applications_feedback_credits_awarded_check;
alter table public.scholarship_applications
  add constraint scholarship_applications_feedback_credits_awarded_check
  check (feedback_credits_awarded between 0 and 10);

alter table public.scholarship_applications
  drop constraint if exists scholarship_applications_demo_day_tickets_awarded_check;
alter table public.scholarship_applications
  add constraint scholarship_applications_demo_day_tickets_awarded_check
  check (demo_day_tickets_awarded between 0 and 10);

comment on column public.scholarship_applications.feedback_credits_awarded is
  'Snapshotted at award time. Spent credits are counted from founder_pass_feedback_requests.';
comment on column public.scholarship_applications.demo_day_tickets_awarded is
  'Snapshotted at award time. Sent tickets are counted from demo_day_tickets.scholarship_application_id.';

-- ---------------------------------------------------------------------------
-- 3. Guest tickets: a complimentary demo_day_tickets row.
--
-- A guest ticket is an ordinary ticket (0070) that was never paid for: it is
-- inserted already 'paid', at amount_cents 0, with no Stripe ids, and tagged
-- with the award that funded it. It then behaves exactly like a paid ticket —
-- the events policy (0070) admits its holder, the admin list shows it, cancel
-- works on it. Refund refuses it, as it already refuses any ticket without a
-- payment intent.
--
-- amount_cents relaxes from > 0 to >= 0 for exactly this row. The paid link
-- path still enforces Stripe's 50-cent floor in the server action, which is
-- where it always lived; the column check only ever refused nonsense.
-- ---------------------------------------------------------------------------
alter table public.demo_day_tickets
  drop constraint if exists demo_day_tickets_amount_cents_check;
alter table public.demo_day_tickets
  add constraint demo_day_tickets_amount_cents_check
  check (amount_cents >= 0);

-- set null rather than cascade: deleting a scholarship application must not
-- erase the record of a ticket that was actually sent.
alter table public.demo_day_tickets
  add column if not exists scholarship_application_id uuid
    references public.scholarship_applications(id) on delete set null;

create index if not exists demo_day_tickets_scholarship_idx
  on public.demo_day_tickets (scholarship_application_id)
  where scholarship_application_id is not null;

comment on column public.demo_day_tickets.scholarship_application_id is
  'Set when this is a complimentary guest ticket funded by a scholarship award. See lib/scholarships.ts.';

-- ---------------------------------------------------------------------------
-- RLS unchanged. The new columns ride on tables whose policies already scope
-- them: a student reads their own award (and so their own perks), staff read
-- all. Every write still goes through a server action on the service-role
-- client — the guest-ticket sender checks the award belongs to the caller and
-- that a ticket is left before it inserts.
-- ---------------------------------------------------------------------------

notify pgrst, 'reload schema';
