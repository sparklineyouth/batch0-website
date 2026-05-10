-- ============================================================================
-- 0004 — Professor course-edit access, assignments + submissions, and a
--         per-student "drive" (private file storage).
--
-- Run this in the Supabase SQL Editor. Idempotent / safe to re-run.
-- Assumes 0001..0003 are applied (uses public.is_admin / is_staff).
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Open course-content writes to professors as well as admins.
-- ----------------------------------------------------------------------------
drop policy if exists "modules admin write" on public.modules;
create policy "modules staff write" on public.modules
  for all using (public.is_staff(auth.uid())) with check (public.is_staff(auth.uid()));

drop policy if exists "lessons admin write" on public.lessons;
create policy "lessons staff write" on public.lessons
  for all using (public.is_staff(auth.uid())) with check (public.is_staff(auth.uid()));

-- Course videos + materials writes also open to professors.
drop policy if exists "course-videos admin write" on storage.objects;
create policy "course-videos staff write" on storage.objects
  for all to authenticated
  using (bucket_id = 'course-videos' and public.is_staff(auth.uid()))
  with check (bucket_id = 'course-videos' and public.is_staff(auth.uid()));

drop policy if exists "course-materials admin write" on storage.objects;
create policy "course-materials staff write" on storage.objects
  for all to authenticated
  using (bucket_id = 'course-materials' and public.is_staff(auth.uid()))
  with check (bucket_id = 'course-materials' and public.is_staff(auth.uid()));

-- ============================================================================
-- Assignments: a piece of homework attached to a cohort (and optionally
-- to a specific lesson). Visible to enrolled students; writable by staff.
-- ============================================================================
create table if not exists public.assignments (
  id uuid primary key default gen_random_uuid(),
  cohort_id uuid not null references public.cohorts(id) on delete cascade,
  lesson_id uuid references public.lessons(id) on delete set null,
  title text not null,
  description text,
  due_at timestamptz,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists assignments_cohort_id_idx on public.assignments(cohort_id);
create index if not exists assignments_lesson_id_idx on public.assignments(lesson_id);

drop trigger if exists touch_assignments on public.assignments;
create trigger touch_assignments before update on public.assignments
  for each row execute procedure public.touch_updated_at();

alter table public.assignments enable row level security;

drop policy if exists "assignments read" on public.assignments;
create policy "assignments read" on public.assignments
  for select using (
    public.is_staff(auth.uid())
    or exists (
      select 1 from public.enrollments e
      where e.user_id = auth.uid() and e.cohort_id = assignments.cohort_id
    )
  );

drop policy if exists "assignments staff write" on public.assignments;
create policy "assignments staff write" on public.assignments
  for all using (public.is_staff(auth.uid())) with check (public.is_staff(auth.uid()));

-- ============================================================================
-- Submissions: one row per (assignment, student). Stored as text + jsonb
-- for links + jsonb for file references (paths in the 'submissions' bucket).
-- ============================================================================
create table if not exists public.assignment_submissions (
  id uuid primary key default gen_random_uuid(),
  assignment_id uuid not null references public.assignments(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  content text,
  links jsonb not null default '[]'::jsonb,        -- [{title, url}]
  files jsonb not null default '[]'::jsonb,        -- [{name, path}]
  status text not null default 'draft' check (status in ('draft','submitted','graded')),
  submitted_at timestamptz,
  grade text,
  feedback text,
  graded_by uuid references public.profiles(id) on delete set null,
  graded_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (assignment_id, user_id)
);

create index if not exists submissions_assignment_id_idx on public.assignment_submissions(assignment_id);
create index if not exists submissions_user_id_idx on public.assignment_submissions(user_id);

drop trigger if exists touch_submissions on public.assignment_submissions;
create trigger touch_submissions before update on public.assignment_submissions
  for each row execute procedure public.touch_updated_at();

alter table public.assignment_submissions enable row level security;

drop policy if exists "submissions own select" on public.assignment_submissions;
create policy "submissions own select" on public.assignment_submissions
  for select using (
    user_id = auth.uid() or public.is_staff(auth.uid())
  );

-- Students: insert + update their OWN submission while not yet graded.
drop policy if exists "submissions own insert" on public.assignment_submissions;
create policy "submissions own insert" on public.assignment_submissions
  for insert with check (user_id = auth.uid());

drop policy if exists "submissions own update" on public.assignment_submissions;
create policy "submissions own update" on public.assignment_submissions
  for update
  using (user_id = auth.uid() and status <> 'graded')
  with check (user_id = auth.uid() and status in ('draft','submitted'));

-- Staff: full access (grading flow uses service role anyway, but this
-- lets professors fall back to direct queries if needed).
drop policy if exists "submissions staff all" on public.assignment_submissions;
create policy "submissions staff all" on public.assignment_submissions
  for all using (public.is_staff(auth.uid())) with check (public.is_staff(auth.uid()));

-- ============================================================================
-- Student "drive": per-user metadata for files in the student-files bucket.
-- Each user folder = their user_id, scoped by RLS.
-- ============================================================================
create table if not exists public.student_files (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  name text not null,
  path text not null,
  size_bytes bigint,
  mime_type text,
  created_at timestamptz not null default now()
);

create index if not exists student_files_user_id_idx on public.student_files(user_id);

alter table public.student_files enable row level security;

drop policy if exists "student_files own select" on public.student_files;
create policy "student_files own select" on public.student_files
  for select using (user_id = auth.uid() or public.is_staff(auth.uid()));

drop policy if exists "student_files own insert" on public.student_files;
create policy "student_files own insert" on public.student_files
  for insert with check (user_id = auth.uid());

drop policy if exists "student_files own delete" on public.student_files;
create policy "student_files own delete" on public.student_files
  for delete using (user_id = auth.uid());

drop policy if exists "student_files own update" on public.student_files;
create policy "student_files own update" on public.student_files
  for update using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ============================================================================
-- Storage buckets for submissions + student files.
-- Private; reads happen through service-role-signed URLs from server actions.
-- ============================================================================
insert into storage.buckets (id, name, public)
values ('submissions', 'submissions', false)
on conflict (id) do nothing;

insert into storage.buckets (id, name, public)
values ('student-files', 'student-files', false)
on conflict (id) do nothing;

-- Submissions bucket: students write to their own folder; staff can write
-- (e.g. attaching graded files). Reads are signed-URL only.
drop policy if exists "submissions own write" on storage.objects;
create policy "submissions own write" on storage.objects
  for all to authenticated
  using (
    bucket_id = 'submissions' and (
      (storage.foldername(name))[1] = auth.uid()::text
      or public.is_staff(auth.uid())
    )
  )
  with check (
    bucket_id = 'submissions' and (
      (storage.foldername(name))[1] = auth.uid()::text
      or public.is_staff(auth.uid())
    )
  );

-- student-files bucket: students own their folder; staff read.
drop policy if exists "student-files own write" on storage.objects;
create policy "student-files own write" on storage.objects
  for all to authenticated
  using (
    bucket_id = 'student-files' and (
      (storage.foldername(name))[1] = auth.uid()::text
      or public.is_staff(auth.uid())
    )
  )
  with check (
    bucket_id = 'student-files' and (
      (storage.foldername(name))[1] = auth.uid()::text
      or public.is_staff(auth.uid())
    )
  );

notify pgrst, 'reload schema';
