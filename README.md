# batch0 — batch0.org

The batch0 marketing site and application platform for student founders, with
applications, payments, courses, and student/admin dashboards.

The program runs on: the course and an assignment tracker
(`docs/assignments.md`), Google Drive links for team work
(`docs/google-drive.md`), webinars and 1:1 calls in a built-in room with one
continuous recording (`docs/batch0-live.md`, `docs/recording.md`), and
**batch0 Chat** for community at `/chat`: channels, DMs and group DMs, built
in (`docs/chat.md`). Chat replaced Discord in October 2026 (migration 0101);
there is no Discord integration any more. Check-ins, in-app files,
discussions, the team thread and office hours were retired; their tables and
rows stay, and the app no longer writes to them. Old DMs and team threads
were carried into Chat.

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
npx tsc --noEmit
npm test
npm run test:scholarships-db
npm run test:profile-privileges-db
npm run test:call-cohosts-db
npm run test:calls-db
npm run test-blast-addressing
npm run build
npm start
```

`npm test` runs every `lib/*.test.ts`, including the PGlite migration tests;
the `test:*-db` commands use their own in-memory PGlite databases. CI
(`.github/workflows/ci.yml`) runs all of the above except the build. On
2026-10-15 that was 1,239 unit tests and 54 database tests, all passing. The
production build compiles and type-checks the app, then checks that the
expected blog and marketing routes remain prerendered.

`STRIPE_SECRET_KEY` must be nonempty even during a build because the Stripe client
is initialized when its module loads. Unavailable Supabase reads use the
marketing fallback data, so a build with fixture credentials proves portability,
not live authentication, payments, or production configuration.

## Deployment

Deploy to Vercel with Node.js 24.x, install with `npm ci`, and build with
`npm run build`. Configure real environment values in the hosting project's
environment settings; do not upload a developer's `.env.local` as configuration.
Production uses `batch0.org` and `app.batch0.org`, with matching authentication
redirects and webhook endpoints. See `.env.local.example` for available settings.

Migrations are run by hand in the Supabase SQL editor after the code deploys.
The October 2026 release adds 0093–0101: 0095 and 0096 go in before the
deploy and the rest right after it; see `docs/migrations-2026-10.md` for the
order, why, and a verify query per file. The app runs without them. `/admin`
shows `settings.manage` holders one line while it detects one missing (the
tables and columns of 0093–0096 and 0101, leftovers of 0099–0101); the policy
changes in 0097–0099 are confirmed only by the doc's verify queries.

The checkout can live anywhere. Dependencies and `.next` are rebuilt locally;
private course source under `content/course-launch/` is intentionally excluded
from this public repository and is not needed for the website build. Restore
those private materials separately when running curriculum publishing tools.
