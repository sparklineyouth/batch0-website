-- ============================================================================
-- 0011 — Phase 2 features:
--   - Team system upgrades: invites, drive files, message thread, logo
--     moderation, creator_id.
--   - Demo Day: pitch_submissions, pitch_scores.
--   - Investor warm-intros: intro_requests.
--   - Mentor office hours: mentor_slots, mentor_bookings.
--   - Completion certificates: certificates.
--   - AI application screener: applications.ai_* columns.
--   - MFA step-up tracking: mfa_verifications.
--
-- Run in Supabase SQL Editor. Idempotent / safe to re-run.
-- Assumes 0001..0010 applied.
-- ============================================================================

-- ============================================================================
-- TEAM SYSTEM UPGRADES
-- ============================================================================

-- Track who originally created the team (the founding member; useful for
-- "team owner" defaults). Backfill from team_members where possible.
alter table public.teams
  add column if not exists creator_id uuid references public.profiles(id) on delete set null;

-- Logo moderation: a student-uploaded logo starts as 'pending' and is only
-- shown publicly once an admin marks it 'approved'. 'rejected' surfaces a
-- reason so the team can re-upload.
alter table public.teams
  add column if not exists logo_status text not null default 'approved'
    check (logo_status in ('pending', 'approved', 'rejected'));
alter table public.teams
  add column if not exists logo_rejected_reason text;

-- ----------------------------------------------------------------------------
-- team_invites: a team member invites another student by user_id. The
-- invitee accepts/declines; on accept they get a team_members row.
-- ----------------------------------------------------------------------------
create table if not exists public.team_invites (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references public.teams(id) on delete cascade,
  invitee_id uuid not null references public.profiles(id) on delete cascade,
  invited_by uuid not null references public.profiles(id) on delete cascade,
  status text not null default 'pending'
    check (status in ('pending', 'accepted', 'declined', 'cancelled')),
  message text,
  created_at timestamptz not null default now(),
  responded_at timestamptz,
  unique (team_id, invitee_id)
);

create index if not exists team_invites_invitee_idx
  on public.team_invites (invitee_id, status, created_at desc);
create index if not exists team_invites_team_idx
  on public.team_invites (team_id, status, created_at desc);

alter table public.team_invites enable row level security;

drop policy if exists "team_invites read" on public.team_invites;
create policy "team_invites read" on public.team_invites
  for select using (
    public.is_staff(auth.uid())
    or invitee_id = auth.uid()
    or invited_by = auth.uid()
    or exists (
      select 1 from public.team_members tm
      where tm.team_id = team_invites.team_id and tm.user_id = auth.uid()
    )
  );

-- Members can create invites for their team; admins always.
drop policy if exists "team_invites member write" on public.team_invites;
create policy "team_invites member write" on public.team_invites
  for insert with check (
    public.is_admin(auth.uid())
    or exists (
      select 1 from public.team_members tm
      where tm.team_id = team_invites.team_id and tm.user_id = auth.uid()
    )
  );

-- Update is allowed for the invitee (accept/decline), the inviter (cancel),
-- or an admin.
drop policy if exists "team_invites update" on public.team_invites;
create policy "team_invites update" on public.team_invites
  for update using (
    public.is_admin(auth.uid())
    or invitee_id = auth.uid()
    or invited_by = auth.uid()
  ) with check (
    public.is_admin(auth.uid())
    or invitee_id = auth.uid()
    or invited_by = auth.uid()
  );

-- ----------------------------------------------------------------------------
-- team_drive_files: a team's shared file store. Files live in the
-- `team-drive` storage bucket keyed by team_id/uuid.
-- ----------------------------------------------------------------------------
create table if not exists public.team_drive_files (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references public.teams(id) on delete cascade,
  uploader_id uuid references public.profiles(id) on delete set null,
  name text not null,
  path text not null,
  size_bytes bigint,
  mime_type text,
  created_at timestamptz not null default now()
);

