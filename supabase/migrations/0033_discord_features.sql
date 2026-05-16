-- ============================================================================
-- 0033 — Discord feature pack: team channels, OH queue, mentor on-call,
-- event RSVPs, milestone check-ins, blocker reports, onboarding progress.
--
-- Run in Supabase SQL Editor. Idempotent / safe to re-run.
-- Assumes 0001..0032 applied.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- teams: track the Discord channels we auto-spawned for the team so we can
-- update permissions on membership changes and tear them down on archive.
-- ----------------------------------------------------------------------------
alter table public.teams
  add column if not exists discord_text_channel_id text,
  add column if not exists discord_voice_channel_id text;

-- ----------------------------------------------------------------------------
-- student_checkins.is_milestone: when true, the check-in is broadcast to
-- the #wins Discord channel + (optionally) celebrated publicly. Students
-- self-tag from the form; staff can flip it after the fact too.
-- ----------------------------------------------------------------------------
alter table public.student_checkins
  add column if not exists is_milestone boolean not null default false;

create index if not exists student_checkins_milestone_idx
  on public.student_checkins (cohort_id, created_at desc)
  where is_milestone = true;

-- ----------------------------------------------------------------------------
-- event_rsvps: minimal RSVP table backing the Discord button flow.
-- One row per (event, user). Status is the latest click. Source records
-- whether the RSVP came from the website or Discord, so we can attribute
-- engagement later.
-- ----------------------------------------------------------------------------
create table if not exists public.event_rsvps (
  event_id uuid not null references public.events(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  status text not null check (status in ('going','maybe','declined')),
  source text not null default 'discord' check (source in ('discord','web')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (event_id, user_id)
);

create index if not exists event_rsvps_event_idx
  on public.event_rsvps (event_id, status);

drop trigger if exists touch_event_rsvps on public.event_rsvps;
create trigger touch_event_rsvps before update on public.event_rsvps
  for each row execute procedure public.touch_updated_at();

alter table public.event_rsvps enable row level security;

drop policy if exists "event_rsvps self all" on public.event_rsvps;
create policy "event_rsvps self all" on public.event_rsvps
  for all using (user_id = auth.uid())
  with check (user_id = auth.uid());

drop policy if exists "event_rsvps staff read" on public.event_rsvps;
create policy "event_rsvps staff read" on public.event_rsvps
  for select using (public.is_staff(auth.uid()));

-- ----------------------------------------------------------------------------
-- oh_queue: ad-hoc office-hours queue distinct from booked mentor_slots.
-- Students join from Discord with `/queue join <topic>`; the on-duty
-- mentor pulls the next item with `/queue next`. Closed rows are kept
-- for analytics (e.g. average wait time).
-- ----------------------------------------------------------------------------
create table if not exists public.oh_queue (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  topic text,
  status text not null default 'waiting'
    check (status in ('waiting','claimed','done','cancelled')),
  claimed_by uuid references public.profiles(id) on delete set null,
  joined_at timestamptz not null default now(),
  claimed_at timestamptz,
  closed_at timestamptz
);

create index if not exists oh_queue_status_idx
  on public.oh_queue (status, joined_at);
create index if not exists oh_queue_user_idx
  on public.oh_queue (user_id, joined_at desc);

alter table public.oh_queue enable row level security;

drop policy if exists "oh_queue self read" on public.oh_queue;
create policy "oh_queue self read" on public.oh_queue
  for select using (
    user_id = auth.uid() or public.is_staff(auth.uid())
  );

drop policy if exists "oh_queue self insert" on public.oh_queue;
create policy "oh_queue self insert" on public.oh_queue
  for insert with check (user_id = auth.uid());

drop policy if exists "oh_queue staff update" on public.oh_queue;
create policy "oh_queue staff update" on public.oh_queue
  for update using (public.is_staff(auth.uid()))
  with check (public.is_staff(auth.uid()));

-- ----------------------------------------------------------------------------
-- mentor_oncall: who's available right now. PK on mentor_id so flipping
-- on/off is an upsert. `expires_at` lets the bot auto-clear after the
-- shift; null means until explicit off. Everyone reads (so the pinned
-- "Mentors on now" message can render to anyone in the help channel).
-- ----------------------------------------------------------------------------
create table if not exists public.mentor_oncall (
  mentor_id uuid primary key references public.profiles(id) on delete cascade,
  started_at timestamptz not null default now(),
  expires_at timestamptz,
  note text
);

create index if not exists mentor_oncall_active_idx
  on public.mentor_oncall (started_at desc);

alter table public.mentor_oncall enable row level security;

drop policy if exists "mentor_oncall read" on public.mentor_oncall;
create policy "mentor_oncall read" on public.mentor_oncall
  for select using (auth.uid() is not null);

drop policy if exists "mentor_oncall self write" on public.mentor_oncall;
create policy "mentor_oncall self write" on public.mentor_oncall
  for all using (
    mentor_id = auth.uid()
    or public.is_admin(auth.uid())
  )
  with check (
    mentor_id = auth.uid()
    or public.is_admin(auth.uid())
  );

-- ----------------------------------------------------------------------------
-- team_blockers: blockers flagged via the "right-click → Flag as Blocker"
-- message context menu. The bot opens a thread, the original reporter +
-- message land here so staff can triage from the website.
-- ----------------------------------------------------------------------------
create table if not exists public.team_blockers (
  id uuid primary key default gen_random_uuid(),
  reporter_id uuid references public.profiles(id) on delete set null,
  -- Discord identifiers — let staff jump back to the thread for context
  discord_channel_id text,
  discord_message_id text,
  discord_thread_id text,
  -- The flagged author's Discord ID + display name at flag time. We may
  -- not have a SparkLine Youth account for them, hence text not FK.
  flagged_discord_user_id text,
  flagged_display_name text,
  content text,
  status text not null default 'open'
    check (status in ('open','triaged','resolved')),
  notes text,
  resolved_by uuid references public.profiles(id) on delete set null,
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists team_blockers_status_idx
  on public.team_blockers (status, created_at desc);

drop trigger if exists touch_team_blockers on public.team_blockers;
create trigger touch_team_blockers before update on public.team_blockers
  for each row execute procedure public.touch_updated_at();

alter table public.team_blockers enable row level security;

drop policy if exists "team_blockers staff all" on public.team_blockers;
create policy "team_blockers staff all" on public.team_blockers
  for all using (public.is_staff(auth.uid()))
  with check (public.is_staff(auth.uid()));

-- ----------------------------------------------------------------------------
-- profiles: onboarding progress flags. Three steps in the Discord
-- onboarding wizard: linked (already implicit from discord_linked_at),
-- said hi in #introductions, attended first event. Stored as nullable
-- timestamps so we can tell "done" from "skipped" and compute time-to-X.
-- ----------------------------------------------------------------------------
alter table public.profiles
  add column if not exists discord_introduced_at timestamptz,
  add column if not exists discord_first_rsvp_at timestamptz,
  add column if not exists discord_onboarded_nudged_at timestamptz;

-- ----------------------------------------------------------------------------
-- New site_settings keys for channel IDs we don't already track. Seed
-- empty values so the admin UI has rows to write to.
-- ----------------------------------------------------------------------------
insert into public.site_settings (key, value)
values
  ('discord_channel_teams_category_id', '""'::jsonb),
  ('discord_channel_wins_id',           '""'::jsonb),
  ('discord_channel_help_id',           '""'::jsonb),
  ('discord_channel_oh_voice_id',       '""'::jsonb),
  ('discord_channel_introductions_id',  '""'::jsonb),
  ('discord_oncall_message_id',         '""'::jsonb)
on conflict (key) do nothing;

notify pgrst, 'reload schema';
