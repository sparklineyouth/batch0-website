# Live video on batch0.org — webinars + 1:1 calls

> ## ⚠️ Superseded: webinars no longer run on Daily
>
> **Live video now runs on [batch0 Live](./batch0-live.md), a self-hosted
> WebRTC provider built into this repo.** Read that document first — this one
> is kept because its analysis of the problem is still accurate. The Daily
> path described below is history: the live pages no longer have a Daily
> branch, and `LIVE_PROVIDER` is no longer read.
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
> **There is no switch back to Daily** (see "Daily is gone" in
> [batch0-live.md](./batch0-live.md)). `npm run daily-doctor` and
> `lib/daily.ts` are unreferenced leftovers due for deletion.

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
| Office hours | `mentor_slots` + `mentor_bookings` (`0011_phase2_features.sql`) | Retired (0097): the pages are gone, the rows are read-only history. 1:1 calls and "Request a 1:1" replace them. |
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

**Scheduling.** Any day, any time: `/admin/events` → New event (title + time),
or "Start a webinar now". See docs/webinars.md.

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
source of truth for the headcount, and the room UI shows a count only when the
engine supplies one (`audienceCount`, null for viewers); the People tab is
offered to hosts only. It is a function of the role with no override parameter, so no call
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

**No announced headcount.** An admin-set "N watching" figure
(`events.display_viewer_count`, 0071) used to override the hidden roster; it
was removed. The column stays in the database, unread.

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
`fetchQuestions` returns only their *own* questions; staff (`events.manage`)
see all of them, and a guest speaker sees all of them with every student shown
as "A student". That is the same asymmetry as the roster — a student learns
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

RLS: the people on a call (and admins) may read. Nobody writes through the
API (0097): every write is a service-role server action that re-checks
`assertPermission("calls.invite")` or who is on the call.

**UI**, one shared component rendered from three routes (the panels have
different layouts but identical needs):

- `/mentor/calls`, `/investor/calls`, `/admin/calls` — "Invite a student":
  person picker, datetime, duration, topic. Then a list of upcoming/past invites.
- `/dashboard/calls` — the student's calls (Join; Decline until the start) and
  the "Request a 1:1" card. No accept step (docs/calls.md).
- Reuse the join route shape from webinars: `/dashboard/calls/[id]/live`,
  everyone on it a host (it's a 1:1, all need camera and mic).

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

#### Co-hosts: one student, any number of staff

A "1:1" is one student and a **staff side**: the host (`call_invites.host_id`,
whoever sent the invite) plus up to 20 more staff (`MAX_CALL_COHOSTS`) as
co-hosts — `call_invite_cohosts` (migration `0092_call_cohosts.sql`). The
student side is always exactly one person.

- **Adding people when booking.** "Also joining (optional)" on the invite
  form, and on the Confirm form in the call-request queue. `resolveCohosts`
  (lib/calls.ts) checks every pick holds `calls.invite` — by the capability,
  as `createInvite` checks the host, because a co-host's only way to the call
  is their calls list and every calls list requires it — before anything is
  written; the host and the student are dropped from the list, and a failed
  co-host write deletes the invite it belonged to. Both booking actions answer
  with an `ActionResult`, so these refusals reach the form as written in
  production. Co-hosts get an in-app notification linking to their own calls
  page; the student's email says who else is joining.
- **Adding people after booking.** **Add people** on a card in the staff
  side's own calls list, for as long as the call can still happen:
  `canAddCallCohosts` (lib/call-lifecycle.ts) allows an invite still waiting
  on its answer and an accepted call until its window closes, a live one
  included, and never a call that is over, cancelled, declined or expired. It
  opens the same `CohostPicker`, offering the team without anyone already on
  the call (`addableStaff` in `components/live/add-to-call.tsx`), and calls
  `addCallCohosts` (app/calls/actions.ts). Anyone on the staff side may add.
  The action checks that again, along with the phase, the role rule
  (`resolveCohosts`) and `MAX_CALL_COHOSTS` against the call's *total*
  (`cohostsToAdd`). It skips anyone already on the call (the insert is
  `on conflict do nothing`, so a double click, or two people adding the same
  mentor, ends in one row and no error) and audits `call_invite.cohosts_added`.
  The people added get the in-app notification, naming who added them when it
  wasn't the host. The rest of the staff side is told who's joining, and so is
  **the student**, in-app: they always know who will be in the room before
  they find them there.
- **Admins joining any call.** `calls.join_any` ("Join any 1:1 call") lets its
  holder put *themselves* on any student's call, whoever booked it, from the
  "Booked by everyone else" list on `/admin/calls`. **Join call** shows once
  the room is open and adds you, then takes you straight into
  `/dashboard/calls/<id>/live`. **Add me** shows before that, and the call
  moves up into your own list. Each opens a short confirm saying what is
  about to happen before anything is written. It's the same `addCallCohosts`,
  so you join as an ordinary co-host: named on every card and in the room, the
  student told, and the audit row marked `via: "calls.join_any"`. Admins hold
  it through `*`; no migration grants it to any other role, and it sits
  outside the admin area (`NON_ADMIN_PERMISSIONS`), so ticking it for a role
  doesn't open `/admin` by itself. There is still no way into a call unseen.
  The room 404s anyone who isn't on the call, admins included, and joining is
  the only way on. Without `calls.join_any` the list stays read-only.
- **What a co-host can do.** Everything the host can on that call: see it on
  their `/mentor|investor|admin/calls` list, join and broadcast, End call for
  everyone, Cancel, add more people, download the `.ics`, and watch the
  recording. Every gate asks `isOnCall` / `isStaffOnCall` (lib/live.ts)
  instead of "host or invitee".
- **Ending it.** End call appears once the *other side* has been in the room
  (`isCallCounterpart`): for staff that is the student, so a host and a
  co-host waiting for a late student cannot complete a call that never
  happened. With co-hosts it is a two-step "End for everyone", as a webinar's
  is; a plain 1:1 keeps the one press.
- **The room** is a small mesh: `joinRoom` hands each person everyone else on
  the invite as known peers, and `shouldOffer`'s id comparison decides who
  dials whom. Someone added while the call is running is picked up within one
  heartbeat (12 s), and usually at once, because their own `host-online` makes
  everyone re-announce. A call's `announcePresence` answers with the roster as
  well as the status (`PresenceResult.call`: everyone but the caller, built by
  the same helper as the join's peers, and the staff side in `callStaffIds`
  order). The engine dials anyone it hadn't heard of (`mergeCallPeers` in
  lib/call-roster.ts), with `shouldOffer` still picking the side that offers,
  so glare stays impossible. The room reads the staff side from the same
  answer (`callStaffIds` on the session, falling back to the list the page
  rendered), so a newcomer counts in the recorder election, as the student's
  counterpart for End call, and in End call's confirm.