create index if not exists team_drive_files_team_idx
  on public.team_drive_files (team_id, created_at desc);

alter table public.team_drive_files enable row level security;

-- Read: team members + staff + investors (so investors can see decks/etc.
-- when assessing). If you want investor isolation, scope tighter later.
drop policy if exists "team_drive_files read" on public.team_drive_files;
create policy "team_drive_files read" on public.team_drive_files
  for select using (
    public.is_staff(auth.uid())
    or public.is_investor(auth.uid())
    or exists (
      select 1 from public.team_members tm
      where tm.team_id = team_drive_files.team_id and tm.user_id = auth.uid()
    )
  );

drop policy if exists "team_drive_files member write" on public.team_drive_files;
create policy "team_drive_files member write" on public.team_drive_files
  for all using (
    public.is_admin(auth.uid())
    or exists (
      select 1 from public.team_members tm
      where tm.team_id = team_drive_files.team_id and tm.user_id = auth.uid()
    )
  ) with check (
    public.is_admin(auth.uid())
    or exists (
      select 1 from public.team_members tm
      where tm.team_id = team_drive_files.team_id and tm.user_id = auth.uid()
    )
  );

-- ----------------------------------------------------------------------------
-- team_messages: one shared thread per team. Members post; mentors and
-- investors can post (mentor feedback, investor questions). Visible to
-- all three plus admins.
-- ----------------------------------------------------------------------------
create table if not exists public.team_messages (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references public.teams(id) on delete cascade,
  author_id uuid not null references public.profiles(id) on delete cascade,
  body text not null,
  -- "kind" hints which audience this is from so the UI can color-code.
  -- Members see all kinds.
  kind text not null default 'member'
    check (kind in ('member', 'mentor', 'investor', 'admin')),
  created_at timestamptz not null default now()
);

create index if not exists team_messages_team_idx
  on public.team_messages (team_id, created_at desc);

alter table public.team_messages enable row level security;

drop policy if exists "team_messages read" on public.team_messages;
create policy "team_messages read" on public.team_messages
  for select using (
    public.is_staff(auth.uid())
    or public.is_investor(auth.uid())
    or exists (
      select 1 from public.team_members tm
      where tm.team_id = team_messages.team_id and tm.user_id = auth.uid()
    )
  );

drop policy if exists "team_messages write" on public.team_messages;
create policy "team_messages write" on public.team_messages
  for insert with check (
    author_id = auth.uid() and (
      public.is_staff(auth.uid())
      or public.is_investor(auth.uid())
      or exists (
        select 1 from public.team_members tm
        where tm.team_id = team_messages.team_id and tm.user_id = auth.uid()
      )
    )
  );

-- ============================================================================
-- DEMO DAY
-- ============================================================================

