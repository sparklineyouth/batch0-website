-- ============================================================================
-- 0087 — Hackathons: challenges become events you register for, then submit to.
--
-- Why this exists
-- ---------------
-- 0036 modelled a challenge as "one short form, one text prize label, one live
-- at a time". Three challenges and one submission later, the shape was the
-- problem, not the idea: there was no way to say *when* anything happens
-- beyond a close date, a prize could only be a sentence (so the Meta glasses
-- giveaway was a title in all caps), and the only action on the page was a
-- form that asked for everything up front.
--
-- This makes a challenge work like an event page:
--
--   register   one click, needs an account, nothing else. A registration is
--              its own row (challenge_registrations) so "who's in" no longer
--              depends on "who finished the form".
--   draft      the submission form autosaves. A draft is a challenge_submissions
--              row with status 'draft' — same table, same unique key, so a
--              draft turning into an entry is an UPDATE, never a second row.
--   submit     validated against the challenge's own questions, optionally
--              gated on N qualified referrals (referrals_required).
--
-- Everything here is additive and safe under the currently deployed code:
-- every new column defaults to what that code did (existing challenges stay
-- non-editable), and the self-insert policy is narrowed, not dropped — see
-- section 3 and 0088, which finishes the job after deploy.
--
-- The one removal: `challenges_one_active`. It existed because the homepage
-- marquee was a single slot. Running a hackathon and a giveaway at the same
-- time is the normal case now, so the marquee picks one (featured first, then
-- the soonest deadline) instead of the database refusing the second.
--
-- Run in the Supabase SQL Editor or `supabase db push`. Idempotent.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. challenges — event details
-- ----------------------------------------------------------------------------
-- `prizes` is added on its own, inside the same block as its backfill, so the
-- backfill runs exactly once — in the run that creates the column. After
-- deploy, `prize_label` is the editor's optional headline override, so a
-- re-run that backfilled every "headline but no prizes" row would inject a
-- prize card an admin never asked for.
do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'challenges' and column_name = 'prizes'
  ) then
    alter table public.challenges add column prizes jsonb not null default '[]'::jsonb;
    -- A pre-0087 prize was one sentence plus an optional amount. Lift it into
    -- a single structured prize so old pages have something to show.
    update public.challenges
    set prizes = jsonb_build_array(
      jsonb_build_object(
        'id', 'legacy',
        'place', 'Prize',
        'kind', case when prize_amount_cents is not null then 'cash' else 'item' end,
        'title', prize_label,
        'description', '',
        'valueCents', prize_amount_cents,
        'quantity', 1,
        'imageUrl', null
      )
    )
    where coalesce(prize_label, '') <> '';
  end if;

  -- Existing challenges keep the old rule (an entry is final); new ones
  -- default to editable. Same once-only guard, same reason.
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'challenges' and column_name = 'allow_edits'
  ) then
    alter table public.challenges add column allow_edits boolean not null default false;
    alter table public.challenges alter column allow_edits set default true;
  end if;
end $$;

alter table public.challenges
  -- What the page calls itself. A label, not behaviour: all three kinds
  -- register, submit, and award the same way.
  add column if not exists kind text not null default 'challenge',
  -- One line under the title and on the index card.
  add column if not exists tagline text not null default '',
  -- Square cover. Null = the typographic cover rendered from the title.
  add column if not exists cover_image_url text,
  add column if not exists cover_theme text not null default 'phosphor',
  add column if not exists location text not null default 'Online',
  add column if not exists location_url text,
  -- When winners are announced. Display only.
  add column if not exists results_at timestamptz,
  -- Structured content. Shapes are validated in code (lib/challenges-shared.ts
  -- sanitize*), exactly like `questions` — the DB only promises an array.
  add column if not exists schedule jsonb not null default '[]'::jsonb,
  add column if not exists faq jsonb not null default '[]'::jsonb,
  add column if not exists resources jsonb not null default '[]'::jsonb,
  add column if not exists rules text not null default '',
  -- Entry requirements.
  add column if not exists referrals_required integer not null default 0,
  -- Homepage marquee preference when more than one challenge is live.
  add column if not exists featured boolean not null default false;

alter table public.challenges drop constraint if exists challenges_kind_check;
alter table public.challenges add constraint challenges_kind_check
  check (kind in ('hackathon', 'challenge', 'giveaway'));

alter table public.challenges drop constraint if exists challenges_cover_theme_check;
alter table public.challenges add constraint challenges_cover_theme_check
  check (cover_theme in ('phosphor', 'ink', 'paper'));

alter table public.challenges drop constraint if exists challenges_referrals_required_check;
alter table public.challenges add constraint challenges_referrals_required_check
  check (referrals_required between 0 and 50);

drop index if exists public.challenges_one_active;

