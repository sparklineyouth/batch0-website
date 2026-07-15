-- ============================================================================
-- 0041 — Founder pass perks: profile, feedback credit, rebuild, structured
--        rejection feedback.
--
-- 0039/0040 made the pass a real, redeemable object (fast-track, Discord role,
-- badge, early access, $30 discount, a shareable ticket). This migration backs
-- the four perks that turn the pass into a set of tools rather than a discount:
--
--   * an OPTIONAL public founder profile on the pass (project/bio/links/
--     milestones) that the holder controls — columns on founder_passes;
--   * a ONE-TIME feedback credit the holder redeems and the team fulfils —
--     founder_pass_feedback_requests;
--   * a "build your way back in" submission a declined holder makes to earn one
--     fresh human review — founder_pass_rebuilds;
--   * STRUCTURED rejection feedback (strongest / missing / next step / second-
--     review eligibility) — columns on applications, so a pass holder's "no"
--     can never be a form letter (enforced in app/admin/applications/[id]/
--     actions.ts, backed here).
--
-- Deliberately NOT here: build clinics and guest invitations. Those are pure
-- scheduling/ops promises with no useful data surface yet — see the pass page
-- copy, which only lists what this codebase actually delivers.
--
-- House-style notes: additive + idempotent DDL, text+check status columns
-- (never pg enums), public.is_admin(auth.uid()) RLS, the shared
-- public.touch_updated_at() trigger, partial unique indexes to encode the
-- "one X per holder" rules, and `notify pgrst, 'reload schema'` at the end. The
-- app tolerates this landing later than the code (reads select("*") / catch the
-- missing-relation error), the same contract 0008/0040 rely on.
--
-- Run in the Supabase SQL Editor. Idempotent / safe to re-run.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Public founder profile — optional, holder-controlled, lives ON the pass.
--
-- Kept as columns on founder_passes (not a side table) because every read of a
-- pass already does select("*") from this row — getPassForUser and the public
-- /pass/[serial] page both — so the profile rides along with no extra query and
-- no risk of a naked column reference erroring on a pre-migration database.
--
-- Writes never happen through the anon client: founder_passes has no self-
-- update policy by design (0039), so profile edits go through a server action on
-- the service-role client that checks redeemed_by = auth.uid() itself. That is
-- the same "the checks in code ARE the access control" stance as redemption.
-- ----------------------------------------------------------------------------
alter table public.founder_passes
  add column if not exists project_name text,
  add column if not exists founder_bio text,
  add column if not exists website_url text,
  add column if not exists demo_url text,
  -- Array of short strings ("Shipped v1", "First 10 users"). Shape validated in
  -- code, not the DB — mirrors application_questions / challenge questions.
  add column if not exists milestones jsonb not null default '[]'::jsonb,
  -- Master switch for the rich profile block on the public page. Default false:
  -- the ticket (name + serial + code) is public the moment a card is claimed,
  -- but the profile a holder writes stays private until they publish it.
  add column if not exists profile_public boolean not null default false;

-- ----------------------------------------------------------------------------
-- 2. Feedback credit — one redeemable request per holder, fulfilled by a human.
--
-- topic is one of the six focus areas the pass advertises. status walks
-- requested -> scheduled -> delivered (with the written response the holder
-- reads) or -> declined. "One credit" is a partial unique index: a holder may
-- hold exactly one non-declined request at a time, so a delivered request has
-- spent the credit while a declined one frees it to be filed again.
-- ----------------------------------------------------------------------------
create table if not exists public.founder_pass_feedback_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  topic text not null check (topic in (
    'application', 'idea', 'interview_plan', 'landing_page', 'mvp', 'pitch_deck'
  )),
  -- The holder's context for what they want looked at.
  detail text not null default '',
  -- Optional link to the thing (deck, landing page, repo, Figma).
  link_url text,
  status text not null default 'requested'
    check (status in ('requested', 'scheduled', 'delivered', 'declined')),
  -- The team's written feedback, surfaced to the holder once delivered.
  response text,
  responded_by uuid references public.profiles(id) on delete set null,
  responded_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists founder_pass_feedback_user_idx
  on public.founder_pass_feedback_requests(user_id);
create index if not exists founder_pass_feedback_status_idx
  on public.founder_pass_feedback_requests(status);

