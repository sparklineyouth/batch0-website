-- ============================================================================
-- 0049 — Kickoff becomes admin-editable content.
--
-- /dashboard/kickoff was 100% hardcoded copy. There was no way for an admin to
-- say when the call starts, where it happens, or what the agenda is — the page
-- could only ever show the cohort's start DATE, and said "Date coming soon"
-- when even that was missing.
--
-- This gives each cohort its own kickoff page. Every column is nullable and
-- the page falls back to a complete default when it's null (see lib/kickoff.ts),
-- so a cohort nobody has touched still renders a real page rather than a blank
-- one, and clearing a field is how an admin resets it.
--
-- WHY A TABLE, NOT kickoff_* COLUMNS ON `cohorts`:
-- `cohorts read` (0001) is `auth.role() = 'authenticated'` — every signed-in
-- account can read every column of every cohort. That's right for the landing_*
-- marketing copy added in 0032, and wrong for a kickoff join link, which is a
-- private call URL that anyone who created an account could otherwise lift.
-- So kickoff content lives in its own table, gated to enrolled students and
-- staff, matching how resources / flows / receipts were gated in 0046.
--
-- Run in Supabase SQL Editor. Idempotent / safe to re-run.
-- Assumes 0001..0048 applied.
-- ============================================================================

create table if not exists public.cohort_kickoff (
  cohort_id uuid primary key references public.cohorts(id) on delete cascade,

  -- Overrides the big heading. Null → the formatted start date.
  headline text,
  -- The paragraph under the heading.
  intro text,
  -- "6:00 PM ET" — free text on purpose. Kickoff time is announced in words,
  -- not scheduled by the app, and a timestamptz would imply a precision (and a
  -- timezone conversion) the program does not actually have.
  time_label text,
  -- "Zoom" / "Discord Stage" / "Room 204".
  location_label text,
  -- The actual join link. THE reason this table exists — see the note above.
  join_url text,
  -- [{ "title": "...", "body": "..." }] — what unlocks / happens on the day.
  agenda jsonb,
  -- [{ "label": "...", "href": "/dashboard/..." }] — the before-kickoff list.
  checklist jsonb,
  -- The "Head start" note in the sidebar card.
  note text,

  updated_at timestamptz not null default now(),

  -- Both jsonb columns are read as arrays by the app. A scalar or an object
  -- here would render as nothing at all, which is exactly the silent
  -- empty-page failure this migration exists to remove — reject it at the door.
  constraint cohort_kickoff_agenda_is_array
    check (agenda is null or jsonb_typeof(agenda) = 'array'),
  constraint cohort_kickoff_checklist_is_array
    check (checklist is null or jsonb_typeof(checklist) = 'array')
);

comment on table public.cohort_kickoff is
  'Admin-editable content for /dashboard/kickoff, one row per cohort. Every column nullable; null means "use the built-in default" (lib/kickoff.ts).';

alter table public.cohort_kickoff enable row level security;

-- Read: staff always; students must be enrolled in that cohort. Same shape as
-- the "resources read" policy in 0046 — an accepted-but-unpaid applicant gets
-- nothing, and neither does a signed-in stranger.
drop policy if exists "cohort kickoff read" on public.cohort_kickoff;
create policy "cohort kickoff read" on public.cohort_kickoff
  for select using (
    public.is_staff(auth.uid())
    or exists (
      select 1 from public.enrollments e
      where e.user_id = auth.uid()
        and e.cohort_id = cohort_kickoff.cohort_id
    )
  );

-- Write: admins only. The editor at /admin/cohorts/[id]/kickoff goes through
-- the service-role client behind assertPermission('cohorts.manage'), so this
-- policy is the backstop for anything holding a user token.
drop policy if exists "cohort kickoff admin write" on public.cohort_kickoff;
create policy "cohort kickoff admin write" on public.cohort_kickoff
  for all using (public.is_admin(auth.uid()))
  with check (public.is_admin(auth.uid()));

notify pgrst, 'reload schema';
