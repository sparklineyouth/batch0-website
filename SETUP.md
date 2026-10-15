# batch0 — Setup

This app is a Next.js 15 marketing site + a full Supabase + Stripe backend for student applications, payments, an embedded course, assignments, and live webinars and 1:1 calls.

Follow these steps once on your machine.

## 1. Install Node and dependencies

If you don't have Node:

```sh
brew install node
```

Then in the project root:

```sh
npm install
```

## 2. Run the database migrations

The quick way: put the database connection string in `.env.local` as
`SUPABASE_DB_URL` (Supabase → Connect → "Session pooler", with your database
password filled in), then run

```bash
npm run db:migrate              # shows what would run, changes nothing
npm run db:migrate -- --apply   # backs up, then runs every pending file in order
```

It works out which files the database still needs (recorded by the Supabase
CLI, a passing verify query, or a later file having run), backs up what the
pending files remove or rewrite into `backups/` (gitignored), runs each file
in one transaction with its verify query checked before COMMIT, and records
them so `supabase migration list` agrees. Details: `scripts/db-migrate.mts`.

Or by hand: open the Supabase SQL Editor for your project:

https://supabase.com/dashboard/project/taiqnjpojenqkbuuwxeo/sql/new

Run every file in [`supabase/migrations/`](supabase/migrations) in number
order (paste, **Run**). Each is idempotent, so re-running one is safe.
`0001_init.sql` creates the base tables, policies and buckets and seeds the
first cohort. The latest batch, 0093–0101, has its own checklist with a verify
query per file: [`docs/migrations-2026-10.md`](docs/migrations-2026-10.md).

## 3. Set up environment variables

The file `.env.local` exists but has placeholders. Fill it in with your **rotated** keys:

- `NEXT_PUBLIC_SUPABASE_ANON_KEY` — from Supabase → Settings → API → "Publishable" key (sb_publishable_…)
- `SUPABASE_SERVICE_ROLE_KEY` — same page, "Secret" key (sb_secret_…)
- `STRIPE_SECRET_KEY` — Stripe → Developers → API keys (use **test** keys: `sk_test_…`)
- `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` — same page (`pk_test_…`)
- `STRIPE_WEBHOOK_SECRET` — see step 5

> `.env.local` is gitignored. Never commit it.

## 4. Make yourself an admin

After you've run the migration, sign up at http://localhost:3000/signup with your email. Verify the email (Supabase will send a confirmation if email confirmations are on — you can disable them under Auth → Providers → Email if you don't want them).

Then in the SQL editor:

```sql
update public.profiles
set role = 'admin'
where email = 'your.email@example.com';
```

You'll now see an "Admin panel" link in your dashboard sidebar.

## 4b. Roles and permissions

Roles are rows in `public.app_roles`, not hard-coded strings. Five ship out of
the box — `student`, `admin`, `mentor`, `investor`, and `intern` — and admins
mint more at **/admin/roles**.

Each role owns a list of permission keys (defined in
[`lib/permissions.ts`](lib/permissions.ts)). A permission decides three things
at once, from one string:

- whether the link appears in the admin sidebar,
- whether the route loads (enforced in the middleware *and* in
  `app/admin/layout.tsx`),
- whether the server actions on that page will run.

`admin` holds the `*` wildcard — everything, including permissions added
later. That's deliberately not editable from the UI: narrowing it would lock
every admin, including you, out of the site. To give someone less, create a
role.

Two rules keep the system from being a privilege-escalation ladder:

- **You can't grant what you don't hold.** Creating or editing a role, and
  assigning one to a person, are all capped by the assigner's own permissions.
- **Nobody re-roles themselves.**

Nobody applies for a role. They sign up at `/signup` like anyone else, then an
admin assigns the role — on the People page, or by email at the bottom of
/admin/roles. No application, cohort, or payment is involved.

## 5. Stripe webhook (local dev)

Stripe must be able to call your `/api/stripe/webhook` endpoint to confirm payment. Locally, use the Stripe CLI:

