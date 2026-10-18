# Admin panel

## Overview (`/admin`)

One screen: an inbox row (pending review, awaiting payment, support awaiting
reply, overdue assignments for `assignments.manage`) and one revenue number — USD tuition, fees and Demo Day tickets net of
refunds (`netRevenueCents` in `lib/revenue-ledger.ts`, which the phone home at
`/app/admin` shows too). Each block shows only to roles holding the permission
of the page it links to. Holders of `settings.manage` also get one line while
a probe finds one of the October migrations missing (0093–0101 and 0107; the
line names which, and `docs/migrations-2026-10.md` says what the probes can
and can't see).

### Needs attention

Under the inbox row, one short list (at most 8 rows) of work waiting on the
team, each with a reason, an age, an owner and one action that opens the
source record (`lib/attention.ts`, providers in `lib/attention-server.ts`).
Four sources, each shown only to people who can open the page its rows open
(the route gate in `ADMIN_ROUTE_PERMISSIONS` itself, so `support.manage`
without `support.view` doesn't get Support rows it couldn't follow), and
checked before anything is read:

| Source | Key | Row opens | Count agrees with |
|---|---|---|---|
| Support requests needing a reply (overdue, due soon, unassigned) | `support.view` | `/admin/support/<id>` | Support's *Needs reply* tab |
| Submissions waiting for feedback | `assignments.manage` (everyone's) or `mentor.panel` (their own cohorts and students) | the review drawer on `/admin/assignments`, or `/mentor/assignments#submission-<id>` | the mentor queue's *To review*, or *Waiting for feedback* on `/admin/assignments` |
| Open chat reports | `chat.manage` | `/admin/chat/reports/<id>` | `/admin/chat`'s open reports |
| Follow-ups due today or earlier | `people.view` | the follow-up drawer on `/admin/progress` | *Follow-ups due* on `/admin/progress` |

Rows are derived from the sources on every render, never stored: replying,
reviewing, closing a report or a follow-up (or moving its date) is what takes
a row off. Every source keeps its most pressing row, then the rest go to the
most overdue. Confidential support requests are never rows, for anyone; a
viewer with `support.sensitive` gets one line saying how many are waiting,
linking to Support. Chat reports naming the viewer stay out, as on
`/admin/chat`; one the viewer filed is counted but left for another
moderator, with a line saying so. "Nothing is waiting on the team" appears
only when every source counts zero and none failed. A source whose read fails
(a timeout, not a missing table) is named under the list, never dropped or
shown as empty; a source whose migration hasn't run is simply absent.
Opening the Overview sends nothing and marks nothing read.

Handed-in work from a student who has since left the cohort (moved, or removed
from the program) still waits for feedback, and the review drawer opens and
reviews it; only *Excuse*, which acts on the cohort's roster, is off.

A new source (unanswered chat questions, say) is one more provider: a key in
`AttentionSourceKey`, its permission in `ATTENTION_PERMITTED`, a loader in
`ATTENTION_PROVIDERS`, and a row builder. `/dev/attention` previews the list
with fixtures (404 on production).

## Cohort readiness (`/admin/cohorts`)

Each upcoming or active cohort's row has a Readiness chip ("Ready", "N to
check", "N to fix") that opens a checklist computed on the server from the
cohort's own rows (`lib/cohort-readiness.ts`, loaded by
`lib/cohort-readiness-load.ts` through `lib/cohort-readiness-server.ts`).
"Day one" is the start date in New York, whatever the status: admissions,
the kickoff and the first deadlines run on the calendar even when a cohort is
flipped Active early.

| Check | Fails on | Warns on |
|---|---|---|
| Dates | no start/end date, end before start | start passed but still Upcoming; end passed but still Active; marked Active before its start (that opens the student app and the kickoff page reads as past) |
| Enrollment and price | capacity under 1 | $0 price, over capacity, half-set late entry, applications closing after 00:00 on day one (admissions switch to late entry then, so that time is never reached) |
| Course content | no modules or no lessons | a course week with no module, a module past the last week or with no lessons, an empty lesson |
| Course files | a lesson video, lesson material or cohort resource file storage won't sign (the lesson page silently drops those), a material with no file | an uploaded video that's missing but has a video link students get instead; storage unreachable or slower than 3s |
| Assignment dates | a published deadline already past before day one, or outside the cohort's dates | none published; due before its lesson's week opens |
| Kickoff (before day one) | a join link the kickoff page would hide | page not filled in, no time, no place/link, no session on day one |
| Live sessions | none scheduled inside the cohort's dates | a remaining course week with no session (staff-only rehearsals don't count) |
| Session links | an upcoming external session with no link | — |

