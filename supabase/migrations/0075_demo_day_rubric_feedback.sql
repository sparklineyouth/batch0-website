-- ============================================================================
-- 0075 — Scoring anchors on the Demo Day rubric, and releasing a team's
--        scorecard back to its founders.
--
-- Two additions, both in service of the same thing: judge scores that mean
-- something, and the choice to hand them back.
--
-- ANCHORS. `demo_day_rubric_criteria.anchors` holds the written bands for a
-- criterion — "5 = live demo of the core loop, end to end", "3 = partially
-- working prototype" — as a jsonb array of {level, label}. Judges read the
-- band next to the number they are about to click, and founders read the band
-- they landed on when the feedback comes back, so one sentence does both the
-- calibrating and the explaining. No content is seeded here: the five
-- criteria we actually use live in lib/demo-day-rubric.ts and an admin
-- installs them with one button at /admin/demo-day/rubric. A copy of that
-- copy in SQL would be a second source of truth that drifts the first time
-- someone rewords an anchor.
--
-- RELEASES. `demo_day_feedback_releases` is the gate on founders seeing their
-- own scorecard. Judges score live and sometimes bluntly, teams are scored by
-- different numbers of judges, and a criterion gets rescored after a judge
-- rejoins — so scores must stay invisible to the teams until a human decides
-- a team's card is finished and fair to hand over. One row per team, holding
-- that decision and what it covered: whether it shows on their dashboard,
-- whether judge notes travel with the numbers, an optional note from us, and
-- when it was emailed.
--
-- Un-releasing is a supported move (released_at back to null), which is why
-- the row persists rather than being deleted: `email_count` and `emailed_at`
-- are the record of what already left the building, and that history must
-- survive someone hiding a card again.
--
-- The read policy on `demo_day_scores` is narrowed to match. Since 0032 any
-- team member could select their team's rows directly through the API, which
-- would have shown a founder their raw scores the moment a judge saved one,
-- regardless of what the dashboard chose to render. Admins and the judge who
-- wrote a row are unaffected.
--
-- Run in Supabase SQL Editor. Idempotent / safe to re-run.
-- Assumes 0001..0074 are applied.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Anchors
-- ---------------------------------------------------------------------------

alter table public.demo_day_rubric_criteria
  add column if not exists anchors jsonb not null default '[]'::jsonb;

comment on column public.demo_day_rubric_criteria.anchors is
  'Scoring bands as [{"level": 5, "label": "what a 5 looks like"}, ...], highest first. Shown to judges while scoring and to founders when feedback is released.';

-- ---------------------------------------------------------------------------
-- Feedback releases
-- ---------------------------------------------------------------------------

create table if not exists public.demo_day_feedback_releases (
  -- One decision per team, so the primary key is the team. A second release
  -- row for the same team could only ever contradict the first.
  team_id uuid primary key references public.teams(id) on delete cascade,
  -- Null means "scored, but not handed back". The column is the gate.
  released_at timestamptz,
  released_by uuid references public.profiles(id) on delete set null,
  -- Whether the scorecard appears on the founders' team page. Separate from
  -- released_at so an admin can email the card without parking it in the
  -- dashboard, or vice versa.
  show_on_dashboard boolean not null default true,
  -- Judge notes are the most useful and the most quotable part of a card.
  -- They travel only when someone ticks the box, and never with a name.
  include_comments boolean not null default true,
  -- An optional line from us, shown above the numbers.
  note text,
  emailed_at timestamptz,
  email_count int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists demo_day_feedback_releases_released_idx
  on public.demo_day_feedback_releases (released_at desc nulls last);

drop trigger if exists touch_demo_day_feedback_releases
  on public.demo_day_feedback_releases;
create trigger touch_demo_day_feedback_releases
  before update on public.demo_day_feedback_releases
  for each row execute procedure public.touch_updated_at();

alter table public.demo_day_feedback_releases enable row level security;

-- A team may read its own release row (that is how the dashboard knows there
-- is something to show, and renders the note); nobody outside the team or the
-- admins sees it.
drop policy if exists "dd_release read" on public.demo_day_feedback_releases;
create policy "dd_release read" on public.demo_day_feedback_releases
  for select using (
    public.is_admin(auth.uid())
    or exists (
      select 1 from public.team_members tm
      where tm.team_id = demo_day_feedback_releases.team_id
        and tm.user_id = auth.uid()
    )
  );

drop policy if exists "dd_release admin write" on public.demo_day_feedback_releases;
create policy "dd_release admin write" on public.demo_day_feedback_releases
  for all using (public.is_admin(auth.uid()))
  with check (public.is_admin(auth.uid()));

-- ---------------------------------------------------------------------------
-- Scores stay invisible to a team until their card is released
-- ---------------------------------------------------------------------------

drop policy if exists "dd_scores read" on public.demo_day_scores;
create policy "dd_scores read" on public.demo_day_scores
  for select using (
    public.is_admin(auth.uid())
    or judge_id = auth.uid()
    or exists (
      select 1
      from public.team_members tm
      join public.demo_day_feedback_releases r on r.team_id = tm.team_id
      where tm.team_id = demo_day_scores.team_id
        and tm.user_id = auth.uid()
        and r.released_at is not null
        and r.show_on_dashboard
    )
  );