-- ----------------------------------------------------------------------------
-- pitch_submissions: one per team per cohort. Deck + video upload (storage
-- bucket "team-drive") plus an optional external video URL.
-- ----------------------------------------------------------------------------
create table if not exists public.pitch_submissions (
  team_id uuid primary key references public.teams(id) on delete cascade,
  cohort_id uuid references public.cohorts(id) on delete set null,
  deck_path text,
  video_path text,
  video_url text,
  notes text,
  submitted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists touch_pitch_submissions on public.pitch_submissions;
create trigger touch_pitch_submissions before update on public.pitch_submissions
  for each row execute procedure public.touch_updated_at();

alter table public.pitch_submissions enable row level security;

drop policy if exists "pitch_submissions read" on public.pitch_submissions;
create policy "pitch_submissions read" on public.pitch_submissions
  for select using (
    public.is_staff(auth.uid())
    or public.is_investor(auth.uid())
    or exists (
      select 1 from public.team_members tm
      where tm.team_id = pitch_submissions.team_id and tm.user_id = auth.uid()
    )
  );

drop policy if exists "pitch_submissions member write" on public.pitch_submissions;
create policy "pitch_submissions member write" on public.pitch_submissions
  for all using (
    public.is_admin(auth.uid())
    or exists (
      select 1 from public.team_members tm
      where tm.team_id = pitch_submissions.team_id and tm.user_id = auth.uid()
    )
  ) with check (
    public.is_admin(auth.uid())
    or exists (
      select 1 from public.team_members tm
      where tm.team_id = pitch_submissions.team_id and tm.user_id = auth.uid()
    )
  );

-- ----------------------------------------------------------------------------
-- pitch_scores: one row per (team, scorer). Rubric scores 1..5.
-- ----------------------------------------------------------------------------
create table if not exists public.pitch_scores (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references public.teams(id) on delete cascade,
  scorer_id uuid not null references public.profiles(id) on delete cascade,
  problem int check (problem between 1 and 5),
  traction int check (traction between 1 and 5),
  team_score int check (team_score between 1 and 5),
  ask int check (ask between 1 and 5),
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (team_id, scorer_id)
);

create index if not exists pitch_scores_team_idx
  on public.pitch_scores (team_id);

drop trigger if exists touch_pitch_scores on public.pitch_scores;
create trigger touch_pitch_scores before update on public.pitch_scores
  for each row execute procedure public.touch_updated_at();

alter table public.pitch_scores enable row level security;

-- Investors + admins can write their own row. Everyone with access reads.
-- Team members can read their own team's aggregate too.
drop policy if exists "pitch_scores read" on public.pitch_scores;
create policy "pitch_scores read" on public.pitch_scores
  for select using (
    public.is_admin(auth.uid())
    or scorer_id = auth.uid()
    or exists (
      select 1 from public.team_members tm
      where tm.team_id = pitch_scores.team_id and tm.user_id = auth.uid()
    )
  );

drop policy if exists "pitch_scores write" on public.pitch_scores;
create policy "pitch_scores write" on public.pitch_scores
  for all using (
    scorer_id = auth.uid() and (
      public.is_admin(auth.uid()) or public.is_investor(auth.uid())
    )
  ) with check (
    scorer_id = auth.uid() and (
      public.is_admin(auth.uid()) or public.is_investor(auth.uid())
    )
  );

-- ============================================================================
-- WARM INTROS
-- ============================================================================

create table if not exists public.intro_requests (
  id uuid primary key default gen_random_uuid(),
  investor_id uuid not null references public.profiles(id) on delete cascade,
  team_id uuid not null references public.teams(id) on delete cascade,
  status text not null default 'requested'
    check (status in (
      'requested', 'intro_made', 'meeting_held',
      'committed', 'wired', 'passed'
    )),
  message text,
  admin_notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (investor_id, team_id)
);

create index if not exists intro_requests_team_idx
  on public.intro_requests (team_id, status);
create index if not exists intro_requests_investor_idx
  on public.intro_requests (investor_id, status, created_at desc);

drop trigger if exists touch_intro_requests on public.intro_requests;
create trigger touch_intro_requests before update on public.intro_requests
  for each row execute procedure public.touch_updated_at();

alter table public.intro_requests enable row level security;

drop policy if exists "intro_requests read" on public.intro_requests;
create policy "intro_requests read" on public.intro_requests
  for select using (
    public.is_admin(auth.uid())
    or investor_id = auth.uid()
  );

drop policy if exists "intro_requests investor write" on public.intro_requests;
create policy "intro_requests investor write" on public.intro_requests
  for insert with check (
    investor_id = auth.uid() and public.is_investor(auth.uid())
  );

drop policy if exists "intro_requests update" on public.intro_requests;
create policy "intro_requests update" on public.intro_requests
  for update using (
    public.is_admin(auth.uid()) or investor_id = auth.uid()
  ) with check (
    public.is_admin(auth.uid()) or investor_id = auth.uid()
  );

-- ============================================================================
-- OFFICE HOURS (mentor slots + bookings)
-- ============================================================================

create table if not exists public.mentor_slots (
  id uuid primary key default gen_random_uuid(),
  mentor_id uuid not null references public.profiles(id) on delete cascade,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  zoom_url text,
  notes text,
  created_at timestamptz not null default now(),
  check (ends_at > starts_at)
);

create index if not exists mentor_slots_mentor_idx
  on public.mentor_slots (mentor_id, starts_at);
create index if not exists mentor_slots_starts_idx
  on public.mentor_slots (starts_at);

alter table public.mentor_slots enable row level security;

-- All students (any signed-in user with a profile) can see available slots.
drop policy if exists "mentor_slots read" on public.mentor_slots;
create policy "mentor_slots read" on public.mentor_slots
  for select using (auth.uid() is not null);

drop policy if exists "mentor_slots mentor write" on public.mentor_slots;
create policy "mentor_slots mentor write" on public.mentor_slots
  for all using (
    mentor_id = auth.uid() and (
      public.is_admin(auth.uid()) or public.is_mentor(auth.uid())
    )
  ) with check (
    mentor_id = auth.uid() and (
      public.is_admin(auth.uid()) or public.is_mentor(auth.uid())
    )
  );

drop policy if exists "mentor_slots admin write" on public.mentor_slots;
create policy "mentor_slots admin write" on public.mentor_slots
  for all using (public.is_admin(auth.uid()))
  with check (public.is_admin(auth.uid()));

create table if not exists public.mentor_bookings (
  id uuid primary key default gen_random_uuid(),
  slot_id uuid not null unique references public.mentor_slots(id) on delete cascade,
  student_id uuid not null references public.profiles(id) on delete cascade,
  topic text,
  status text not null default 'booked'
    check (status in ('booked', 'cancelled', 'completed')),
  created_at timestamptz not null default now()
);

create index if not exists mentor_bookings_student_idx
  on public.mentor_bookings (student_id, created_at desc);

alter table public.mentor_bookings enable row level security;

drop policy if exists "mentor_bookings read" on public.mentor_bookings;
create policy "mentor_bookings read" on public.mentor_bookings
  for select using (
    public.is_admin(auth.uid())
    or student_id = auth.uid()
    or exists (
      select 1 from public.mentor_slots s
      where s.id = mentor_bookings.slot_id and s.mentor_id = auth.uid()
    )
  );

-- Students claim a slot; cancel rights flow to admin + the booker + the
-- owning mentor.
drop policy if exists "mentor_bookings student write" on public.mentor_bookings;
create policy "mentor_bookings student write" on public.mentor_bookings
  for insert with check (
    student_id = auth.uid()
  );

drop policy if exists "mentor_bookings update" on public.mentor_bookings;
create policy "mentor_bookings update" on public.mentor_bookings
  for update using (
    public.is_admin(auth.uid())
    or student_id = auth.uid()
    or exists (
      select 1 from public.mentor_slots s
      where s.id = mentor_bookings.slot_id and s.mentor_id = auth.uid()
    )
  ) with check (
    public.is_admin(auth.uid())
    or student_id = auth.uid()
    or exists (
      select 1 from public.mentor_slots s
      where s.id = mentor_bookings.slot_id and s.mentor_id = auth.uid()
    )
  );

-- ============================================================================
-- COMPLETION CERTIFICATES
-- ============================================================================

create table if not exists public.certificates (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  cohort_id uuid not null references public.cohorts(id) on delete cascade,
  code text not null unique,
  issued_at timestamptz not null default now(),
  unique (user_id, cohort_id)
);

create index if not exists certificates_user_idx
  on public.certificates (user_id);

alter table public.certificates enable row level security;

-- Public can read certificates (so /verify/[code] works) — they only
-- expose name + cohort, not anything sensitive. Server-side joins
-- decide what to render.
drop policy if exists "certificates public read" on public.certificates;
create policy "certificates public read" on public.certificates
  for select using (true);

drop policy if exists "certificates admin write" on public.certificates;
create policy "certificates admin write" on public.certificates
  for all using (public.is_admin(auth.uid()))
  with check (public.is_admin(auth.uid()));

-- ============================================================================
-- AI APPLICATION SCREENING
-- ============================================================================

alter table public.applications
  add column if not exists ai_score int,
  add column if not exists ai_summary text,
  add column if not exists ai_reviewed_at timestamptz;

-- ============================================================================
-- MFA STEP-UP TRACKING
-- ============================================================================

-- Records when an admin/staff user has recently re-verified their MFA. The
-- app layer reads the most recent row per user and enforces a TTL.
create table if not exists public.mfa_verifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  verified_at timestamptz not null default now(),
  action text
);

