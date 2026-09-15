# Demo Day tickets

A paid link for **Demo Day only** — not the cohort — at whatever price an admin
sets, sent to any email address. The person paying doesn't need a batch0
account.

## The flow

1. **Admin sends a ticket** at `/admin/demo-day/tickets` (also linked from
   the Demo Day admin page and from a person's page as "Send a Demo Day
   ticket"). Name, email, price, which cohort's Demo Day, an optional note.
   Gated on `demoday.manage`.
2. A `demo_day_tickets` row is written with a random secret `token`, then the
   invite email goes out (`demo_day.ticket_invite`, admin-editable at
   `/admin/email/templates`; compiled fallback in `lib/email/templates.ts`).
   The email's button opens the pay link. The admin gets the link back too
   ("Copy link"), so a bounced email isn't a dead end.
3. **The recipient opens `/demo-day/ticket/<token>`** — public, `noindex`,
   no sign-in — and pays through Stripe Checkout
   (`POST /api/stripe/demo-day-ticket-checkout`, rate-limited per IP and per
   token). Sessions carry `metadata.kind = "demo_day_ticket"`.
4. **Fulfillment** is `fulfillDemoDayTicket` in `lib/stripe-fulfillment.ts`,
   reached by the webhook AND by the ticket page settling the session on
   return from Checkout (`syncDemoDayTicketSession`, which checks the session
   names that exact ticket). Idempotent: the row moves `sent → paid` once,
   guarded on status; the confirmation email
   (`demo_day.ticket_confirmed`) and in-app note are deduped per ticket.
5. **Refunds** — the admin "Refund" button or one issued in the Stripe
   dashboard — land in `handleChargeRefunded`, which mirrors a FULL refund to
   `refunded`. The reconciler (`lib/stripe-reconcile.ts`) knows about ticket
   sessions too.

## What a paid ticket unlocks

The ticket itself is the email + the ticket page: once paid, the page and the
confirmation email show the day's details (time, place, join link for an
external event) pulled from the cohort's `demo_day` event, or the
`demo_day_date` site setting before the event exists.

If the ticket's email matches a batch0 account (checked when sent and again
when paid), that account gets exactly one extra door:

- the `events read` RLS policy (migration 0070) lets a **paid** ticket holder
  read `demo_day`-type events for the ticket's cohort (any cohort when the
  ticket wasn't pinned to one) — nothing else opens up;
- `StudentAccess.demoDayTicket` (`lib/access.ts`) shows the Events link in the
  student nav and lets `/dashboard/events` render for a non-enrolled holder;
- the dashboard home shows a "You're confirmed for Demo Day" card, and
  `/dashboard/billing` lists the ticket in payment history.

A hosted (Daily) Demo Day is joined from `/dashboard/events/<id>/live`, which
requires a signed-in account — so a holder with no account can only be
admitted to an **external** (Zoom etc.) event via the link, or by the team
sending joining details by hand. The confirmation copy says as much.

Known gap: an accepted-but-not-yet-started student is under the pre-cohort
lockdown in middleware, which bounces `/dashboard/events` regardless of a
ticket. They can still use the public ticket page.

## Statuses

| status      | meaning                                                       |
| ----------- | ------------------------------------------------------------- |
| `sent`      | link is live and payable (resend / cancel available)          |
| `paid`      | money captured; ticket is good (refund available)             |
| `cancelled` | admin pulled the unpaid link; page and checkout refuse it     |
| `refunded`  | full refund issued; no longer admits                          |

## Migration

`supabase/migrations/0070_demo_day_tickets.sql` — paste into the Supabase SQL
editor. Until it's applied every surface degrades to empty: the admin list is
empty, sending a ticket reports the error, and the dashboard reads
`demoDayTicket = false`.
