# Live video on batch0.org — webinars + 1:1 calls

> ## ⚠️ Superseded: webinars no longer run on Daily
>
> **Live video now runs on [batch0 Live](./batch0-live.md), a self-hosted
> WebRTC provider built into this repo.** Read that document first — this one
> is kept because its analysis of the problem is still accurate and because
> the Daily path is still in the codebase behind `LIVE_PROVIDER=daily`.
>
> **Why the switch.** The Daily integration described below was correct and is
> still correct. What is not correct is the Daily *account*: it cannot start a
> media session at all. Every join is refused with
> `account-missing-payment-method` — including a join into a bare public room
> with no properties set, which rules out anything in this repo as the cause.
> It is an account-level block, and only a payment method on the Daily account
> clears it.
>
> **Why nobody noticed.** `npm run daily-doctor` passed every check the entire
> time. It exercises the REST plane — create a room, mint a token, decode the
> claims — and all of that still works today. The failure was on the media
> plane, which no REST-shaped check can see. That gap is the real lesson here,
> and it is now closed by `npm run webinar-e2e`, which drives two real
> browsers into a real room and asserts on decoded video frames.
>
> **To go back to Daily**: add a card to the Daily account, set
> `LIVE_PROVIDER=daily`, and run `npm run webinar-e2e -- --provider=daily` to
> confirm the media plane actually works before trusting it with an audience.

## Status

Built and merged into the branch. **Three migrations still need running by hand**
before any of it works — this repo applies migrations through the Supabase SQL
Editor (see SETUP.md), so nothing has touched the database yet:

1. `supabase/migrations/0058_hosted_events.sql`
2. `supabase/migrations/0059_call_invites.sql`
3. `supabase/migrations/0060_webinar_questions.sql`

Run them in that order. All three are idempotent and safe to re-run. Until they
are applied, `/admin/events` will fail to save a hosted event, `/dashboard/calls`
will error, and the webinar Q&A panel will fail to load or post questions,
because the columns and tables they read do not exist yet.

Verify the provider side any time with:

```
npm run daily-doctor
```

which creates a private room, mints a host and a viewer token, asserts the two
differ in the ways that matter (`is_owner`, `hasPresence`, recording rights),
and deletes the room. `--keep` leaves it up and prints two join URLs so you can
open them in separate browsers and see the split for real.

Two features, one shared primitive:

1. **Webinars** — admin broadcasts with camera/mic/screen; students watch and ask
   questions. Surfaced on the existing events page.
2. **1:1 calls** — mentors, investors, and admins invite a specific student to a
   private call at a specific time.

Both are just "a room, and a signed ticket that says who you are in it". Get that
one primitive right and both features fall out of it.

---

## 1. What already exists

This is not a greenfield feature. The repo already has most of the scaffolding:

| Thing | Where | State today |
| --- | --- | --- |
| `events` table | `supabase/migrations/0005_platform_v2.sql` | Has `zoom_url`, `recording_url`, `visibility` (`public`/`enrolled`/`staff`). RLS already gates reads correctly. |
| Admin events UI | `app/admin/events/` | Full CRUD + Discord cross-post + email fan-out. `zoom_url` is a free-text field. |
| Student events page | `app/dashboard/events/page.tsx` | Renders "Join Zoom" as an external `<a>`. |
| Calendar export | `app/api/events/[id]/ics/route.ts` | Emits `URL:` from `zoom_url`. |
| Office hours | `mentor_slots` + `mentor_bookings` (`0011_phase2_features.sql`) | **Student-initiated**: a mentor posts open slots, a student claims one. Also a free-text `zoom_url`. |
| Roles / permissions | `lib/permissions.ts`, `lib/roles.ts` | `events.manage` already exists. Roles are DB rows with a permission array. |
| Notifications + email | `lib/notifications.ts`, `lib/email/templates.ts` | `Templates.eventReminder` already takes a `zoomUrl`. |

So the shape of the work is **replacing a pasted external URL with a room this
site owns and controls access to** — not building a scheduling system from
scratch.

The one genuine gap: office hours runs student→mentor. The requested 1:1 feature
runs staff→student (the host picks the person). That is a new table, not a tweak
to `mentor_bookings`.

---

## 2. Provider choice

