-- ============================================================================
-- 0071 — Scholarships: need-based, merit, and the learner's grant.
--
-- Three kinds of scholarship, two ways of paying one out:
--
--   need     money off tuition, decided on financial circumstances
--   merit    money off tuition, decided on extra questions the admin writes
--   learner  no money — a grant of extra 1:1 mentor calls
--
-- `kind` is descriptive; `award_type` is what actually decides the payout, so
-- a merit scholarship that grants mentor calls is creatable without a deploy.
--
-- Lifecycle of one student's application:
--
--   draft ──▶ submitted ──▶ under_review ──▶ awarded
--                    │                  └──▶ declined
--                    └──▶ withdrawn  (student's own doing)
--
-- A student may apply once they are ACCEPTED and again — or still — once they
-- are ENROLLED; `eligible_stages` scopes each scholarship to one or both. That
-- second window is the reason the money side has two fulfilment paths: an
-- accepted student's award comes off their Stripe checkout, while an enrolled
-- student has already paid, so theirs is a partial refund against the original
-- charge. Partial refunds deliberately do NOT tear down an enrolment — see
-- handleChargeRefunded in lib/stripe-fulfillment.ts, which only revokes on a
-- FULL refund. That property is what makes this safe; do not weaken it.
--
-- ONE SCHOLARSHIP PER STUDENT. Enforced in three places on purpose: the
-- partial unique index below (the backstop that survives a code bug), the
-- eligibility check that hides the apply button, and the re-check at award
-- time in lib/scholarship-award.ts canAward(). The index is per (user, cohort)
-- rather than per user so a returning student can hold one in a later cohort.
--
-- What this is NOT: a payments table. No money is recorded here. The award
-- amount is an instruction to the checkout route or to the refund button; the
-- authoritative record of money moved stays in `payments` and in Stripe.
--
-- Also adds the two jsonb answer stores that let admins add and remove
-- questions without a migration per question:
--   applications.custom_answers        — admin-added questions on /apply
--   applications.scholarship_answers   — the shared scholarship-interest block
--
-- Runtime owners: lib/scholarships.ts (database), lib/scholarship-award.ts
-- (arithmetic + eligibility), lib/question-schema.ts (the question shape).
--
-- Run in Supabase SQL Editor. Idempotent / safe to re-run.
-- Assumes 0001..0070 are applied.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- The catalog
-- ---------------------------------------------------------------------------

create table if not exists public.scholarships (
  id uuid primary key default gen_random_uuid(),
  -- Appears in the student-facing URL (/dashboard/scholarships/<slug>), so it
  -- is stable and human-readable rather than the uuid.
  slug text not null unique,
  name text not null,
  kind text not null default 'need'
    check (kind in ('need', 'merit', 'learner')),
  -- One line on the card; `description` is the full markdown-free blurb on the
  -- application page.
  tagline text,
  description text,

  award_type text not null default 'discount'
    check (award_type in ('discount', 'mentor_calls')),
  -- A flat amount off tuition. Ignored when award_percent is set.
  award_cents integer not null default 0 check (award_cents >= 0),
  -- A share of tuition instead of a flat amount. Both exist because both are
  -- things people offer, and expressing "half tuition" as a cents figure means
  -- it silently stops being half the next time tuition changes.
  award_percent integer check (award_percent between 1 and 100),
  -- The learner's grant. 20 is a ceiling, not a target.
  mentor_calls integer not null default 0 check (mentor_calls between 0 and 20),

  -- null = unlimited. Enforced against awarded_count() in the eligibility
  -- check and again in canAward() at decision time.
  seats integer check (seats is null or seats >= 0),
  opens_at timestamptz,
  closes_at timestamptz,
  -- Which stages may apply. Defaults to both: the whole point of the feature
  -- is that a scholarship can be claimed after acceptance AND after enrolment.
  eligible_stages text[] not null default array['accepted', 'enrolled']::text[],

  -- The admin-written extra questions for this scholarship, in render order.
  -- Shape is lib/question-schema.ts CustomQuestion[]. Kept as jsonb rather
  -- than a questions table because the answers are jsonb too: a question that
  -- only ever exists to key one blob does not earn its own relation, and the
  -- read path (one row, one render) never joins.
  questions jsonb not null default '[]'::jsonb,

  enabled boolean not null default true,
  sort_index integer not null default 100,

  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- A discount scholarship worth nothing, or a calls scholarship granting no
  -- calls, is a form that wastes an applicant's time. Rejected at the column
  -- level so no admin screen can create one by forgetting a field.
  constraint scholarships_award_shape check (
    (award_type = 'discount'
       and (award_cents > 0 or award_percent is not null))
    or
    (award_type = 'mentor_calls' and mentor_calls > 0)
  ),
  constraint scholarships_window check (
    opens_at is null or closes_at is null or closes_at > opens_at
  ),
  constraint scholarships_slug_format check (slug ~ '^[a-z][a-z0-9-]{1,47}$')
);

create index if not exists scholarships_open_idx
  on public.scholarships (sort_index, name)
  where enabled;

drop trigger if exists touch_scholarships on public.scholarships;
create trigger touch_scholarships before update on public.scholarships
  for each row execute procedure public.touch_updated_at();

comment on table public.scholarships is
  'Scholarship catalog: need / merit / learner. See lib/scholarships.ts.';
comment on column public.scholarships.questions is
  'Admin-written extra questions, lib/question-schema.ts CustomQuestion[].';
comment on column public.scholarships.eligible_stages is
  'Subset of {accepted, enrolled}: when in their journey a student may apply.';

-- ---------------------------------------------------------------------------
-- One student's application to one scholarship
-- ---------------------------------------------------------------------------

create table if not exists public.scholarship_applications (
  id uuid primary key default gen_random_uuid(),
  scholarship_id uuid not null
    references public.scholarships(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  -- The batch0 application this hangs off. set null rather than cascade: the
  -- record that a scholarship was awarded must outlive a reshuffled
  -- application row, because money may already have moved against it.
  application_id uuid references public.applications(id) on delete set null,
  cohort_id uuid references public.cohorts(id) on delete set null,

  status text not null default 'draft'
    check (status in (
      'draft', 'submitted', 'under_review', 'awarded', 'declined', 'withdrawn'
    )),
  -- Answers to this scholarship's questions, keyed by question id.
  answers jsonb not null default '{}'::jsonb,
  -- Where the student was when they applied ('accepted' | 'enrolled'), so the
  -- reviewer can see it even after they have since enrolled.
  stage_at_apply text check (stage_at_apply in ('accepted', 'enrolled')),

  -- What was actually granted. Snapshotted from the scholarship at award time
  -- rather than read through the FK, so editing the catalog next month cannot
  -- retroactively change what someone was told they had won.
  award_cents integer not null default 0 check (award_cents >= 0),
  mentor_calls_awarded integer not null default 0
    check (mentor_calls_awarded between 0 and 20),
  mentor_calls_used integer not null default 0
    check (mentor_calls_used >= 0),

  -- How the money reached them. 'refund_due' is the state an already-paid
  -- student sits in until an admin presses the refund button — deliberately a
  -- separate step, because it moves real money.
  fulfillment text not null default 'none'
    check (fulfillment in ('none', 'discount', 'refund_due', 'refunded')),
  -- Set once the partial refund succeeds. stripe_refund_id makes the retry
  -- path idempotent: a second press finds the id and refuses.
  stripe_refund_id text,
  refunded_cents integer not null default 0 check (refunded_cents >= 0),
  refunded_at timestamptz,

  decision_note text,
  reviewed_by uuid references public.profiles(id) on delete set null,
  reviewed_at timestamptz,
  submitted_at timestamptz,
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- One application per student per scholarship. A student who withdraws and
  -- wants back in reopens this row rather than creating a second.
  unique (scholarship_id, user_id)
);

-- ONE LIVE AWARD PER STUDENT PER COHORT — the database-level backstop for the
-- rule the UI also enforces. Partial so that declined and withdrawn rows, of
-- which a student may accumulate several, never collide.
--
-- Postgres treats NULLs as distinct, so a row with a null cohort_id is not
-- constrained by this. That is acceptable and deliberate: cohort_id is always
-- populated in practice (it comes off the application), and the alternative —
-- coalescing to a sentinel uuid — would block a student from ever holding an
-- award in a second cohort if one row happened to be missing its cohort.
-- canAward() is the guard that covers the null case.
create unique index if not exists scholarship_applications_one_award_idx
  on public.scholarship_applications (user_id, cohort_id)
  where status = 'awarded';

-- The reviewer's queue: everything waiting on a decision, oldest first so the
-- person who has been waiting longest is at the top.
create index if not exists scholarship_applications_queue_idx
  on public.scholarship_applications (submitted_at)
  where status in ('submitted', 'under_review');

create index if not exists scholarship_applications_user_idx
  on public.scholarship_applications (user_id, created_at desc);

create index if not exists scholarship_applications_scholarship_idx
  on public.scholarship_applications (scholarship_id, status);

-- The refund-retry guard reads by refund id.
create index if not exists scholarship_applications_refund_idx
  on public.scholarship_applications (stripe_refund_id)
  where stripe_refund_id is not null;

drop trigger if exists touch_scholarship_applications
  on public.scholarship_applications;
create trigger touch_scholarship_applications
  before update on public.scholarship_applications
  for each row execute procedure public.touch_updated_at();

comment on table public.scholarship_applications is
  'One student''s application to one scholarship. See lib/scholarships.ts.';
comment on column public.scholarship_applications.award_cents is
  'Snapshotted at award time so catalog edits cannot rewrite a granted award.';
comment on column public.scholarship_applications.fulfillment is
  'none | discount (comes off checkout) | refund_due (admin must press) | refunded.';

-- ---------------------------------------------------------------------------
-- Answer stores on the application itself
-- ---------------------------------------------------------------------------

-- Admin-added questions beyond the 17 column-backed fields. Adding a question
-- must not require a migration, so their answers live in one blob keyed by
-- question id (lib/question-schema.ts).
alter table public.applications
  add column if not exists custom_answers jsonb not null default '{}'::jsonb;

-- The shared scholarship-interest block shown to everyone on /apply, ahead of
-- any specific scholarship application. Kept separate from custom_answers so a
-- reviewer reading the application can tell "extra question the admin added"
-- from "this person is asking for financial help" at a glance — they are
-- different kinds of fact and are read by different people.
alter table public.applications
  add column if not exists scholarship_answers jsonb not null default '{}'::jsonb;

comment on column public.applications.custom_answers is
  'Answers to admin-added questions, keyed by question id. See lib/application-questions.ts.';
comment on column public.applications.scholarship_answers is
  'Answers to the shared scholarship-interest block on /apply.';

-- ---------------------------------------------------------------------------
-- Mentor-call redemption (the learner's scholarship)
-- ---------------------------------------------------------------------------

-- A scholarship-funded call is an ordinary interview_request (0061) with a
-- receipt attached, so it flows through the team's existing queue and the
-- existing call_invites/Daily plumbing untouched. Tagging it here is what lets
-- the credit be counted exactly once, when the team schedules it.
--
-- set null rather than cascade: deleting a scholarship application must not
-- erase the record of a call that actually happened.
alter table public.interview_requests
  add column if not exists scholarship_application_id uuid
    references public.scholarship_applications(id) on delete set null;

create index if not exists interview_requests_scholarship_idx
  on public.interview_requests (scholarship_application_id)
  where scholarship_application_id is not null;

comment on column public.interview_requests.scholarship_application_id is
  'Set when this call is funded by a learner''s scholarship credit. See lib/scholarships.ts.';

-- ---------------------------------------------------------------------------
-- RLS
--
-- Reads only. Every write in this feature runs through a server action or a
-- webhook on the service-role client, which is where the real authorisation
-- lives (assertPermission / the student's own session). Granting the browser
-- session write access as well would just be a second, weaker door onto the
-- same tables — the same argument 0052 makes for the email tables.
-- ---------------------------------------------------------------------------

alter table public.scholarships enable row level security;

-- The catalog is readable by any signed-in student: they have to be able to
-- see what is on offer. Disabled scholarships are filtered in lib/, not here,
-- because an admin previewing one needs to read it.
drop policy if exists "scholarships read" on public.scholarships;
create policy "scholarships read" on public.scholarships
  for select using (auth.uid() is not null);

alter table public.scholarship_applications enable row level security;

drop policy if exists "scholarship applications read" on public.scholarship_applications;
create policy "scholarship applications read" on public.scholarship_applications
  for select using (
    user_id = auth.uid()
    or public.is_admin(auth.uid())
    or public.has_permission(auth.uid(), 'scholarships.view')
    or public.has_permission(auth.uid(), 'scholarships.manage')
  );

-- ---------------------------------------------------------------------------
-- Permission grants: NONE, deliberately.
--
-- `admin` already holds '*', so the feature works out of the box for the
-- people who run it, and a custom role can be given either key at /admin/roles
-- without a deploy.
--
-- It is tempting to grant `scholarships.view` to `mentor`, on the reasoning
-- that a mentor picking up a learner's-scholarship call wants to know why the
-- student has credits. Do NOT. Both scholarship keys are admin-area
-- permissions (they gate /admin/scholarships), and canAccessAdmin() is "holds
-- ANY admin-area permission" — so that one grant would hand every mentor the
-- entire admin panel, payments and audit log included, the moment this
-- migration ran. lib/permissions.test.ts documents the same near-miss for
-- calls.invite in 0059.
--
-- The mentor's real need is served without a permission at all: a
-- scholarship-funded call is tagged on the interview_requests row they already
-- read, so the call card can say "learner's scholarship" on its own.
-- ---------------------------------------------------------------------------

notify pgrst, 'reload schema';