create index if not exists mfa_verifications_user_idx
  on public.mfa_verifications (user_id, verified_at desc);

alter table public.mfa_verifications enable row level security;

drop policy if exists "mfa_verifications self read" on public.mfa_verifications;
create policy "mfa_verifications self read" on public.mfa_verifications
  for select using (user_id = auth.uid() or public.is_admin(auth.uid()));

drop policy if exists "mfa_verifications self insert" on public.mfa_verifications;
create policy "mfa_verifications self insert" on public.mfa_verifications
  for insert with check (user_id = auth.uid());

-- ============================================================================
-- STORAGE BUCKET: team-drive
-- ============================================================================
-- Keyed by team_id/<uuid>-<filename>. Private; clients fetch via signed
-- URLs minted server-side.

insert into storage.buckets (id, name, public)
values ('team-drive', 'team-drive', false)
on conflict (id) do nothing;

drop policy if exists "team-drive read" on storage.objects;
create policy "team-drive read" on storage.objects
  for select using (
    bucket_id = 'team-drive' and (
      public.is_staff(auth.uid())
      or public.is_investor(auth.uid())
      or exists (
        select 1
        from public.team_members tm
        where tm.user_id = auth.uid()
          -- storage path is "<team_id>/..."; first path segment is team id
          and tm.team_id::text = split_part(storage.objects.name, '/', 1)
      )
    )
  );