You do not want to build WebRTC yourself. At a program of this size, SFU
infrastructure is months of work and a permanent on-call burden to save money you
are not currently spending.

**Recommendation: [Daily](https://www.daily.co).**

Why it fits this codebase specifically:

- **Daily Prebuilt** is an embeddable iframe with a complete call UI (grid, screen
  share, chat, recording controls). The call happens *on batch0.org* — which is
  the actual requirement — without you building a video UI.
- **`owner_only_broadcast: true`** is literally webinar mode: only owners get
  camera/mic, everyone else is a viewer. That is feature #1 as a room config flag.
- **Meeting tokens** are server-minted JWTs carrying `is_owner`, `user_name`, and
  `exp`. This maps 1:1 onto the existing permission model — `can(caps,
  "events.manage")` becomes `is_owner: true`. Access control stays in this repo's
  RLS + permission checks, not in a second system you have to keep in sync.
- Same primitive serves both features: a webinar is a room with
  `owner_only_broadcast`, a 1:1 is a room with two tokens.

Cost, from [Daily's pricing page](https://www.daily.co/pricing/video-sdk/):

- 10,000 participant-minutes/month free.
- $0.004/participant-minute after that (volume discounts to $0.0015).
- Cloud recording $0.01349 per recorded minute (wall-clock, not × participants).

A 60-minute webinar with 20 students and 1 host = 21 × 60 = **1,260
participant-minutes**. The free tier covers roughly **8 such webinars a month**
before you pay anything. A 30-minute 1:1 is 60 participant-minutes. Realistically
this feature costs $0 for a while, then tens of dollars a month.

Capacity is not a concern: Daily supports up to 1,000 active participants per
room (set `experimental_optimize_large_calls: true` above 50), and far more in
broadcast mode.

### Alternatives considered

- **LiveKit** — cheaper per-minute at real scale and open-source (self-hostable,
  no lock-in). But its free tier is now [5,000 WebRTC
  minutes](https://livekit.com/pricing) and heavily oriented toward AI voice
  agents, and it has no drop-in prebuilt UI equivalent — you assemble the call
  interface from their React components. That is real extra work for this scope.
  Worth revisiting if video usage ever gets heavy.
- **Zoom Video SDK** — different product from the Zoom you already link to;
  embeddable but heavier, and its licensing/pricing is less friendly to a small
  program.
- **Jitsi (self-hosted)** — free of per-minute cost, but you own an SFU, TURN
  servers, and scaling. Not worth it here.
- **Keep using Zoom links** — the honest baseline. Costs nothing to build. What
  you lose is: students leave the site, access isn't tied to enrolment, and
  recordings/attendance live outside your database. Those are exactly the things
  this feature is for.

---

## 3. What you need to connect

Short list. Everything else is code in this repo.

1. **A Daily account** (daily.co, free to start). Gives you a domain like
   `batch0.daily.co`.
2. **API key** — Daily dashboard → Developers → API key.
3. **Two env vars**, following the `lib/env.ts` optional-integration convention
   (helpers no-op when unset, so local dev and previews keep working):

   ```
   DAILY_API_KEY=            # server-only. Never expose — it can create rooms
                             # and mint owner tokens for any room.
   NEXT_PUBLIC_DAILY_DOMAIN= # e.g. batch0.daily.co — safe to expose
   ```

   Add to `.env.local.example`, `lib/env.ts`, and Vercel → Settings →
   Environment Variables (all three environments).
4. **One npm dependency**: `@daily-co/daily-js` (the Prebuilt embed). Optionally
   `@daily-co/daily-react` if you later want a custom UI instead of Prebuilt.
5. **Optional — a Daily webhook** pointed at `/api/daily/webhook` for
   `recording.ready-to-download`, so finished recordings auto-populate
   `events.recording_url` instead of being pasted by hand. Verify the signature
   the same way `/api/resend/webhook` does (see `lib/svix.ts` for the existing
   pattern) and exclude it from middleware in `middleware.ts`, as the other
   signature-authenticated webhooks already are.

**No DNS, no domain config, no new auth system.** The Daily domain is never
user-visible — students only ever see batch0.org.

### Infra notes

- `next.config.js` sets **no CSP and no `Permissions-Policy`** today, so nothing
  currently blocks `getUserMedia` or the Daily iframe. If a CSP is ever added it
  will need `frame-src https://*.daily.co` and `connect-src wss://*.daily.co
  https://*.daily.co`, and a `Permissions-Policy` will need
  `camera=(self "https://*.daily.co")` and the same for `microphone` and
  `display-capture`.
- Camera/mic require **HTTPS**. Vercel and `localhost` both qualify; a LAN IP
  like `192.168.x.x` does not, which matters if you test from a phone.
- Recording storage defaults to Daily's cloud. If you'd rather keep recordings in
  Supabase Storage alongside challenge uploads (`0047_challenge_uploads_bucket.sql`),
  Daily can be pointed at an S3-compatible bucket instead.

---

## 4. Design

### 4a. The room primitive

One server module, `lib/daily.ts`, mirroring how `lib/discord.ts` wraps Discord:

- `createRoom({ name, mode, expiresAt })` → `POST https://api.daily.co/v1/rooms`
- `mintToken({ room, userId, userName, isOwner, expiresAt })` → `POST /meeting-tokens`
- `deleteRoom(name)`
- `roomIsLive(name, until?)` → `GET /rooms/:name` — does the stored room still
  exist, and does its `exp` outlast the session? Both join pages ask before
  minting, and replace a dead room, because a token for a reaped room mints
  fine and only fails in the browser.
- `updateRoomExpiry(name, expiresAt)` → `POST /rooms/:name` — re-stamps `exp`
  when an event is re-saved, so moving a webinar to a later date moves its room
  with it instead of leaving one that expires on the old date.
- Every function no-ops or throws a typed error when `DAILY_API_KEY` is unset, so
  an unconfigured environment degrades to "hosting unavailable" rather than 500s.

**The security rule that matters:** rooms are created with `privacy: "private"`.
A private room cannot be joined without a meeting token, and tokens are only ever
minted server-side *after* the existing permission checks pass. This means a
leaked room URL is worthless, and access to a webinar is exactly "whoever the
`events` RLS policy already says can see this event" — no second access-control
system to drift out of sync.

Also set `exp` on both room and token (end time + a grace window) with
`eject_at_token_exp`, so links die on their own instead of becoming permanent
open doors.

**Webinars are on Sundays.** One a week, on the Sunday that closes each cohort
week, named `Week N Webinar` (lib/webinar-schedule.ts). The scheduler at
`/admin/webinars` offers a list of upcoming Sundays rather than a free date
picker, and pre-fills the name from the pick; the full editor at `/admin/events`
is the escape hatch for anything else. Migration `0069` moved the existing
webinars onto that cadence.

### 4b. Webinars

**Migration** (`0058_hosted_events.sql`):

```sql
alter table public.events
  add column if not exists live_mode text not null default 'external'
    check (live_mode in ('external', 'hosted')),
  add column if not exists daily_room_name text,
  add column if not exists daily_room_url text;
```

`external` is the current behaviour (pasted `zoom_url`), so every existing row
keeps working untouched. `hosted` means batch0 owns the room.

**Admin** (`app/admin/events/`): a "Host on batch0" toggle next to the Zoom URL
field. On save with `live_mode = 'hosted'`, `saveEvent` calls `createRoom` with
`owner_only_broadcast: true` and stores the room name. `deleteEvent` deletes the
room too.

**Join route** — `app/dashboard/events/[id]/live/page.tsx`:

1. `requireUser()`, then read the event through the **RLS-scoped** client
   (`lib/supabase/server.ts`, not the admin client) — the existing `events read`
   policy is the gate, so a student who can't see the event gets a 404 for free.
2. Refuse to mint outside a join window (say, 15 min before `starts_at` until
   `ends_at` + 30 min) so tokens aren't issued for an event next month.
3. Mint a token: `isOwner: can(caps, "events.manage")`.
4. Pass only the token + room URL to a `"use client"` component that calls
   `DailyIframe.createFrame()`.

Because owners are the only ones with camera/mic under `owner_only_broadcast`,
the student experience is a clean watch-and-chat view with no extra UI work.

**Events page** (`app/dashboard/events/page.tsx`): when `live_mode === 'hosted'`,
"Join Zoom" becomes an internal link to `/dashboard/events/[id]/live` (styled as
live/starting-soon inside the join window). `app/api/events/[id]/ics/route.ts`
should emit the batch0 URL rather than `zoom_url` for hosted events, so calendar
reminders point at the site.

### 4c. Hiding the audience — required

**A student in a webinar must never be able to tell how many other people are
watching.** Turnout is the host's business, and a visibly thin room changes how
students behave in one. This is a product requirement, not a preference, so it
is enforced at three layers rather than styled at one.

**Layer 1 — the UI (done).** `canSeeRoster(role)` in `lib/live.ts` is the single
source of truth, and `CallStage` derives every roster-shaped affordance from it:
the header count, the participants button, and the people panel all disappear
for viewers. It is a function of the role with no override parameter, so no call
site can opt out by passing the wrong flag, and `lib/live.test.ts` asserts the
negative case and fails if a future `LiveRole` is added without a decision.

**Layer 2 — the server (to do).** Do not send a viewer the roster at all. Hiding
a list the client already holds is a CSS-deep guarantee: View Source defeats it.
The join route should shape its props by role — a viewer gets no `participants`
array, not an array it declines to render.

**Layer 3 — the provider (to do, and the one that actually binds).** The video
SDK has its own participant APIs, and they answer to the client, not to us. With
Daily:

- Mint **viewer tokens with `permissions: { hasPresence: false }`**. Hidden
  participants are absent from `participants()` for everyone else and cannot
  send media — so the roster genuinely is not delivered to other clients, rather
  than delivered and hidden.
- Set **`showParticipantsBar: false`** on Prebuilt, which is the supported
  companion to `owner_only_broadcast`.

**The honest caveat.** Even with all three, Daily's client-side
[`participantCounts()`](https://docs.daily.co/reference/daily-js/instance-methods/participant-counts)
returns `{ present, hidden }`, and a student who opens devtools can read the
hidden count. They cannot learn *who* is watching — `hasPresence: false` really
does withhold identities — but the aggregate number is reachable by someone who
goes looking.

If the count must be *unavailable* rather than merely unshown, the answer is not
a better flag, it is a different transport: broadcast the webinar as **HLS**, so
viewers receive a video stream and are never participants in a room at all.
There is no roster on the client because there is no room. The costs are real
and worth weighing before choosing it — roughly 10–30 seconds of latency, which
rules out live Q&A over video, and $0.03 per encoded minute on top of the call
itself.

Recommendation: ship layers 1–3, which defeat every non-technical student and
all identity disclosure. Revisit HLS only if the exact headcount leaking to
someone determined enough to open devtools is genuinely unacceptable.

**Announcing a headcount on purpose — opt-in (shipped).** The default above
hides turnout. `events.display_viewer_count` (migration 0071) is the deliberate
exception: an admin sets a number on the webinar — in the schedule form or the
event editor — and the room shows **that** figure to everyone, "43 watching", in
place of the hidden roster. It is a display value and nothing else: it gates no
access, mints into no token, and is re-sanitized on read by
`normalizeDisplayViewers`, so a number written straight into the row still can't
render a wall of digits into the header. `headcountLabel(role, displayCount,
realCount)` in `lib/live.ts` is where the default and the override meet, and the
room header reads through it: an announced count wins for everyone (a host
previewing the room sees exactly what the audience sees, and keeps the truth in
Prebuilt's participants bar); with no announced count the layer-1 default holds —
a host sees the real roster, a viewer sees nothing. This does not weaken layers
2–3: the *real* roster is still withheld from viewers by the server and the
provider. The announced number is independent of it — it can read higher or lower
than who is truly present, because that is the point.

**Questions go through server-backed Q&A, not Daily chat (shipped).** Hiding the
audience broke the assumption above that viewers ask questions in Daily's chat.
Daily Prebuilt only lets a hidden participant (`hasPresence: false`) *read* chat,
not send it — so a hidden webinar audience cannot ask a question through Daily
without being un-hidden, which would defeat layer 3. Rather than trade the
privacy guarantee for a chat box, questions now go through our own store:

- A new table, `public.webinar_questions` (migration `0060`), holds one row per
  question with the asker's id and the event id.
- Server actions in `app/dashboard/events/[id]/live/actions.ts` post and fetch
  questions.
- A panel, `components/live/qa-panel.tsx`, renders beside the Daily iframe and
  drives those actions, so Q&A lives in our UI instead of the provider's.

Room-level chat is now shaped by mode in `createRoom` (`lib/daily.ts`):
`enable_chat` is `false` for webinars (`mode === "webinar"`) and `true` for 1:1
meetings, where a hidden audience is not in play and Daily's own chat is fine.

The privacy property from layers 1–3 is preserved end to end. A viewer's
`fetchQuestions` returns only their *own* questions; the host (`events.manage`)
sees all of them. That is the same asymmetry as the roster — a student learns
nothing about who else is in the room, including who else is asking. RLS in
`0060` backstops the server actions so the split is enforced at the database, not
only in the action code.

### 4d. 1:1 calls

**New permission key.** Add to `PERMISSION_KEYS` and `PERMISSION_GROUPS` in
`lib/permissions.ts`:

```
"calls.invite"  — "Invite someone to a 1:1 call"
```

Grant it to the `mentor`, `investor`, and `admin` role rows. Because roles are
DB-driven (migration 0048), any custom role can be given it too — which is the
right answer to "mentors, investors, and admin" rather than hardcoding three
role slugs.

**Migration** (`0059_call_invites.sql`), sketch:

```sql
create table public.call_invites (
  id uuid primary key default gen_random_uuid(),
  host_id uuid not null references public.profiles(id) on delete cascade,
  invitee_id uuid not null references public.profiles(id) on delete cascade,
  starts_at timestamptz not null,
  duration_minutes int not null default 30,
  topic text,
  status text not null default 'invited'
    check (status in ('invited','accepted','declined','cancelled','completed')),
  daily_room_name text,
  daily_room_url text,
  recap text,                       -- mirrors mentor_bookings recap (0026)
  created_at timestamptz not null default now()
);
```

RLS: host or invitee may read; host may insert/update; invitee may update only
`status` (accept/decline). Staff-with-permission checks belong in the server
action via `assertPermission("calls.invite")` — RLS is the backstop, the action
is the gate, exactly as the rest of this codebase does it.

**UI**, one shared component rendered from three routes (the panels have
different layouts but identical needs):

- `/mentor/calls`, `/investor/calls`, `/admin/calls` — "Invite a student":
  person picker, datetime, duration, topic. Then a list of upcoming/past invites.
- `/dashboard/calls` — student's incoming invites, accept/decline, join button.
- Reuse the join route shape from webinars: `/dashboard/calls/[id]/live`, room
  created lazily on first join, both participants owners (it's a 1:1, both need
  camera and mic).

**On invite**, reuse existing plumbing rather than inventing any:
`notifyMany` (`lib/notifications.ts`), a new `Templates.callInvite` alongside
`eventReminder` in `lib/email/templates.ts`, an ICS endpoint modelled on the
events one, and nav entries in `lib/nav-config.ts` gated on `perm: "calls.invite"`.

Person-picker scope: mentors should probably see only their assigned students
(`mentor_assignments`, and note `lib/mentor-scope.ts` already exists for this);
investors probably only students on teams they've expressed interest in. **This
is the one product decision worth making deliberately** — an unscoped picker
means any investor can cold-invite any student, which is a safeguarding question
as much as a technical one.

---

## 5. Suggested order

Each step is shippable on its own.

1. Daily account + env vars + `lib/daily.ts` + a throwaway `/admin` smoke test
   that creates a room and joins it. Proves the whole integration in an hour.
2. Migration `0057` + admin toggle + `/dashboard/events/[id]/live` + events-page
   link. **Webinars done.**
3. Recording: enable `enable_recording: "cloud"` for owners; webhook →
   `events.recording_url`. The past-events "Watch recording" link already exists.
4. Permission key + migration `0059` + invite UI + student accept/join.
   **1:1 calls done.**
5. Polish: attendance rows from Daily webhooks, reminder emails via the existing
   queue (`lib/email/queue.ts`, already cron-driven in `vercel.json`), recap
   notes matching `mentor_bookings.recap`.

## 6. Open questions

- Should hosted webinars replace the Zoom field entirely, or coexist? (Plan
  assumes coexist — `live_mode` defaults to `external`.)
- Who can each role invite? (See scope note in 4d.)
- Do webinars need recording from day one, or is live-only enough to start?
- Should the existing office-hours `zoom_url` also become a hosted room? Same
  primitive, small extra step — worth folding in once step 1 works.