```sh
brew install stripe/stripe-cli/stripe
stripe login
stripe listen --forward-to localhost:3000/api/stripe/webhook
```

The CLI prints `Ready! Your webhook signing secret is whsec_xxxxx`. Copy that into `.env.local` as `STRIPE_WEBHOOK_SECRET`. **Leave the `stripe listen` process running while developing** — it relays real Stripe events to your local server.

For production, create a webhook in the Stripe dashboard pointed at `https://yourdomain.com/api/stripe/webhook`. Subscribe to:

- `checkout.session.completed`
- `checkout.session.async_payment_succeeded`
- `checkout.session.async_payment_failed`
- `checkout.session.expired`
- `payment_intent.payment_failed`
- `charge.refunded`

Then copy the production "Signing secret" into your hosting platform's env vars.

### Payment state is reconciled three ways

The webhook is the primary path, but it is never the only one — a student
must never be shown "pay now" for money they already sent.

1. **Webhook** — Stripe's authoritative delivery.
2. **On return from Checkout** — the success URL carries the session id, and
   `/dashboard/application` and `/dashboard/billing` settle it against
   Stripe before rendering. This wins the redirect race almost every time.
3. **Reconciliation** — `/api/cron/stripe-reconcile` runs daily over a
   14-day window, and **Admin → Payments → Sync from Stripe** replays the
   whole account history on demand. Use the button after changing webhook
   config, after an outage, or to backfill transactions that predate the
   webhook.

All three run the same idempotent fulfillment in `lib/stripe-fulfillment.ts`,
so whichever arrives first wins and the rest are no-ops. Emails and
notifications fire only on the real transition into paid; reconciliation
runs silently.

## 6. Run the dev server

```sh
npm run dev
```

Visit http://localhost:3000.

## 7. End-to-end smoke test

1. Sign up as a student (different email from admin).
2. Go through `/apply`, submit the application.
3. Switch to the admin account → `/admin/applications` → open the new application → click **Accept**.
4. Switch back to the student → `/dashboard/application` → click **Pay & enroll**.
5. Use Stripe's test card: `4242 4242 4242 4242`, any future expiry, any CVC, any ZIP.
6. After redirect, the webhook fires (watch the `stripe listen` output) and you'll be enrolled.
7. Visit `/dashboard/course` — modules and lessons appear once you've added them under `/admin/course`.

## 8. Adding course content

In `/admin/course`, create a module (week, title, cohort), add lessons, and
upload each lesson's video and materials right there. They land in the private
`course-videos` and `course-materials` buckets. Lessons are gated: only students
enrolled in the matching cohort can read them, through short-lived signed URLs.
Weekly work goes in `/admin/assignments` (`docs/assignments.md`).

## 9. Deploy

The repo deploys cleanly to Vercel:

1. Connect the GitHub repo.
2. Add every variable from `.env.local` into Vercel's project env vars.
3. Set `NEXT_PUBLIC_SITE_URL` to the production URL.
4. Update Stripe webhook to point at the production URL.
5. Update Supabase Auth → URL Configuration → Site URL to the production URL, and add it to the redirect allowlist.

## File map

```
app/
  (auth)/                login, signup, forgot, reset
  apply/                 application, one question per screen (rules in lib/apply-flow.ts)
  dashboard/             student: home, course, assignments, team, events, calls, billing, settings
  admin/                 admin panel (one page per sidebar row, gated in lib/permissions.ts)
  mentor/, investor/     the mentor and investor panels
  app/                   the installed phone app (app.batch0.org)
  api/                   Stripe, crons, live rooms, recordings
lib/
  supabase/              client / server / admin / middleware
  student-nav.ts         student links and who sees them
  nav-config.ts          every panel's sidebar
  permissions.ts         permission keys and admin route gates
supabase/migrations/     0001…0100, run in order
components/
  ui/                    shared primitives (button, input, card)
  live/                  the webinar and 1:1 room
docs/                    one file per feature
```
