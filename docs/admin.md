# Admin panel

## Overview (`/admin`)

One screen: an inbox row (pending review, awaiting payment, support awaiting
reply, overdue assignments for `assignments.manage`) and one revenue number — USD tuition, fees and Demo Day tickets net of
refunds (`netRevenueCents` in `lib/revenue-ledger.ts`, which the phone home at
`/app/admin` shows too). Each block shows only to roles holding the permission
of the page it links to. Holders of `settings.manage` also get one line while
a probe finds one of migrations 0093–0100 missing (`docs/migrations-2026-10.md`
says what it can and can't see).

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

## Folded pages

- **Pass requests** live at the top of `/admin/passes` ("Feedback requests",
  shown only while one is open). `/admin/pass-requests` redirects there.
- **Moderation** (team logos) lives at the top of `/admin/teams` ("Logos to
  review"). `/admin/moderation` redirects there; new-logo bells link there.
- **Student progress** (`/admin/progress`) counts handed-in assignments and
  challenge entries as activity, like a student's own page, so nobody who
  only submitted work is listed as never started.

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
