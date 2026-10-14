# Assignments

Replaced weekly check-ins (migration `0093_assignments.sql`).

## Where

| Who | Page | Does |
| --- | --- | --- |
| Admin (`assignments.manage`) | `/admin/assignments` | Create/edit, repeat weekly, pick students, completion matrix (Missing 2+ filter), review drawer (feedback, return, excuse), CSV |
| Mentor (`mentor.panel`) | `/mentor/assignments` | Review queue for their cohorts/students (`lib/mentor-scope.ts`) |
| Student | `/dashboard/assignments`, `/app/assignments` | Due soon / Upcoming / Done; submit text and/or an https link; edit until reviewed |
| Student | lesson page | "Assignment: …" for assignments anchored to that lesson |
| Admin overview | `/admin`, `/app/admin` | "Overdue assignments" count |

Old routes redirect (next.config.js): `/dashboard/checkin`, `/mentor/checkins`, `/app/checkin`, and the retired monitors `/admin/pulse` → `/admin`, `/admin/interventions` → the Missing 2+ filter, `/admin/cohorts/:id/health` → that cohort's matrix.

## When things open

All times are America/New_York (`lib/assignments.ts`).

- **Now** — visible on save.
- **On a date** — hidden until then.
- **With a course week** — week N opens Monday 00:00 of that week (cohort `starts_on` + 7·(N−1)), due Sunday 23:59 by default, never after the cohort's last day (a cohort ending Friday has its last week due Friday). Dates are stored and recomputed when the cohort's dates or a lesson's module week change (`recomputeCourseWeekDates`); rows with work already handed in keep theirs. Editing an assignment's deadline re-stamps its submissions' late flags.
- **Repeat weekly** — one save creates weeks k..W as a series; editing one row can apply to later weeks.

Status is derived, not stored: Open, Due today, Late/Missing, Submitted (late), Needs changes, Reviewed, Excused. A student who enrolled after a due date is excused from it unless they hand it in.

## Notifications

Hourly cron `/api/cron/assignment-reminders` (Bearer `CRON_SECRET`):
release bell when a scheduled assignment opens; bell + email (`assignment.due_soon`, editable at /admin/email/templates after "Seed system templates") 24h before the deadline to students who haven't handed in. Both deduped per student per assignment. Reviews notify the student; new submissions notify the student's directly assigned mentors.

## Data

`course_assignments`, `course_assignment_targets`, `course_assignment_submissions`. Read-only RLS; every write is a service-role server action. `student_checkins` / `checkin_feedback` are kept read-only for the record.

0093 seeds the running Fall cohort with a "Weekly update" series (weeks 5–9) and the Demo Day submission. Check-ins posted for one of those weeks before the switch become that week's submission (a mentor reply becomes its review).

Before 0093 is applied every page shows an empty state and the cron is a no-op.

Tests: `lib/assignments.test.ts` (dates, DST, status), `lib/assignments-migration-db.test.ts` (RLS in PGlite).
