# Assignments

Replaced weekly check-ins (migration `0093_assignments.sql`).

## Where

| Who | Page | Does |
| --- | --- | --- |
| Admin (`assignments.manage`) | `/admin/assignments` | Create/edit, repeat weekly, pick students, completion matrix (Missing 2+ filter), review drawer (feedback, return, excuse), CSV |
| Mentor (`mentor.panel`) | `/mentor/assignments` | Review queue for their cohorts/students (`lib/mentor-scope.ts`) |
| Student | `/dashboard/assignments`, `/app/assignments` | Due soon / Upcoming / Done; submit text and/or an https link; edit until reviewed; unsubmitted work autosaves as a private draft |
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
release bell when a scheduled assignment opens; bell + email (`assignment.due_soon`, editable at /admin/email/templates after "Add built-in templates") 24h before the deadline to students who haven't handed in. Both deduped per student per assignment. Reviews notify the student; new submissions notify the student's directly assigned mentors.

## Drafts

What a student types autosaves as a private draft (`course_assignment_drafts`, migration `0105_assignment_drafts.sql`): two seconds after typing pauses (at least every ten seconds while it doesn't), and when the tab is hidden or closed. Reloading, or opening the assignment on another device, restores it. Submit is still the only way to hand work in.

- **Never a submission.** Its own table, so the matrix, review queue, overdue count and reminders can't see it. The read policy is the owner's alone — no mentor or admin clause. Submitting copies the text into `course_assignment_submissions` and clears the draft (only up to the version that tab last saved; a newer one from another tab is left alone).
- **Which text the form opens with.** A draft saved after the last submit wins (unsubmitted edits, or never handed in) and the form says so; one saved before it was overtaken by that submit, so the submission shows (`startingWork`, `lib/assignment-drafts.ts`).
- **Versions.** Every save names the draft version it was typed on. A tab holding an older one is refused (`stale`), stops autosaving and says to reload; Submit from that tab asks first.
- **Access.** `save_course_assignment_draft()` (service role only, called by `saveAssignmentDraft`) re-checks on every save what Submit checks: published and open, enrolled (and targeted), cohort started, not reviewed or excused. Losing any of them stops the saves.
- **Honest status.** The line under the answer box says saving / saved / couldn't save, retrying / stopped and why. Closing the tab while saves are failing asks first.
- **Before 0105 runs** the page reads the missing table as "not set up yet" and the form works exactly as before, without autosave.

## Data

`course_assignments`, `course_assignment_targets`, `course_assignment_submissions`. Read-only RLS; every write is a service-role server action. `student_checkins` / `checkin_feedback` are kept read-only for the record, and shown that way: "Earlier check-ins", collapsed, with the feedback on each, on the student's `/dashboard/assignments`, the mentor's `/mentor/students/[id]` and the admin's `/admin/students/[id]` (`lib/checkin-history-server.ts`; absent for anyone who never posted one).

0093 seeds the running Fall cohort with a "Weekly update" series (weeks 5–9) and the Demo Day submission. Check-ins posted for one of those weeks before the switch become that week's submission (a mentor reply becomes its review).

Before 0093 is applied every page shows an empty state and the cron is a no-op.

Tests: `lib/assignments.test.ts` (dates, DST, status), `lib/assignments-migration-db.test.ts` (RLS in PGlite), `lib/assignment-drafts.test.ts` and `lib/assignment-drafts-migration-db.test.ts` (drafts: restore, stale tabs, access, privacy).