Sessions are the cohort's own events plus "Everyone signed in" events with no
cohort, which every student sees; another cohort's public events stay on that
cohort's timetable. A resource with an external link is opened by its link, so
its upload isn't checked.

Each problem links to the editor that fixes it (the cohort form in place,
the kickoff page, `/admin/course?module=<id>`, `/admin/resources/<id>`,
`/admin/assignments?cohort=<id>`, `/admin/events?edit=<id>`), and only when
the viewer holds that editor's permission. A table that fails to load, or
takes longer than 4s, shows "Couldn't load" rather than a false empty.
`/dev/cohort-readiness` renders the table over fixtures. Unrelated to
`docs/cohort-readiness.md`, the offline Winter curriculum script.

## Adding a page

1. Map its path in `ADMIN_ROUTE_PERMISSIONS` (`lib/permissions.ts`). Unmapped
   paths open to every admin-area role. `lib/admin-routes.test.ts` walks
   `app/admin` and fails on an unmapped page or a stale row.
2. Add a sidebar row in `ADMIN_NAV_GROUPS` (`lib/nav-config.ts`) with the same
   `perm`.
3. Call `assertPermission` in every server action.

A row's `perm` can be a list, meaning any one of them. Email uses this: the
sidebar's single Email row opens `/admin/email`, which the middleware forwards
to the first tab in `EMAIL_TAB_ROUTES` (`lib/permissions.ts`) the viewer holds;
each tab keeps its own key. The landing's any-of rule lives in
`ADMIN_EXACT_ROUTE_PERMISSIONS`, so it covers that one path; anything else
under `/admin/email` needs `email.view` unless it has its own row. Teams does
the same: `/admin/teams` opens on `teams.manage` or `moderation.manage` and
shows each holder its part (the team list, the logo review queue on top); a
team's own pages stay on `teams.manage`.

## People

- **Roles.** The email form at `/admin/roles`, the picker on a person's row
  and profile, and the bulk change all go through `changeRoles`
  (`lib/role-change-server.ts`) and one rule (`lib/role-change.ts`): nobody
  changes their own role (full admins included), nobody assigns a role that
  holds more than theirs, nobody changes someone whose current role holds
  admin permissions they don't (so only a full admin re-roles a full admin;
  the participant and panel keys such as `student.dashboard` don't count, so
  a delegate without them can still promote a Student), and the site always
  keeps one full admin. Rows the viewer can't change show a badge, not
  a picker, with the guard's reason; a bulk change skips them and counts them
  as skipped. Migration 0103's `keep_a_full_admin` triggers hold the last rule
  in the database too, for any writer and for two admins demoting each other
  at once.
