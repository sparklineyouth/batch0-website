# batch0 — batch0.org

The batch0 marketing site and application platform for student founders, with
applications, payments, courses, and student/admin dashboards.

## Stack

- Node.js 24.x; `.nvmrc` pins the verified local version, 24.21.0
- Next.js 15.5.25 (App Router), React 19.3.0, and TypeScript
- Tailwind CSS and lucide-react
- Supabase for authentication, database, and private file storage; Stripe for payments

## Fresh checkout

Use Node.js 24.x. With nvm installed, run these commands from the repository root:

```sh
nvm install
nvm use
npm ci
```

Create `.env.local` from `.env.local.example` if you do not already have one.
Configure `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`,
`SUPABASE_SERVICE_ROLE_KEY`, and `STRIPE_SECRET_KEY` for your development
environment. Set `NEXT_PUBLIC_SITE_URL` to `http://localhost:3000` locally.
The template documents payment webhooks and optional integrations; leave unused
optional services unset. Keep secret values out of Git and browser-facing variables.

```sh
npm run dev
```

Open http://localhost:3000. Authentication and other service-backed features
need configured services and their database migrations; placeholder credentials
do not provide a working backend.

## Verify and build

```sh
npm test
npm run test:discord-db
npm run test:scholarships-db
npm run build
npm start
```

The two database test commands use isolated, in-memory PGlite databases. The
production build compiles and type-checks the app, then checks that the expected
blog and marketing routes remain prerendered.

`STRIPE_SECRET_KEY` must be nonempty even during a build because the Stripe client
is initialized when its module loads. A clean checkout was verified on Node
24.21.0 with 393 unit tests, 36 isolated database tests, and a successful build
using intentionally invalid Supabase/Stripe fixture values. Unavailable Supabase
reads used the marketing fallback data. This proves build portability; it does
not validate live authentication, payments, or production configuration.

## Deployment

Deploy to Vercel with Node.js 24.x, install with `npm ci`, and build with
`npm run build`. Configure real environment values in the hosting project's
environment settings; do not upload a developer's `.env.local` as configuration.
Production uses `batch0.org` and `app.batch0.org`, with matching authentication
redirects and webhook endpoints. See `.env.local.example` for available settings.

The checkout can live anywhere. Dependencies and `.next` are rebuilt locally;
private course source under `content/course-launch/` is intentionally excluded
from this public repository and is not needed for the website build. Restore
those private materials separately when running curriculum publishing tools.
