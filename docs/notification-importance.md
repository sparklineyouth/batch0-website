# Notification importance

`/notifications` is two inboxes behind one page: **Important** and **Everything
else**, plus a third tab where a person decides which is which.

## How a notification gets classified

Classification is a function of `notifications.type` — never of the individual
row — so a decision applies to every future notification of that kind, not just
the ones already sitting there.

- **Defaults** live in [`lib/notification-importance.ts`](../lib/notification-importance.ts),
  one entry per type with a label, a group for the settings UI, and a default of
  `important` or `other`. The rule of thumb: important means a human probably has
  to act, or would be annoyed to have missed it (acceptance decisions, failed
  payments, invites, DMs). Receipts, recaps and staff-queue chatter are not.
- **Overrides** live in `public.notification_importance` (migration 0091), one
  row per `(user_id, type)` — and only for the types a person has actually
  changed. Setting a type back to its default deletes the row, so "reset" is a
  delete and a shipped change to a default isn't shadowed by a row that only
  ever agreed with it.
- **Unknown types** — a notification from a feature newer than the catalog —
  classify as `important`. A new type being loud by accident is a nuisance; one
  being silent by accident loses information. Any such type a person has
  actually received still shows up in the settings tab, under "Everything else",
  with a humanised label.

Adding a notification type? Add it to `NOTIFICATION_KINDS`. Nothing else is
needed — no backfill, no migration.

## Reading the page

- `?tab=other` and `?tab=settings`; no param is the Important tab. Tab state is
  in the URL, so it's linkable and the page stays a server component.
- The unread count in each tab badge is that tab's own, and **Mark all read** is
  scoped to the tab you're in (`markAllNotificationsRead(types)`), so clearing
  Important doesn't quietly clear everything else.
- The bell in the sidebar is deliberately unfiltered: it's a short "what just
  happened" feed of the last 12, not an inbox.

## What this replaced

The first thing that made the admin inbox unreadable wasn't classification, it
was volume: the at-risk cron sent `"<name> needs a mentor"` to **every** admin,
once per unassigned student per week. That notification is gone — the
`at_risk_interventions` row and `/admin/interventions` were always the real
queue for it — and migration 0091 marks the existing backlog read.