- **RLS.** Co-hosts can read and update their `call_invites` rows; the join
  table is readable by admins and anyone on the call, and has no write
  policies (service-role server actions write it). Both policies go through
  security-definer predicates (`is_call_cohost`, `is_call_participant`) so the
  two tables never recurse into each other's policies;
  `npm run test:call-cohosts-db` runs the real migrations in PGlite as each
  kind of user.
- **Before 0092 is applied** every read falls back to the pre-co-host query
  (no co-hosts), so existing calls keep working, and an invite that names
  co-hosts is refused with a sentence before anything is written. So are Add
  people and an admin's Join call, with a sentence of their own: a call keeps
  the people it was booked with until 0092 is in.
- **Known limits.**
  - **No removal.** Nobody can be taken off a call once they're on it: not by
    the host, not by an admin, not by themselves. Cancelling the call is the
    only undo, which is why both ways of adding say so before the click.
  - **Co-hosts hear in-app only.** The one email is the student's, sent when
    the call is booked. People added later, and the student's notice of who
    is now joining, are in-app notifications only.
  - **The limit counts the whole staff side.** `MAX_CALL_COHOSTS` (20) more
    besides the host, however many batches they were added in. It's an abuse
    guard, not a size to aim for: everyone's video goes to everyone, so each
    person's upstream grows with every face (see "Scale" in
    docs/batch0-live.md).

#### Booking, requests and lifecycle

Current behaviour (no accept step, Start call now, reschedule, Request a 1:1,
windows and the sweep) is in [docs/calls.md](calls.md).

#### Recording

A call's team (host and co-hosts — never the student) records it: the first of
them live starts a take automatically, and any of them has Record/Stop. One
browser at a time, under the server lease, records everyone in the call
composited and mixed; both people are told before they join, and everyone sees
REC. The people on the call and admins can watch it back under Past. See
[recording.md](recording.md).

The room itself is `/dashboard/calls/<id>/live` for everyone on the call,
including a mentor or investor host or co-host who otherwise never sees
`/dashboard`: middleware lets the live rooms (this one and the webinar room)
past the `student.dashboard` bounce (`isLiveRoomPath` in
`lib/dashboard-gate.ts`), the page 404s anyone who is not on the call, and the
dashboard layout renders bare chrome for a viewer without `student.dashboard`.

Leaving or ending never waits for the recording's upload: the room captures
the final part (milliseconds), stops the devices and shows the left/ended
screen, which says "keep this tab open" while the tab's unload prompt stays
armed until the last part lands. Only Rejoin, Back, and the trip back to
the calls list after your own End call wait for it (bounded at 90 seconds).
`endCall` revalidates nothing, so the room — and that screen — stays mounted
through the upload instead of being re-rendered into the static "This call
has ended" page.

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
