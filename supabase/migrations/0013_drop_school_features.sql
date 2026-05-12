-- ============================================================================
-- 0013 — Drop school-style features.
--
-- SparkLine is a startup accelerator, not a school. We're dropping
-- assignments, submissions, quizzes, and the "submissions" storage
-- bucket. Mentor feedback now lives on team threads (Phase 2) and
-- check-in feedback (0010). Student / team work lives in their team
-- drive (Phase 2) or personal file drive (0004).
--
-- Run in Supabase SQL Editor. Destructive — drops tables and a bucket.
-- Idempotent. Assumes 0001..0012 applied.
-- ============================================================================

-- Drop the quiz and assignment tables. Cascade clears dependent rows
-- (quiz_attempts referencing quizzes; assignment_submissions referencing
-- assignments). The `mentor_assignments` table is UNRELATED — it's the
-- mentor↔student pairing table from 0005 and stays.
drop table if exists public.quiz_attempts cascade;
drop table if exists public.quiz_questions cascade;
drop table if exists public.quizzes cascade;
drop table if exists public.assignment_submissions cascade;
drop table if exists public.assignments cascade;

-- The "submissions" storage bucket previously held uploads attached to
-- assignment_submissions. Nothing references it anymore. Supabase blocks
-- direct DML on storage.objects/buckets from SQL migrations (permission
-- denied) — empty + delete the bucket from the Storage CLI/Dashboard
-- after this migration runs, e.g.:
--   supabase storage rm ss:///submissions --recursive --linked
--   (then delete the bucket from Dashboard → Storage)
-- The app no longer reads or writes this bucket, so leaving it in place
-- is harmless.

-- Notification cleanup: drop old assignment_due_soon + assignment_graded
-- + quiz_* notifications so the bell doesn't show stale rows.
delete from public.notifications
where type in (
  'assignment_due_soon',
  'assignment_graded',
  'quiz_submitted'
);

notify pgrst, 'reload schema';
