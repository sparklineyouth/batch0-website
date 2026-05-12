-- ============================================================================
-- 0014 — File feedback.
--
-- Mentors can leave threaded feedback on a student's personal files
-- (the /dashboard/files drive) or a team's drive files. Replaces the
-- old assignment-grading flow now that the app isn't school-shaped.
--
-- Run in Supabase SQL Editor. Idempotent / safe to re-run.
-- Assumes 0001..0013 applied.
-- ============================================================================

create table if not exists public.file_feedback (
  id uuid primary key default gen_random_uuid(),
  -- Exactly one of (student_file_id, team_file_id) is set.
  student_file_id uuid references public.student_files(id) on delete cascade,
  team_file_id uuid references public.team_drive_files(id) on delete cascade,
  author_id uuid not null references public.profiles(id) on delete cascade,
  body text not null,
  created_at timestamptz not null default now(),
  check (
    (student_file_id is not null)::int + (team_file_id is not null)::int = 1
  )
);

create index if not exists file_feedback_student_idx
  on public.file_feedback (student_file_id, created_at desc)
  where student_file_id is not null;
create index if not exists file_feedback_team_idx
  on public.file_feedback (team_file_id, created_at desc)
  where team_file_id is not null;

alter table public.file_feedback enable row level security;

-- Read: file owner + staff + (for team files) team members + investors.
drop policy if exists "file_feedback read" on public.file_feedback;
create policy "file_feedback read" on public.file_feedback
  for select using (
    public.is_staff(auth.uid())
    or (
      student_file_id is not null and exists (
        select 1 from public.student_files f
        where f.id = file_feedback.student_file_id
          and f.user_id = auth.uid()
      )
    )
    or (
      team_file_id is not null and (
        public.is_investor(auth.uid())
        or exists (
          select 1
          from public.team_drive_files tf
          join public.team_members tm
            on tm.team_id = tf.team_id
          where tf.id = file_feedback.team_file_id
            and tm.user_id = auth.uid()
        )
      )
    )
  );

-- Write: staff only (admin + mentor). Mentor cohort isolation is
-- enforced in the server action layer.
drop policy if exists "file_feedback staff write" on public.file_feedback;
create policy "file_feedback staff write" on public.file_feedback
  for all using (public.is_staff(auth.uid()))
  with check (public.is_staff(auth.uid()) and author_id = auth.uid());

notify pgrst, 'reload schema';
