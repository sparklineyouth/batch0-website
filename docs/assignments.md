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

What a student types autosaves as a private draft (`course_assignment_drafts`, migration `0105_assignment_drafts.sql`): two seconds after typing pauses (at least every ten seconds while it doesn't), and when the tab is hidden, closed or navigated away from. Reloading, pressing Back, or opening the assignment on another device restores it. Submit is still the only way to hand work in.

- **Never a submission.** Its own table, so the matrix, review queue, overdue count and reminders can't see it. The read policy is the owner's alone — no mentor or admin clause. Submitting copies the text into `course_assignment_submissions` and then empties the draft (`clear_course_assignment_draft()`), up to the newest version that submit accounted for; a draft saved after it in another tab is left alone.
- **Which text the form opens with.** A draft saved after the last submit wins (unsubmitted edits, or never handed in) and the form says so; one saved before it was overtaken by that submit, and an emptied one is no draft, so the submission shows (`startingWork`, `lib/assignment-drafts.ts`).
- **Versions.** Every save names the draft version it was typed on, and versions only go up: submitting empties the row rather than deleting it, so an old number can never match a newer draft. A tab holding an older version is refused (`stale`), stops autosaving and says to reload. Submit compares versions too: from a tab that's behind (newer text saved, or submitted, elsewhere) it hands in nothing and asks first (`submitConflict`); confirming hands this tab's text in.
- **Out-of-date pages and lost answers.** Back/Forward renders the page from the router cache, so the form re-reads the draft when it mounts and takes the newer text if nothing has been typed there yet. A "stale" answer is re-checked the same way before it stops anything: a save whose answer was lost on a dropped connection, retried, is recognised as the same text (in `save_course_assignment_draft()` and in `reconcileDraft`), and so is a submit whose answer was lost. A stale *submit* reads the draft back before asking anything: when the newer version is this tab's own save (it landed, its answer didn't), the form takes that version and sends the submit again, so "another tab or device" is only ever said about another tab or device. When the read-back itself fails, a save retries rather than stopping as stale, and a submit asks with wording that says it couldn't check (`staleVerdict`).
- **Text Postgres can store.** A NUL character (U+0000) can't go in a `text` column, and one pasted into an answer used to fail every save — retried forever — and Submit with it. It's dropped as it's typed and again in `checkDraft` and `validateSubmission` (`storableText`, `lib/assignments.ts`), so the tab and the server hold the same text.
- **Transport.** Saves go to `POST /api/assignments/<id>/draft` (and the re-read to `GET`), not a server action: a save sent as the page closes is a keepalive request the browser finishes afterwards (`lib/assignment-drafts-client.ts`), and since `/api` isn't behind middleware's sign-in redirect, a signed-out session is a 401 the form can name. Signed out means Auth rejected the session; Auth being unreachable is retried (`draftAuthor`, `lib/assignment-drafts-server.ts`).
- **Access.** `save_course_assignment_draft()` (service role only) re-checks on every save what Submit checks: published and open, enrolled (and targeted), cohort started, not reviewed or excused. Losing any of them stops the saves.
- **Honest status.** The line under the answer box says saving (including an edit still waiting for the typing pause) / saved / couldn't save, retrying / stopped and why. Leaving the page with unsaved text sends it on the way out; it asks first only when that can't be relied on (saves failing or stopped, a save still running, a submit on its way).
- **Before 0105 runs** the page reads the missing table as "not set up yet" and the form works exactly as before, without autosave; Submit sends no version, so it compares and clears nothing.
- **Preview.** `/dev/assignment` (404 on production) walks the states against an in-memory server: two racing tabs, flaky, a lost answer, revoked, pre-migration.

## Data

`course_assignments`, `course_assignment_targets`, `course_assignment_submissions`. Read-only RLS; every write is a service-role server action. `student_checkins` / `checkin_feedback` are kept read-only for the record, and shown that way: "Earlier check-ins", collapsed, with the feedback on each, on the student's `/dashboard/assignments`, the mentor's `/mentor/students/[id]` and the admin's `/admin/students/[id]` (`lib/checkin-history-server.ts`; absent for anyone who never posted one).

0093 seeds the running Fall cohort with a "Weekly update" series (weeks 5–9) and the Demo Day submission. Check-ins posted for one of those weeks before the switch become that week's submission (a mentor reply becomes its review).

Before 0093 is applied every page shows an empty state and the cron is a no-op.

Tests: `lib/assignments.test.ts` (dates, DST, status), `lib/assignments-migration-db.test.ts` (RLS in PGlite), `lib/assignment-drafts.test.ts`, `lib/assignment-drafts-client.test.ts` and `lib/assignment-drafts-migration-db.test.ts` (drafts: restore, Back, stale tabs and submits, lost answers, access, privacy).