-- One live credit per holder. Declined rows are excluded so a decline hands the
-- credit back rather than burning it.
create unique index if not exists founder_pass_feedback_one_live
  on public.founder_pass_feedback_requests(user_id)
  where status <> 'declined';

drop trigger if exists touch_founder_pass_feedback
  on public.founder_pass_feedback_requests;
create trigger touch_founder_pass_feedback before update
  on public.founder_pass_feedback_requests
  for each row execute procedure public.touch_updated_at();

-- ----------------------------------------------------------------------------
-- 3. Seven-day rebuild — a declined holder's one shot at a fresh review.
--
-- One row per holder (the "one chance"). Links to the application it should
-- re-open; on submit the admin queue badges that application for re-review, and
-- decideApplication marks the rebuild reviewed when a fresh decision lands.
-- ----------------------------------------------------------------------------
create table if not exists public.founder_pass_rebuilds (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  application_id uuid references public.applications(id) on delete set null,
  -- What they validated, who they spoke to, what they shipped, what they learned.
  summary text not null default '',
  -- Link to the thing they built.
  link_url text,
  status text not null default 'submitted'
    check (status in ('submitted', 'reviewing', 'reviewed')),
  reviewed_by uuid references public.profiles(id) on delete set null,
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists founder_pass_rebuilds_status_idx
  on public.founder_pass_rebuilds(status);

-- One rebuild per holder — the perk is "one chance to build your way back in".
create unique index if not exists founder_pass_rebuilds_one_per_user
  on public.founder_pass_rebuilds(user_id);

drop trigger if exists touch_founder_pass_rebuilds
  on public.founder_pass_rebuilds;
create trigger touch_founder_pass_rebuilds before update
  on public.founder_pass_rebuilds
  for each row execute procedure public.touch_updated_at();

-- ----------------------------------------------------------------------------
-- 4. Structured rejection feedback on applications.
--
-- The pass promises a "no" that explains itself. review_notes (0001) already
-- carries the free-text version and the acceptance/rejection emails read it;
-- these columns add the four labelled parts so a pass holder's decision renders
-- as structure rather than a paragraph. All are applicant-visible (same as
-- review_notes) and inherit the applications RLS policies — no new policy.
--
-- The reject path composes review_notes FROM these fields too, so the email and
-- every pre-existing surface keep working even on a database where these
-- columns don't exist yet (the write tolerates the missing-column error, like
-- redeemed_code in 0040).
-- ----------------------------------------------------------------------------
alter table public.applications
  add column if not exists feedback_strongest text,
  add column if not exists feedback_missing text,
  add column if not exists feedback_next_step text,
  -- Whether the reviewer judged this applicant eligible to come back for a
  -- fresh look (informational to the holder; the rebuild perk is offered on
  -- rejection regardless, so a forgotten flag never silently revokes it).
  add column if not exists feedback_second_review boolean;

-- ============================================================================
-- Row Level Security
-- ============================================================================
alter table public.founder_pass_feedback_requests enable row level security;
alter table public.founder_pass_rebuilds enable row level security;

-- Holders read their own; admins read/write all. All writes flow through the
-- service-role client in server actions (which enforce "holds a pass", "one
-- credit", "declined + before deadline"), so there is deliberately no self-
-- insert/update policy — mirrors founder_passes (0039).
drop policy if exists "founder_pass_feedback self select"
  on public.founder_pass_feedback_requests;
create policy "founder_pass_feedback self select"
  on public.founder_pass_feedback_requests
  for select using (user_id = auth.uid() or public.is_admin(auth.uid()));

drop policy if exists "founder_pass_feedback admin write"
  on public.founder_pass_feedback_requests;
create policy "founder_pass_feedback admin write"
  on public.founder_pass_feedback_requests
  for all using (public.is_admin(auth.uid()))
  with check (public.is_admin(auth.uid()));

drop policy if exists "founder_pass_rebuilds self select"
  on public.founder_pass_rebuilds;
create policy "founder_pass_rebuilds self select"
  on public.founder_pass_rebuilds
  for select using (user_id = auth.uid() or public.is_admin(auth.uid()));

drop policy if exists "founder_pass_rebuilds admin write"
  on public.founder_pass_rebuilds;
create policy "founder_pass_rebuilds admin write"
  on public.founder_pass_rebuilds
  for all using (public.is_admin(auth.uid()))
  with check (public.is_admin(auth.uid()));

notify pgrst, 'reload schema';
