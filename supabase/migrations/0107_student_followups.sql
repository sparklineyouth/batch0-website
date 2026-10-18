-- ============================================================================
-- 0107 — Student follow-ups: who on the team is checking on a student, when.
--
-- One table, written from the follow-up drawer on /admin/progress through
-- service-role server actions (app/admin/progress/actions.ts, people.manage)
-- and read by the same page and the admin Overview's attention list. Nobody
-- signed in reads or writes it through the API: RLS is on with no policies,
-- and every table privilege the API roles get by default is revoked.
--
-- What a row is, and isn't. A member of staff wrote down that they own a
-- check on this student, the date they'll look again and a factual note
-- ("No weekly update for weeks 3–4; emailed Tuesday"). Nothing creates one
-- automatically — not inactivity, not a missed deadline — and nothing here
-- sends the student, the owner or anyone else a message. It is a marker so
-- two people don't chase the same student, not a judgement about them.
--
-- At most one OPEN follow-up per student (a partial unique index): the second
-- person to try is told who already has it. Closed ones stay as the history
-- the drawer shows. Deleting the student's account deletes their follow-ups;
-- deleting a staff account leaves the follow-up without an owner, so the
-- attention list says "No owner" instead of losing the row.
--
-- Run in Supabase SQL Editor. Idempotent / safe to re-run. Assumes 0001 (the
-- profiles table and touch_updated_at()). Changes no existing data.
-- ============================================================================

create table if not exists public.student_followups (
  id uuid primary key default gen_random_uuid(),
  student_id uuid not null references public.profiles(id) on delete cascade,
  owner_id uuid references public.profiles(id) on delete set null,
  -- A New York calendar date, like every other program date.
  next_check_on date not null,
  note text not null check (char_length(btrim(note)) between 1 and 1000),
  status text not null default 'open' check (status in ('open', 'closed')),
  closing_note text check (closing_note is null or char_length(closing_note) <= 1000),
  created_by uuid references public.profiles(id) on delete set null,
  updated_by uuid references public.profiles(id) on delete set null,
  closed_by uuid references public.profiles(id) on delete set null,
  closed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint student_followups_closed check ((status = 'closed') = (closed_at is not null))
);

-- The rule the drawer relies on: one open follow-up per student.
create unique index if not exists student_followups_one_open_idx
  on public.student_followups (student_id) where status = 'open';
-- The attention list's read: open follow-ups due by today.
create index if not exists student_followups_due_idx
  on public.student_followups (next_check_on) where status = 'open';
-- The drawer's history.
create index if not exists student_followups_student_idx
  on public.student_followups (student_id, created_at desc);
create index if not exists student_followups_owner_idx
  on public.student_followups (owner_id) where owner_id is not null;

-- updated_at is also the drawer's edit token: a save names the version it
-- started from, so one person's edit never silently replaces another's.
drop trigger if exists touch_student_followups on public.student_followups;
create trigger touch_student_followups before update on public.student_followups
  for each row execute procedure public.touch_updated_at();

alter table public.student_followups enable row level security;

-- Supabase grants every new table to the API roles by default. With RLS on
-- and no policy that would already read as nothing, but a note about a
-- student has no business being one forgotten policy away from the browser.
revoke all on public.student_followups from anon, authenticated;
