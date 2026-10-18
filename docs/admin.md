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