- **Role impact previews.** Before anything is saved, `lib/role-impact.ts`
  works out what a change does from the permission catalog alone (the route
  guard's own `canViewAdminPath`, `canAccessAdmin` and the panel keys), never
  by acting as a real user. Editing a role shows "What saving changes" above
  Save: the admin pages and panels its holders gain or lose, whether it opens
  the admin panel at all and through which key, the sensitive grants with a
  line on why, broken `PERMISSION_NEEDS` pairs and keys that do nothing as
  ticked, and how many people hold it; Save stays off while the action would
  refuse (`roleSaveRefusal`, which `updateRole` and `createRole` run too). The
  email form looks the account up once the address is complete
  (`previewRoleGrant`, read-only, the same `decideRoleChange` the write uses)
  and shows what that person would gain or lose, or why the guard would say
  no. The row picker and the bulk change ask first with the same preview,
  the bulk dialog grouped by current role with each skip's reason; deleting a
  role shows what moving its holders does. The server decides again on every
  write. `/dev/roles` renders all of it over fixtures.
- **Moving a student** (profile → Manage → Move to a different cohort) is one
  database transaction (`admin_move_student_cohort`, 0103): the enrollment
  shown as current, the application it came from and their live scholarship
  rows move together, or nothing does (a full cohort, an active checkout).
  Someone added with "Add a person" has no application and keeps their
  access. Someone who paid but is enrolled nowhere (what the old move's
  failed insert left behind) gets that enrollment back by being "moved" to
  the cohort they paid for. Earlier cohorts, other applications and payments
  stay put. Until 0103 runs the button says it needs the migration.
- **What a profile shows.** It opens on `people.view`. Payments (amounts,
  statuses, Stripe ids) need `payments.view`, the same as `/admin/payments`;
  fees & fines need `charges.manage` or `payments.view`. Neither is fetched
  for a viewer who can't see it. Each Manage control renders only for the
  permission its action asserts (`lib/people-profile-access.ts`; a test reads
  the actions to keep the two in step).

## Folded pages

- **Pass requests** live at the top of `/admin/passes` ("Feedback requests",
  shown only while one is open). `/admin/pass-requests` redirects there.
- **Moderation** (team logos) lives at the top of `/admin/teams` ("Logos to
  review"). `/admin/moderation` redirects there; new-logo bells link there.
- **Student progress** (`/admin/progress`) counts handed-in assignments and
  challenge entries as activity, like a student's own page, so nobody who
  only submitted work is listed as never started.
- **Follow-ups** live on Student progress (migration 0107): a drawer per
  student with an owner, the next check date and a factual note, so two
  people don't chase the same student. One open follow-up per student; the
  Follow-up column shows who has it. Reading needs `people.view`; starting,
  changing, closing or owning one needs `people.manage` too. Only a person
  starts one (nothing turns inactivity into a follow-up), and nothing about
  one is sent to anyone. Due ones are listed at the top of the page and in the
  Overview's attention list. Edits name the version they started from, so a
  second person's save never silently replaces the first's. An owner whose
  role no longer holds those keys keeps the follow-up until someone edits it;
  the drawer then asks for a new owner rather than offering them. A read that
  fails says "Couldn't load follow-ups", never "not set up yet".
- **Assignments** (`/admin/assignments`) lists the longest-waiting
  submissions across every cohort under *Waiting for feedback*, with the exact
  count, each opening its review drawer — the same read as the Overview's
  Feedback source.

## Retired (October 2026)

Email metrics, phone-number requests, the founder-pass self-check, the pricing
scenario calculator, mentor matching, AI usage, campaign payments, course
analytics, and the weekly digest cron. Their data stays: the Resend webhook
still records `email_events`, AI spend caps still enforce from `ai_usage`, and
campaign results are in the `campaign_attribution_report` view.

Migration `0100_admin_cleanup.sql` strips the retired `ai_usage.view` key from
stored roles and deletes leftover self-check probe passes (negative serials).
No schema change. Until it runs, a stale key only stops non-superadmins
editing that role, and the passes ledger hides probe rows regardless.

A custom role whose only admin keys were the retired ones (`pulse.view`,
`interventions.manage`, `discussions.manage`, `ai_usage.view`) lost the admin
area with the deploy, before any migration. `/admin/roles` marks such a role
"opens no page", and its members see "Nothing to open yet" on `/dashboard`.
Give it a current key at `/admin/roles/<slug>` (a role that answered student
questions through `discussions.manage` wants `support.view` and
`support.manage`). To find them in SQL, before or after 0093/0099/0100:

```sql
select r.slug, r.permissions, count(p.id) as members
from app_roles r left join profiles p on p.role = r.slug
where not r.permissions && array['*', 'student.dashboard', 'mentor.panel', 'investor.panel']
group by r.slug, r.permissions;
```

Any row whose `permissions` are empty or only retired keys is one; one that
also holds a current admin key is fine.
