# Admin panel

## Overview (`/admin`)

One screen: an inbox row (pending review, awaiting payment, support awaiting
reply) and one revenue number — USD tuition, fees and Demo Day tickets net of
refunds (`revenueSummary` in `lib/revenue-ledger.ts`). Each block shows only to
roles holding the permission of the page it links to.

## Adding a page

1. Map its path in `ADMIN_ROUTE_PERMISSIONS` (`lib/permissions.ts`). Unmapped
   paths open to every admin-area role. `lib/admin-routes.test.ts` walks
   `app/admin` and fails on an unmapped page or a stale row.
2. Add a sidebar row in `ADMIN_NAV_GROUPS` (`lib/nav-config.ts`) with the same
   `perm`.
3. Call `assertPermission` in every server action.

A row's `perm` can be a list, meaning any one of them. Email uses this: the
sidebar's single Email row opens `/admin/email`, which forwards to the first
tab in `EMAIL_TABS` the viewer holds; each tab keeps its own key.

## Retired (October 2026)

Email metrics, phone-number requests, the founder-pass self-check, the pricing
scenario calculator, mentor matching, AI usage, campaign payments, course
analytics, and the weekly digest cron. Their data stays: the Resend webhook
still records `email_events`, AI spend caps still enforce from `ai_usage`, and
campaign results are in the `campaign_attribution_report` view.

Migration `0100_admin_cleanup.sql` strips the retired `ai_usage.view` key from
stored roles and deletes leftover self-check probe passes (negative serials).
The app runs the same before and after it.