drop policy if exists "team-drive write" on storage.objects;
create policy "team-drive write" on storage.objects
  for all using (
    bucket_id = 'team-drive' and (
      public.is_admin(auth.uid())
      or exists (
        select 1
        from public.team_members tm
        where tm.user_id = auth.uid()
          and tm.team_id::text = split_part(storage.objects.name, '/', 1)
      )
    )
  ) with check (
    bucket_id = 'team-drive' and (
      public.is_admin(auth.uid())
      or exists (
        select 1
        from public.team_members tm
        where tm.user_id = auth.uid()
          and tm.team_id::text = split_part(storage.objects.name, '/', 1)
      )
    )
  );

-- ============================================================================
-- STORAGE BUCKET: team-logos
-- ============================================================================
-- Public-read so logos can render on team showcase pages, but writes are
-- restricted to team members (who upload to <team_id>/...). Admins moderate
-- via teams.logo_status.

insert into storage.buckets (id, name, public)
values ('team-logos', 'team-logos', true)
on conflict (id) do nothing;

drop policy if exists "team-logos read" on storage.objects;
create policy "team-logos read" on storage.objects
  for select using (bucket_id = 'team-logos');

drop policy if exists "team-logos write" on storage.objects;
create policy "team-logos write" on storage.objects
  for all using (
    bucket_id = 'team-logos' and (
      public.is_admin(auth.uid())
      or exists (
        select 1
        from public.team_members tm
        where tm.user_id = auth.uid()
          and tm.team_id::text = split_part(storage.objects.name, '/', 1)
      )
    )
  ) with check (
    bucket_id = 'team-logos' and (
      public.is_admin(auth.uid())
      or exists (
        select 1
        from public.team_members tm
        where tm.user_id = auth.uid()
          and tm.team_id::text = split_part(storage.objects.name, '/', 1)
      )
    )
  );

notify pgrst, 'reload schema';
