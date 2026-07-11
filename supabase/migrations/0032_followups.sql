-- ============================================================================
-- 0032 — Follow-up features: cap table holders, demo-day rubric scoring,
--        course feedback summaries, SAFE e-sign offers, weekly recaps,
--        public team pages, at-risk interventions, multi-reviewer
--        applications, pitch coach, mentor matching, cohort branding.
--
-- Run in Supabase SQL Editor. Idempotent / safe to re-run.
-- Assumes 0001..0031 applied.
-- ============================================================================

create extension if not exists "pg_trgm";

-- ----------------------------------------------------------------------------
-- Cap table holders: rows = humans/entities + their slice of a team.
-- Existing teams.raised_cents (0028) stays — that's a summary.
-- ----------------------------------------------------------------------------
create table if not exists public.cap_table_holders (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references public.teams(id) on delete cascade,
  -- Optional link to a Sparkline profile (founders); otherwise external.
  profile_id uuid references public.profiles(id) on delete set null,
  display_name text not null,
  kind text not null check (kind in ('founder', 'option', 'safe', 'investor', 'advisor')),
  shares_bp int,            -- basis-points of ownership (1/100th of a percent)
  amount_cents bigint,      -- for SAFEs / cash investments
  valuation_cap_cents bigint,
  discount_pct numeric(5,2),
  vesting_start date,
  vesting_months int,
  cliff_months int,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists cap_table_holders_team_idx
  on public.cap_table_holders (team_id, kind);

drop trigger if exists touch_cap_table_holders on public.cap_table_holders;
create trigger touch_cap_table_holders before update on public.cap_table_holders
  for each row execute procedure public.touch_updated_at();

alter table public.cap_table_holders enable row level security;

drop policy if exists "cap_table read" on public.cap_table_holders;
create policy "cap_table read" on public.cap_table_holders
  for select using (
    public.is_staff(auth.uid())
    or public.is_investor(auth.uid())
    or exists (
      select 1 from public.team_members tm
      where tm.team_id = cap_table_holders.team_id and tm.user_id = auth.uid()
    )
  );

drop policy if exists "cap_table member write" on public.cap_table_holders;
create policy "cap_table member write" on public.cap_table_holders
  for all using (
    public.is_admin(auth.uid())
    or exists (
      select 1 from public.team_members tm
      where tm.team_id = cap_table_holders.team_id and tm.user_id = auth.uid()
    )
  ) with check (
    public.is_admin(auth.uid())
    or exists (
      select 1 from public.team_members tm
      where tm.team_id = cap_table_holders.team_id and tm.user_id = auth.uid()
    )
  );

-- ----------------------------------------------------------------------------
-- DEMO DAY: rubric criteria + judge scores + audience reactions.
-- ----------------------------------------------------------------------------
create table if not exists public.demo_day_rubric_criteria (
  id uuid primary key default gen_random_uuid(),
  cohort_id uuid references public.cohorts(id) on delete cascade,
  label text not null,
  description text,
  weight numeric(5,2) not null default 1.0,
  max_score int not null default 5,
  position int not null default 0,
  created_at timestamptz not null default now()
);

create index if not exists rubric_criteria_cohort_idx
  on public.demo_day_rubric_criteria (cohort_id, position);

alter table public.demo_day_rubric_criteria enable row level security;

drop policy if exists "rubric read" on public.demo_day_rubric_criteria;
create policy "rubric read" on public.demo_day_rubric_criteria
  for select using (auth.uid() is not null);

drop policy if exists "rubric admin write" on public.demo_day_rubric_criteria;
create policy "rubric admin write" on public.demo_day_rubric_criteria
  for all using (public.is_admin(auth.uid()))
  with check (public.is_admin(auth.uid()));

create table if not exists public.demo_day_scores (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references public.teams(id) on delete cascade,
  judge_id uuid not null references public.profiles(id) on delete cascade,
  criterion_id uuid not null references public.demo_day_rubric_criteria(id) on delete cascade,
  score int not null check (score >= 0),
  comment text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (team_id, judge_id, criterion_id)
);

create index if not exists demo_day_scores_team_idx
  on public.demo_day_scores (team_id);
create index if not exists demo_day_scores_judge_idx
  on public.demo_day_scores (judge_id);

drop trigger if exists touch_demo_day_scores on public.demo_day_scores;
create trigger touch_demo_day_scores before update on public.demo_day_scores
  for each row execute procedure public.touch_updated_at();

alter table public.demo_day_scores enable row level security;

drop policy if exists "dd_scores read" on public.demo_day_scores;
create policy "dd_scores read" on public.demo_day_scores
  for select using (
    public.is_admin(auth.uid())
    or judge_id = auth.uid()
    or exists (
      select 1 from public.team_members tm
      where tm.team_id = demo_day_scores.team_id and tm.user_id = auth.uid()
    )
  );

drop policy if exists "dd_scores judge write" on public.demo_day_scores;
create policy "dd_scores judge write" on public.demo_day_scores
  for all using (
    judge_id = auth.uid() and (
      public.is_admin(auth.uid())
      or public.is_investor(auth.uid())
      or public.is_mentor(auth.uid())
    )
  ) with check (
    judge_id = auth.uid() and (
      public.is_admin(auth.uid())
      or public.is_investor(auth.uid())
      or public.is_mentor(auth.uid())
    )
  );

create table if not exists public.demo_day_reactions (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references public.teams(id) on delete cascade,
  user_id uuid references public.profiles(id) on delete set null,
  emoji text not null check (char_length(emoji) between 1 and 8),
  created_at timestamptz not null default now()
);

create index if not exists demo_day_reactions_team_idx
  on public.demo_day_reactions (team_id, created_at desc);

alter table public.demo_day_reactions enable row level security;

drop policy if exists "dd_react read" on public.demo_day_reactions;
create policy "dd_react read" on public.demo_day_reactions
  for select using (auth.uid() is not null);

drop policy if exists "dd_react insert" on public.demo_day_reactions;
create policy "dd_react insert" on public.demo_day_reactions
  for insert with check (
    auth.uid() is not null and user_id = auth.uid()
  );

-- ----------------------------------------------------------------------------
-- SAFE / term-sheet offers: investor → team with in-platform e-sign.
-- ----------------------------------------------------------------------------
create table if not exists public.safe_offers (
  id uuid primary key default gen_random_uuid(),
  investor_id uuid not null references public.profiles(id) on delete cascade,
  team_id uuid not null references public.teams(id) on delete cascade,
  amount_cents bigint not null check (amount_cents > 0),
  valuation_cap_cents bigint,
  discount_pct numeric(5,2),
  mfn boolean not null default false,
  pro_rata boolean not null default false,
  notes text,
  document_md text,         -- rendered SAFE document at the moment of send
  status text not null default 'draft'
    check (status in ('draft','sent','countersigned','accepted','declined','withdrawn')),
  sent_at timestamptz,
  investor_signed_at timestamptz,
  investor_signature_name text,
  investor_signature_ip text,
  team_signed_at timestamptz,
  team_signed_by uuid references public.profiles(id) on delete set null,
  team_signature_name text,
  team_signature_ip text,
  withdrawn_at timestamptz,
  declined_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists safe_offers_team_idx
  on public.safe_offers (team_id, status);
create index if not exists safe_offers_investor_idx
  on public.safe_offers (investor_id, status, created_at desc);

drop trigger if exists touch_safe_offers on public.safe_offers;
create trigger touch_safe_offers before update on public.safe_offers
  for each row execute procedure public.touch_updated_at();

alter table public.safe_offers enable row level security;

drop policy if exists "safe_offers read" on public.safe_offers;
create policy "safe_offers read" on public.safe_offers
  for select using (
    public.is_admin(auth.uid())
    or investor_id = auth.uid()
    or exists (
      select 1 from public.team_members tm
      where tm.team_id = safe_offers.team_id and tm.user_id = auth.uid()
    )
  );

drop policy if exists "safe_offers investor write" on public.safe_offers;
create policy "safe_offers investor write" on public.safe_offers
  for insert with check (
    investor_id = auth.uid() and public.is_investor(auth.uid())
  );

drop policy if exists "safe_offers participant update" on public.safe_offers;
create policy "safe_offers participant update" on public.safe_offers
  for update using (
    public.is_admin(auth.uid())
    or investor_id = auth.uid()
    or exists (
      select 1 from public.team_members tm
      where tm.team_id = safe_offers.team_id and tm.user_id = auth.uid()
    )
  ) with check (
    public.is_admin(auth.uid())
    or investor_id = auth.uid()
    or exists (
      select 1 from public.team_members tm
      where tm.team_id = safe_offers.team_id and tm.user_id = auth.uid()
    )
  );

-- ----------------------------------------------------------------------------
-- Founder weekly recap log: keeps cron idempotent + lets admins audit
-- what went out and to whom.
-- ----------------------------------------------------------------------------
create table if not exists public.founder_recap_log (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references public.teams(id) on delete cascade,
  week_start date not null,
  summary text not null,
  parent_emails text[] not null default '{}',
  mentor_ids uuid[] not null default '{}',
  sent_at timestamptz not null default now(),
  unique (team_id, week_start)
);

create index if not exists founder_recap_team_idx
  on public.founder_recap_log (team_id, week_start desc);

alter table public.founder_recap_log enable row level security;

drop policy if exists "founder_recap admin read" on public.founder_recap_log;
create policy "founder_recap admin read" on public.founder_recap_log
  for select using (public.is_staff(auth.uid()));

-- ----------------------------------------------------------------------------
-- Public team-page extras: showcase blurb, demo video override, etc.
-- ----------------------------------------------------------------------------
alter table public.teams
  add column if not exists public_blurb text,
  add column if not exists demo_video_url text,
  add column if not exists demo_day_recap text,
  add column if not exists demo_day_recap_at timestamptz,
  add column if not exists show_on_homepage boolean not null default false;

create unique index if not exists teams_slug_global_unique
  on public.teams (lower(slug));

-- ----------------------------------------------------------------------------
-- At-risk interventions: one row per (student, week_window). The cron is
-- idempotent so it won't re-nudge the same student twice in the same window.
-- ----------------------------------------------------------------------------
create table if not exists public.at_risk_interventions (
  id uuid primary key default gen_random_uuid(),
  student_id uuid not null references public.profiles(id) on delete cascade,
  -- Monday of the ISO week the intervention covers. Used as the dedupe key
  -- so we don't nudge the same student twice in the same week.
  week_start date not null default (date_trunc('week', now() at time zone 'utc'))::date,
  missed_weeks int not null,
  reason text not null,
  resolved_at timestamptz,
  intro_request_id uuid references public.intro_requests(id) on delete set null,
  created_at timestamptz not null default now()
);

create unique index if not exists at_risk_student_window_idx
  on public.at_risk_interventions (student_id, week_start);

alter table public.at_risk_interventions enable row level security;

drop policy if exists "at_risk staff read" on public.at_risk_interventions;
create policy "at_risk staff read" on public.at_risk_interventions
  for select using (public.is_staff(auth.uid()));

drop policy if exists "at_risk admin write" on public.at_risk_interventions;
create policy "at_risk admin write" on public.at_risk_interventions
  for all using (public.is_admin(auth.uid()))
  with check (public.is_admin(auth.uid()));

-- ----------------------------------------------------------------------------
-- Application reviews: multi-reviewer scoring, blind-review opt-out.
-- ----------------------------------------------------------------------------
create table if not exists public.application_reviews (
  id uuid primary key default gen_random_uuid(),
  application_id uuid not null references public.applications(id) on delete cascade,
  reviewer_id uuid not null references public.profiles(id) on delete cascade,
  -- Five 1..5 scores; nullable so a reviewer can save partial drafts.
  idea int check (idea between 1 and 5),
  founder int check (founder between 1 and 5),
  motivation int check (motivation between 1 and 5),
  feasibility int check (feasibility between 1 and 5),
  fit int check (fit between 1 and 5),
  decision text check (decision in ('strong_accept','accept','borderline','reject','strong_reject')),
  notes text,
  submitted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (application_id, reviewer_id)
);

create index if not exists app_reviews_app_idx
  on public.application_reviews (application_id, submitted_at desc);
create index if not exists app_reviews_reviewer_idx
  on public.application_reviews (reviewer_id, submitted_at desc);

drop trigger if exists touch_application_reviews on public.application_reviews;
create trigger touch_application_reviews before update on public.application_reviews
  for each row execute procedure public.touch_updated_at();

alter table public.application_reviews enable row level security;

drop policy if exists "app_reviews staff read" on public.application_reviews;
create policy "app_reviews staff read" on public.application_reviews
  for select using (public.is_staff(auth.uid()));

drop policy if exists "app_reviews own write" on public.application_reviews;
create policy "app_reviews own write" on public.application_reviews
  for all using (reviewer_id = auth.uid() and public.is_staff(auth.uid()))
  with check (reviewer_id = auth.uid() and public.is_staff(auth.uid()));

-- Helper index for trigram dedupe over startup_idea.
create index if not exists applications_startup_idea_trgm
  on public.applications using gin (startup_idea gin_trgm_ops);

-- ----------------------------------------------------------------------------
-- Pitch coach feedback: AI critique against rubric. One row per submission.
-- ----------------------------------------------------------------------------
create table if not exists public.pitch_coach_feedback (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references public.teams(id) on delete cascade,
  requested_by uuid references public.profiles(id) on delete set null,
  source_kind text not null check (source_kind in ('deck_url','video_url','transcript')),
  source text not null,
  -- Per-rubric criterion: { label: {score, why} }
  scores jsonb not null default '{}',
  overall_score numeric(4,2),
  summary text not null,
  strengths text,
  improvements text,
  created_at timestamptz not null default now()
);

create index if not exists pitch_coach_team_idx
  on public.pitch_coach_feedback (team_id, created_at desc);

alter table public.pitch_coach_feedback enable row level security;

drop policy if exists "pitch_coach read" on public.pitch_coach_feedback;
create policy "pitch_coach read" on public.pitch_coach_feedback
  for select using (
    public.is_staff(auth.uid())
    or exists (
      select 1 from public.team_members tm
      where tm.team_id = pitch_coach_feedback.team_id and tm.user_id = auth.uid()
    )
  );

drop policy if exists "pitch_coach member write" on public.pitch_coach_feedback;
create policy "pitch_coach member write" on public.pitch_coach_feedback
  for insert with check (
    public.is_admin(auth.uid())
    or exists (
      select 1 from public.team_members tm
      where tm.team_id = pitch_coach_feedback.team_id and tm.user_id = auth.uid()
    )
  );

-- ----------------------------------------------------------------------------
-- Mentor bio + tags for matchmaker; trigram index on bio for similarity.
-- ----------------------------------------------------------------------------
alter table public.profiles
  add column if not exists mentor_bio text,
  add column if not exists mentor_tags text[];

create index if not exists profiles_mentor_bio_trgm
  on public.profiles using gin (mentor_bio gin_trgm_ops)
  where mentor_bio is not null;

-- ----------------------------------------------------------------------------
-- Cohort branding: cohorts already have slug, name. Add hero + accent so
-- cohort-scoped landing pages can override marketing copy without code.
-- ----------------------------------------------------------------------------
alter table public.cohorts
  add column if not exists landing_headline text,
  add column if not exists landing_subhead text,
  add column if not exists landing_cta_label text,
  add column if not exists accent_hex text,
  add column if not exists hero_image_url text;

-- ----------------------------------------------------------------------------
-- Audit log diff payloads: existing column is jsonb; standardize a
-- { before, after, fields } shape for diff viewing. No schema change
-- required — convention only — but add a covering index.
-- ----------------------------------------------------------------------------
create index if not exists audit_log_target_idx
  on public.audit_log (target_type, target_id, created_at desc);

notify pgrst, 'reload schema';
