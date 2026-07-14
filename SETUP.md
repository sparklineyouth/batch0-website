# batch0 — Setup

This app is a Next.js 14 marketing site + a full Supabase + Stripe backend for student applications, payments, and an embedded course (LMS).

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

## 2. Run the database migration

Open the Supabase SQL Editor for your project:

https://supabase.com/dashboard/project/taiqnjpojenqkbuuwxeo/sql/new

Paste the contents of [`supabase/migrations/0001_init.sql`](supabase/migrations/0001_init.sql) and click **Run**. This creates every table, RLS policy, the storage buckets, and seeds the first cohort (Summer 2026, 24 seats, $97).

You can re-run the file safely — it uses `if not exists` and `on conflict do nothing` everywhere.

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
- `payment_intent.payment_failed`
- `charge.refunded`

Then copy the production "Signing secret" into your hosting platform's env vars.

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

Course videos and materials live in private Supabase Storage buckets:

- `course-videos` — MP4 files
- `course-materials` — PDFs, slides, worksheets

Upload via the Supabase dashboard (Storage → bucket → Upload). Then in `/admin/course`:

1. Create a Module (week, title, summary, attached to a cohort).
2. Add Lessons under it. Paste the storage path (e.g. `week1/intro.mp4`) into **Video path**, or use an external URL.
3. Optional: list materials as JSON, e.g.
   ```json
   [{ "title": "Slides", "path": "week1/slides.pdf" }]
   ```

Lessons are gated — only students enrolled in the matching cohort can read them, and signed URLs are generated server-side per request.

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
  apply/                 multi-step application
  dashboard/             student: home, application, course, billing, settings
  admin/                 admin: overview, applications, students, cohorts, course, payments, settings
  api/stripe/            checkout, webhook
  auth/                  callback, signout
lib/
  supabase/              client / server / admin / middleware
  stripe.ts
  auth.ts
  types.ts
supabase/
  migrations/0001_init.sql
components/
  ui/                    shared primitives (button, input, card)
  dashboard/sidebar.tsx
  admin/sidebar.tsx
  ... existing marketing components
```
