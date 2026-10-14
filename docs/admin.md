# Admin panel

## Overview (`/admin`)

One screen: an inbox row (pending review, awaiting payment, support awaiting
reply, overdue assignments for `assignments.manage`) and one revenue number — USD tuition, fees and Demo Day tickets net of
refunds (`netRevenueCents` in `lib/revenue-ledger.ts`, which the phone home at
`/app/admin` shows too). Each block shows only to roles holding the permission
of the page it links to. Holders of `settings.manage` also get one line while
a probe finds one of migrations 0093–0100 missing (`docs/migrations-2026-10.md`
says what it can and can't see).

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
under `/admin/email` needs `email.view` unless it has its own row.

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