-- ----------------------------------------------------------------------------
-- 2. challenge_registrations — "I'm in"
-- ----------------------------------------------------------------------------
create table if not exists public.challenge_registrations (
  id uuid primary key default gen_random_uuid(),
  challenge_id uuid not null references public.challenges(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  -- The referral code on the link they registered through (lowercase). This is
  -- what makes a registration count toward someone else's referrals_required.
  referral_code text,
  created_at timestamptz not null default now(),
  unique (challenge_id, user_id)
);

create index if not exists challenge_registrations_challenge_idx
  on public.challenge_registrations(challenge_id, created_at desc);
create index if not exists challenge_registrations_user_idx
  on public.challenge_registrations(user_id);
create index if not exists challenge_registrations_referral_idx
  on public.challenge_registrations(challenge_id, referral_code)
  where referral_code is not null;

alter table public.challenge_registrations enable row level security;

-- Read your own; staff read all. There is deliberately no insert policy: a
-- registration carries referral attribution, so it is written by the server
-- action (service role) after it has checked the challenge is open and the
-- code isn't the registrant's own.
drop policy if exists "challenge_registrations self select"
  on public.challenge_registrations;
create policy "challenge_registrations self select"
  on public.challenge_registrations
  for select using (
    user_id = auth.uid() or public.is_admin(auth.uid())
  );

drop policy if exists "challenge_registrations admin write"
  on public.challenge_registrations;
create policy "challenge_registrations admin write"
  on public.challenge_registrations
  for all using (public.is_admin(auth.uid()))
  with check (public.is_admin(auth.uid()));

-- Every pre-0087 submitter was, in effect, registered. Give them the row so
-- counts and "you're in" states are right on the old challenges.
insert into public.challenge_registrations (challenge_id, user_id, referral_code, created_at)
select s.challenge_id, s.user_id, s.referral_code, s.created_at
from public.challenge_submissions s
on conflict (challenge_id, user_id) do nothing;

-- ----------------------------------------------------------------------------
-- 3. challenge_submissions — drafts, submit time, awarded prize
-- ----------------------------------------------------------------------------
alter table public.challenge_submissions
  add column if not exists submitted_at timestamptz,
  -- Which entry in challenges.prizes this submission won, plus a frozen label
  -- ("1st place — Ray-Ban Meta glasses") so the public winners strip stays
  -- right even if the prize list is edited later.
  add column if not exists prize_id text,
  add column if not exists award_label text,
  -- When the "email results" action told this entrant how it went. Makes that
  -- action safe to press twice.
  add column if not exists results_notified_at timestamptz;

update public.challenge_submissions
set submitted_at = created_at
where submitted_at is null and status <> 'draft';

alter table public.challenge_submissions
  drop constraint if exists challenge_submissions_status_check;
alter table public.challenge_submissions
  add constraint challenge_submissions_status_check
  check (status in ('draft', 'submitted', 'shortlisted', 'funded', 'rejected', 'withdrawn'));

alter table public.challenge_submissions alter column status set default 'draft';

-- 0036 let a signed-in user INSERT their own row with any status — including
-- 'funded' — straight through PostgREST. The new code writes only through
-- validated server actions (service role), so the policy is not needed by it.
--
-- It is NARROWED here rather than dropped, because the code deployed while
-- this migration runs (pre-0087) still inserts entries through that policy:
-- dropping it would break every entry in the gap between migrating and
-- deploying. The narrowed form admits exactly the old code's row shape and
-- nothing an entrant could use to award themselves. 0088 drops it once the
-- new code is live.
drop policy if exists "challenge_submissions self insert"
  on public.challenge_submissions;
create policy "challenge_submissions self insert" on public.challenge_submissions
  for insert with check (
    user_id = auth.uid()
    and status = 'submitted'
    and payout_amount_cents is null
    and winner_public = false
    and reviewed_by is null
    and reviewed_at is null
    and review_notes is null
    and public_name is null
    and public_blurb is null
    and public_project_url is null
    and prize_id is null
    and award_label is null
  );

-- ----------------------------------------------------------------------------
-- 4. Public winners view — now carries what they won
-- ----------------------------------------------------------------------------
-- `create or replace view` may only append columns, so the new ones go last.
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
    s.reviewed_at   as funded_at,
    s.award_label,
    s.prize_id
  from public.challenge_submissions s
  join public.challenges c on c.id = s.challenge_id
  where s.status = 'funded'
    and s.winner_public = true
    and c.winners_published = true;

-- ----------------------------------------------------------------------------
-- 5. Storage
-- ----------------------------------------------------------------------------
-- challenge-uploads (private): entrant files. 0047 created it for mp4 only;
-- the form now takes screenshots, PDFs, decks and zips too. The MIME list is
-- dropped rather than extended because browsers disagree on the type they send
-- for the same file (a zip is application/zip, x-zip-compressed, or empty
-- depending on OS), and a bucket-level refusal surfaces as an opaque 400. The
-- extension is checked in getChallengeUploadToken instead, where the question
-- and the error message are both known.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('challenge-uploads', 'challenge-uploads', false, 209715200, null)
on conflict (id) do update
  set public = false,
      allowed_mime_types = null,
      file_size_limit = greatest(
        coalesce(storage.buckets.file_size_limit, 0),
        209715200
      );

-- challenge-media (public): covers and prize photos, written by staff through a
-- signed upload URL and shown on public pages.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'challenge-media',
  'challenge-media',
  true,
  10485760,             -- 10 MB
  array['image/png', 'image/jpeg', 'image/webp', 'image/gif']
)
on conflict (id) do update set public = true;

drop policy if exists "challenge-media read" on storage.objects;
create policy "challenge-media read" on storage.objects
  for select using (bucket_id = 'challenge-media');

drop policy if exists "challenge-media staff write" on storage.objects;
create policy "challenge-media staff write" on storage.objects
  for all to authenticated
  using (
    bucket_id = 'challenge-media'
    and (
      public.is_admin(auth.uid())
      or public.has_permission(auth.uid(), 'challenges.manage')
    )
  )
  with check (
    bucket_id = 'challenge-media'
    and (
      public.is_admin(auth.uid())
      or public.has_permission(auth.uid(), 'challenges.manage')
    )
  );

notify pgrst, 'reload schema';
