-- ============================================================================
-- 0036 — Weekly Challenges.
--
-- Sparkline runs weekly "challenge promotions": students apply (free) with a
-- SHORT single-page form whose questions are ADMIN-AUTHORED per challenge and
-- stored as JSONB (fully dynamic — unlike the fixed-skeleton cohort
-- application). Admins review, shortlist, and fund winners (payout paid
-- offline, amount recorded). An ACTIVE challenge shows as a hero marquee.
-- Funded winners can be shown publicly in a curated "recently funded" strip
-- WITHOUT leaking applicant PII.
--
-- House-style notes: text+check status (never pg enums, like cohorts /
-- applications), public.is_admin(auth.uid()) RLS, the shared
-- public.touch_updated_at() trigger, a partial unique index to enforce
-- "one active challenge", and `notify pgrst, 'reload schema'` at the end.
--
-- Run in the Supabase SQL Editor. Idempotent / safe to re-run.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- challenges
-- ----------------------------------------------------------------------------
create table if not exists public.challenges (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  title text not null,
  -- Long-form prompt shown on the apply page. Plain text.
  description text not null default '',
  -- Funding label ("Up to $500 to build it") + machine amount for admin math.
  prize_label text not null default '',
  prize_amount_cents integer,
  -- Hero marquee content.
  marquee_text text not null default '',
  cta_label text not null default 'Apply',
  cta_href text,                       -- null => defaults to /challenges/<slug>
  status text not null default 'draft'
    check (status in ('draft', 'active', 'closed', 'archived')),
  opens_at timestamptz,
  closes_at timestamptz,
  -- Admin-authored question defs: an array of objects. Shape is validated in
  -- code (lib/challenges.ts sanitizeQuestions), NOT by the DB — mirrors how
  -- application_questions lives as jsonb in site_settings.
  questions jsonb not null default '[]'::jsonb,
  -- Master switch for the public "recently funded" strip for THIS challenge.
  winners_published boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists challenges_status_idx on public.challenges(status);
create index if not exists challenges_slug_idx on public.challenges(slug);

-- At most ONE active challenge (the marquee is a single slot). A second
-- activation fails at the DB; the admin "activate" action demotes the
-- incumbent first so the UI never trips this. Every row in the partial index
-- has status='active', so a unique index on that single column permits only
-- one such row.
create unique index if not exists challenges_one_active
  on public.challenges (status) where status = 'active';

drop trigger if exists touch_challenges on public.challenges;
create trigger touch_challenges before update on public.challenges
  for each row execute procedure public.touch_updated_at();

-- ----------------------------------------------------------------------------
-- challenge_submissions
-- One row per (challenge, user). Answers are keyed by stable question id.
-- ----------------------------------------------------------------------------
create table if not exists public.challenge_submissions (
  id uuid primary key default gen_random_uuid(),
  challenge_id uuid not null references public.challenges(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  -- { "<question_id>": "<answer>", ... } — keyed by stable question id.
  answers jsonb not null default '{}'::jsonb,
  -- Frozen copy of the challenge's question defs AT SUBMIT TIME. Lets admin
  -- review stay readable even after the admin edits the live questions.
  questions_snapshot jsonb not null default '[]'::jsonb,
  status text not null default 'submitted'
    check (status in ('submitted', 'shortlisted', 'funded', 'rejected', 'withdrawn')),
  payout_amount_cents integer,          -- recorded on funding; paid offline
  review_notes text,                    -- private, admin-only
  reviewed_by uuid references public.profiles(id) on delete set null,
  reviewed_at timestamptz,
  referral_code text,                   -- attributed like /apply
  -- Public winners strip (curated; never surfaces raw answers/PII).
  winner_public boolean not null default false,
  public_name text,                     -- e.g. "Maya R." — admin-curated
  public_blurb text,                    -- one-line project description
  public_project_url text,              -- optional link to the built thing
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (challenge_id, user_id)        -- one application per user per challenge
);

create index if not exists challenge_submissions_challenge_idx
  on public.challenge_submissions(challenge_id, created_at desc);
create index if not exists challenge_submissions_user_idx
  on public.challenge_submissions(user_id);
create index if not exists challenge_submissions_status_idx
  on public.challenge_submissions(status);
-- Fast lookup for the public winners strip.
create index if not exists challenge_submissions_public_winner_idx
  on public.challenge_submissions(challenge_id)
  where winner_public = true;

drop trigger if exists touch_challenge_submissions on public.challenge_submissions;
create trigger touch_challenge_submissions before update
  on public.challenge_submissions
  for each row execute procedure public.touch_updated_at();

-- ----------------------------------------------------------------------------
-- Public winners view — the ONLY public-facing projection of submissions.
-- Projects curated columns only: NO answers, user_id, email, or review_notes.
-- Triple-gated: submission status='funded' AND winner_public AND the
-- challenge's winners_published flag, so nothing surfaces unless an admin
-- explicitly curated AND published it. Read via the service-role client on the
-- marketing surface (like the rest of getSiteConfig).
-- ----------------------------------------------------------------------------
create or replace view public.challenge_winners_public as
  select
    s.id,
    s.challenge_id,
    c.slug          as challenge_slug,
    c.title         as challenge_title,
    s.public_name,
    s.public_blurb,
    s.public_project_url,
    s.payout_amount_cents,
    s.reviewed_at   as funded_at
  from public.challenge_submissions s
  join public.challenges c on c.id = s.challenge_id
  where s.status = 'funded'
    and s.winner_public = true
    and c.winners_published = true;

-- ============================================================================
-- Row Level Security
-- ============================================================================
alter table public.challenges enable row level security;
alter table public.challenge_submissions enable row level security;

-- challenges: signed-in users read active/closed (to view the apply page /
-- results); admins do everything. The marketing hero + apply page read via the
-- service-role admin client (RLS-bypass), so anon visitors get the marquee
-- without a public read policy — this governs the authenticated user client.
drop policy if exists "challenges read" on public.challenges;
create policy "challenges read" on public.challenges
  for select using (
    public.is_admin(auth.uid())
    or status in ('active', 'closed')
  );

drop policy if exists "challenges admin write" on public.challenges;
create policy "challenges admin write" on public.challenges
  for all using (public.is_admin(auth.uid()))
  with check (public.is_admin(auth.uid()));

-- submissions: a user reads/creates their OWN; admins read/write all. Status,
-- payout, and review fields are admin-only (server writes go through the admin
-- client), so there is no self-update policy.
drop policy if exists "challenge_submissions self select"
  on public.challenge_submissions;
create policy "challenge_submissions self select" on public.challenge_submissions
  for select using (
    user_id = auth.uid() or public.is_admin(auth.uid())
  );

drop policy if exists "challenge_submissions self insert"
  on public.challenge_submissions;
create policy "challenge_submissions self insert" on public.challenge_submissions
  for insert with check (user_id = auth.uid());

drop policy if exists "challenge_submissions admin write"
  on public.challenge_submissions;
create policy "challenge_submissions admin write" on public.challenge_submissions
  for all using (public.is_admin(auth.uid()))
  with check (public.is_admin(auth.uid()));

-- ============================================================================
-- Global kill switch (mirrors referrals_enabled, 0018). Tolerated when
-- missing — the app defaults challenges ON — but seeding surfaces it in the
-- admin settings form.
-- ============================================================================
insert into public.site_settings (key, value)
values ('challenges_enabled', 'true')
on conflict (key) do nothing;

notify pgrst, 'reload schema';
