# batch0 — Production Readiness

A living checklist of what was wrong, what got fixed, and what's still left before batch0 is ready for real users. This document is the source of truth for "is the platform launch-grade?"

The goal: batch0 should be **safe, fast, predictable, and friendly to high-school founders**. That means (1) no security gaps an attacker could exploit, (2) no UX dead ends, (3) predictable cost (no AI runaway bills), (4) easy to operate (admins can recover from failure modes), and (5) clean on every device + theme.

This file is the result of two audit passes. Pass 1 surfaced 30+ issues; this document captures every one of them, what was done, and the residual risks still on the board. Re-run a full audit before each major release and append a new section here.

---

## Status snapshot

| Severity | Total | Fixed | Open |
|---|---|---|---|
| P0 (blockers) | 3 | 3 | 0 |
| P1 (fix before launch) | 11 | 11 | 0 |
| P2 (fix soon, not blocking) | 14 | 14 | 0 |
| P3 (post-launch polish) | 7 | 5 | 2 |
| New product changes | 5 | 5 | 0 |

All P0 / P1 / P2 work from the original audit is **landed and type-checks clean**. Of the P3 polish, five are done (one had already shipped) and two stay open, re-scoped — see the P3 section. The rest is ongoing operational hygiene.

---

## Migrations

Run every file in `supabase/migrations/` in the Supabase SQL editor, in order,
after the code deploys. Each is idempotent. The current release adds
**0093–0100**, with one exception to "after": 0095 and 0096 go in before the
deploy (without 0095 nothing records). Order, purpose and one verify query
each are in `docs/migrations-2026-10.md`. The app runs without them. `/admin` shows
`settings.manage` holders one line while it detects one missing (0093–0096 by
table and column, 0099–0100 by leftover permission keys); confirm 0097–0099's
policy changes with the doc's verify queries.

The list below is the original audit's batch, kept as history.

1. `0012_hardening.sql` — adds `notifications.dedupe_key` + partial unique index, splits Stripe webhook dedupe into claim/complete.
2. `0013_drop_school_features.sql` — drops `assignments`, `assignment_submissions`, `quizzes`, `quiz_questions`, `quiz_attempts` and the `submissions` storage bucket (batch0 is an accelerator, not a school).
3. `0014_file_feedback.sql` — adds `file_feedback` so mentors can leave threaded feedback on student or team file uploads. (Retired with in-app files by `0094_google_drive.sql`; the table is kept and nothing in the app uses it. Its staff write policy was left in place.)
4. `0015_ai_usage.sql` — adds `ai_usage` rollup table + `ai_messages` token columns + `ai_conversations.team_id` for per-team AI scoping.
5. `0030_drop_mfa.sql` — drops `mfa_verifications` and its policies. Two-factor auth has been removed from the product.

Crons are listed in `vercel.json`; the assignment-due cron was deleted with the school features.

---

## What was fixed (P0)

### 1. Quiz answers leaked to the client

**Problem:** The lesson page passed `correct_option_id` to the React tree, visible in HTML source.

**Fix:** Quizzes were removed entirely (see "Product reshape" below). The `quiz-actions.ts` rewrite that strips the answer key and returns `correct: Record<string, boolean>` from the server is preserved in git history if quizzes are reintroduced later.

**Goal:** Anywhere we score student work in the future, the answer key never reaches the client.

### 2. Mentors could grade across cohorts

**Problem:** `gradeSubmission` / `reopenSubmission` only checked `assertStaff()`. Any mentor could grade or view any submission system-wide.

**Fix:** New helper `lib/mentor-scope.ts::assertMentorCanAccessStudent` checks either a direct `mentor_assignments` row OR a shared cohort. Wired into `gradeSubmission`, `reopenSubmission`, and (until 0094 retired in-app files) the personal-drive download flow and the file-feedback action. Admins always bypass.

**Goal:** A mentor only sees students in their cohort. Even with role escalation paths, file access is cohort-scoped.

### 3. Open redirect on login

**Problem:** `?next=https://attacker.com` flowed straight to `window.location.assign(next)` after sign-in.

**Fix:** `app/(auth)/login/page.tsx` strips off-origin `next` values via `safeNext()` (mirrors `app/auth/callback/route.ts`). `login-form.tsx` re-asserts the same check before calling `window.location.assign`.

**Goal:** Post-auth redirects only ever go to same-origin paths. Belt + braces.

---

## What was fixed (P1)

### 5. Stripe webhook wasn't transactional

**Problem:** The webhook inserted into `processed_stripe_events` at the START of processing. If a side effect threw mid-flow, Stripe ack'd as processed and never retried — the user paid but never got enrolled.

**Fix:** Migration `0012` adds `processed_stripe_events.completed_at`. The handler inserts with `completed_at = null` (claim), runs side effects, then updates `completed_at = now()` (complete). On retry: if the row exists but `completed_at` is null, the side effects re-run (they're already idempotent — upserts on `user_charges`, conditional updates on `applications`).

(Two-factor / MFA was previously listed under hardening but has since been removed from the product — see migration `0030_drop_mfa.sql`.)

**Goal:** A crash mid-webhook leaves the system in a recoverable state. Stripe's next delivery picks it back up.

### 6. Cron + announcements could double-fire notifications

**Problem:** No idempotency key on `notifications` inserts. A double-fire (cron retry, accidental admin re-broadcast) sent the same announcement twice.

**Fix:** Migration `0012` adds `notifications.dedupe_key` + a partial unique index. `lib/notifications.ts::notify` + `notifyMany` accept an optional `dedupeKey` and route through `upsert(..., { ignoreDuplicates: true })`.

**Goal:** Any fan-out that runs more than once is safe to retry.

### 7. Discord OAuth tokens stayed valid forever

**Problem:** After exchanging the auth code for tokens, we used them once then dropped them. A stolen callback URL could grant lingering access.

**Fix:** New helper `lib/discord.ts::revokeOauthToken` calls Discord's `/oauth2/token/revoke`. Called for both access + refresh tokens at the end of `app/auth/discord/callback/route.ts`.

**Goal:** Once we're done linking, every OAuth token we touched is dead.

*Moot since migration 0101: the Discord integration (account linking included) was removed, and batch0 Chat replaced it.*

### 8. Lesson asset signed URLs lived 4 hours

**Problem:** Video + materials were signed for 4h. URLs leaked into HTML source / share history / server logs. A churned student who saved the URL kept access.

**Fix:** TTL dropped to 10 minutes (`SIGNED_URL_TTL = 60 * 10`). Lesson page is `force-dynamic` so every viewer gets a fresh URL on every load.

**Goal:** Stolen URLs go stale before they're useful.

### 9. `searchStudentsForInvite` was filter-injectable

**Problem:** `q` flowed directly into `.or("email.ilike.%${q}%,...")`. Special chars (`,`, `)`, `*`) could break the filter or expand the match set.

**Fix:** Strip everything outside `[a-zA-Z0-9@._\- ]` before interpolating. Emails and full names pass through unchanged.

**Goal:** No PostgREST filter injection. Safe for any user-controlled search input.

### 10. Discord slash commands had no rate limit

**Problem:** `/announce`, `/me`, `/cohort`, `/link` accepted unbounded calls. Spamming `/announce` would flood the announcements channel + notifications table.

**Fix:** `app/api/discord/interactions/route.ts` calls `checkRateLimit` per Discord user before dispatching — 5/min for `/announce`, 20/min for read-only commands.

**Goal:** Predictable cost ceiling on Discord traffic.

*Moot since migration 0101: the slash commands went with the rest of the Discord integration.*

### 11. Signout was CSRF-able

**Problem:** Signout was POST-only but had no origin/referer check. A hostile site embedding a form POST could log users out.

**Fix:** `app/auth/signout/route.ts` validates `Origin` or `Referer` matches our own origin; 403 otherwise.

**Goal:** Cross-origin form posts can't change auth state.

### 12. AI usage was unbilled

**Problem:** Anthropic costs flowed straight through to us. A spammy student could burn unlimited tokens for free.

**Fix:** Full overage flow:
- Migration `0015` adds `ai_usage` rollup + `ai_messages` token columns.
- `lib/ai/pricing.ts` defines monthly free tier (1.5M input / 300K output) and overage rates ($6/M input, $30/M output) and hard cap ($50).
- `lib/ai/usage.ts::applyUsage` rolls up token counts after each completion; if usage exits the free band it creates / updates a `pending` fee charge on `user_charges`.
- `app/api/ai/chat/route.ts` enforces the hard cap, trims history to 20 messages, scopes retrieval to the user's team (or the pinned `ai_conversations.team_id`), and streams a footer telling the user when their message crossed the free tier.
- A new `UsageMeter` widget on `/dashboard/ai` shows monthly usage + accrued overage.

**Goal:** Cost is bounded, transparent, and billed via the existing fees flow students already understand.

---

## What was fixed (P2)

### 13. SVG logos accepted (XSS surface)

**Fix:** `getTeamLogoUploadToken` no longer accepts `.svg`. Rasterized images only.

### 14. Rejected logos stayed publicly reachable

**Fix:** `rejectTeamLogo` derives the storage path from the public URL and `remove()`s the object alongside clearing `teams.logo_url`.

### 15. `saveDraftAction` had no rate limit

**Fix:** 30/min per user — fine for normal typing, blocks runaway autosaves and bots.

### 16. Cron secret accepted in query string

**Fix:** every `app/api/cron/*` route rejects `?key=`; `Authorization: Bearer` only.

### 17. Email send swallowed errors silently

**Fix:** `sendEmail` returns `EmailResult = { ok: boolean, reason?: string }`. Callers can now tally failures in cron output.

### 18. AI screener disadvantaged non-English applicants

**Fix:** Screener prompt updated: "judge the substance — language fluency and presentation polish are NOT part of the rubric. Translate the summary you produce into English regardless of the applicant's writing language."

### 19. Team message author role wasn't re-checked at post time

**Fix:** `postTeamMessage` already re-reads `profiles.role` from the DB on every send; the previous flagging was a false positive. Documented in code.

### 20. `leaveTeam` orphaned storage objects

**Fix:** New `purgeTeamStorage` helper lists + removes every object under `<team_id>/` in both `team-drive` and `team-logos` before the team row is deleted.

### 21. Student nav showed pre-enrollment dead ends

**Fix:** `app/dashboard/layout.tsx` passes the student's lifecycle to `StudentSidebar` + `MobileNav`. Since October 2026 both, and the installed app's More screen, call one predicate, `isStudentHrefVisible` in `lib/student-nav.ts`: enrolled-only routes stay hidden until enrollment, pre-cohort students see only what middleware allows, and no student sees more than 12 links (`lib/student-nav.test.ts`).

### 22. Lesson reply parent wasn't validated

**Fix:** `postLessonComment` confirms `parent.lesson_id === args.lessonId` before insert. RLS already blocked cross-cohort replies, but this rules out cross-lesson-same-cohort replies too.

### 23. `student_files` registration trusted client paths

**Fix:** `registerStudentFile` lists the storage bucket to verify the object exists at the claimed path before inserting the index row.

### 24. Team drive registration had the same gap

**Fix:** Same storage `list()` check added to `registerTeamDriveFile`.

### 25. Team thread had no rate limit

**Fix:** `postTeamMessage` calls `checkRateLimit` (10/min per user) so a spammy author can't flood a team thread.

### 26. Password reset already existed

**Status:** `/forgot-password` + `/reset` were already implemented when the audit landed. No change needed.

---

## Product reshape (per new requirements)

### 27. School-style features removed

(October 2026: weekly work came back as an assignment tracker on new tables, `course_assignments` and friends in `0093`; see `docs/assignments.md`. The list below is what 0013 removed.)

batch0 is a startup accelerator — not a school. Removed:
- `/dashboard/assignments`, `/mentor/assignments`, `/admin/course/quiz`
- `assignments`, `assignment_submissions`, `quizzes`, `quiz_questions`, `quiz_attempts` tables (migration `0013`)
- Lesson page quiz block
- "Assignments" nav items
- Assignment email templates (`assignmentPosted`, `assignmentGraded`, `assignmentDueSoon`)
- The `submissions` storage bucket
- The `/api/cron/due-soon` route + its cron entry
- All assignment / quiz types in `lib/types.ts`

### 28. Mentor file feedback flow

**Retired** with in-app files (Google Drive replaced them, migration `0094`; see `docs/google-drive.md`). Kept here as history.

Replaced the deleted grading flow. New `/mentor/students/[id]` page composition:
- "Files + feedback" panel listing the student's personal uploads.
- Pick a file → see prior mentor feedback + leave new feedback.
- Cohort-scoped via `assertMentorCanAccessStudent`.
- Backed by new `file_feedback` table (migration `0014`).

### 29. AI co-founder upgrade

Beyond the usage billing in P1 #12:
- **Per-team scoping:** `ai_conversations.team_id` pins a conversation to a team. Retrieval block in the system prompt includes team name, tagline, description, member count, demo-day status. Solo students fall back to no-team retrieval.
- **History trimming:** capped at 20 messages (was 40). Older context is captured in the retrieval block.
- **Prompt caching:** system prompt is marked `cache_control: ephemeral` so Anthropic caches it across messages in the session.
- **Token capture:** every completion records `input_tokens`, `output_tokens`, `cache_creation_tokens`, `cache_read_tokens` on `ai_messages` for later analysis.
- **Inline cost surfacing:** when a message crosses the free tier, the stream footer tells the user how much was added to their account.

### 30. Mobile + light-mode polish

- `app/layout.tsx` exports a `Viewport` with `viewportFit: "cover"` so iOS notch padding works; theme-color flips with system preference.
- `globals.css` adds safe-area helpers (`.pt-safe` etc.), `overflow-x: hidden` on the body to prevent horizontal scroll, `-webkit-text-size-adjust: 100%` to stop iOS zoom on focus.
- Tap-target floor: `min-height: 36px` on buttons / clickable labels under `(pointer: coarse)`.
- `Input` / `Textarea` / `Select` now use `text-base md:text-sm` — 16px on mobile (so iOS doesn't auto-zoom on focus), 14px on desktop.
- Light-mode overrides extended: status colors (emerald/red/amber/blue) now readable on white, brand-yellow surfaces dialed up for contrast, cards get a real white surface + hairline border + 1px shadow so they read as elevated objects, heavy dropdown shadows softened.

### 31. Notification system revamped (from earlier turn)

- Role-neutral route at `/notifications` — accessible to every role.
- Realtime subscription via Supabase channel — replaces the 60s poll (60s fallback retained).
- Bell + dropdown moved to every sidebar (admin/mentor/investor in addition to student) + the mobile nav.

### 32. Team system (from earlier turn)

Full implementation. The current shape:
- Student-facing `/dashboard/team` with tabs (Profile, Members, Drive, Demo Day). `?tab=drive` opens a tab directly.
- Logo upload runs an Anthropic vision safety check + lands in the logo review queue at the top of `/admin/teams`.
- Drive is the team's Google Drive folder + pinned Google links (`team_drive_links`, `docs/google-drive.md`). Older uploads in `team-drive/` and `student-files/` are download-only.
- Members invite teammates by name/email; invitees see a queued invite at `/dashboard/team`.
- Mentor/investor team views at `/mentor/teams/[id]` + `/investor/teams/[id]`.
- Demo Day pitch submission tab (deck link + video link).
- Investor scorecard (problem / traction / team / ask, 1–5) + intro-request workflow tracked at `/admin/intros`.

---

## 2026-10 revamp

Cut for focus: weekly check-ins (now assignments), in-app files and the team
drive (now Google Drive links), discussions, DMs and the chat dock, the team
thread, announcement reactions, lesson comments, office hours (now 1:1 calls),
Pulse, at-risk and cohort health, email metrics, the pricing calculator, mentor
matching, AI usage and the premiere webinar mode. Tables stay.

The app no longer writes to the tables of the retired check-in, file,
community (discussions, DMs, team thread, reactions, lesson comments) and
office-hours features, nor to `at_risk_interventions`. A few
are still read for display: older uploads as downloads, weeks 1-4 check-ins
with their feedback, and office hours booked before the cut. Two cut features
only lost their admin views, and their tables are still written by the
service role: `ai_usage` on every AI chat and pitch-coach call (the billing
rollup, `lib/ai/usage.ts`), and `email_events` by the Resend webhook
(`app/api/resend/webhook/route.ts`).

0093, 0094, 0097 and 0099 drop the client write policies on most retired
tables. Three are left: staff write on `file_feedback`, admin write on
`at_risk_interventions`, and an owner's delete on their own `student_files`
row.

Replaced in 0101: the Discord integration. batch0's community is batch0 Chat
at `/chat` (`docs/chat.md`) — #announcements (staff post), #general, #wins,
#help, a channel per cohort, a private channel per team, DMs and group DMs.
0101 drops the Discord profile and team columns, the `discord*` site
settings, the integration's tables (`discord_auto_*`, `oh_queue`,
`mentor_oncall`, `team_blockers`, `event_rsvps`) and removes `discord.manage`.
It is deliberately not turned into `chat.manage`, which opens reported DMs:
grant that at `/admin/roles` to whoever should run Chat (`*` admins already do).

Added: the assignment tracker, team Google Drive links, a built-in room for
webinars and 1:1 calls (screen share as the main stage, slide presenter, A/V
check, one primary host), one continuous recording per take, a one-form events
admin, and a 12-link student nav with a "Needs you" home. Every page touching a
new table or column renders an empty state until its migration runs
(`lib/schema-ready.ts`).

---

## 2026-10-17 — production error log pass

Every error group Vercel logged in the seven days to 2026-10-17, and what each one was.

- **`refresh_token_not_found` from middleware** (the two largest groups, plus one `[middleware] getClaims failed … 400` line per route). A visitor whose session ended elsewhere — signed out on another device, a revoked refresh token — arrives with the old cookie, and the page plus its prefetches and images each try the refresh. Nothing was broken: auth-js already expired the cookie on the response. But middleware logged it as an error, and auth-js logged it again itself, once per client listener. Fixed in `lib/supabase/middleware.ts` + `lib/stale-session.ts`: the codes that mean "this session is over" (`refresh_token_not_found`, `session_not_found`, `session_expired`, `user_not_found`) are treated as signed out, the cookie is expired on redirects too, and neither line is logged; every other auth failure (401/403, 5xx, refresh races, anything unrecognised) is logged exactly as before. auth-js's own line can only be stopped at the sink, so a filter drops that one call shape — a single argument that is an auth error with one of those codes — and passes everything else through. `lib/stale-session.test.ts` runs the real middleware with the real @supabase/ssr against a fake auth server; it fails on the old code.
- **`Error: That invite has already been answered.` (/dashboard/calls) and `Error: That time is in the past.` (/admin/calls).** Already fixed before this pass: both were last seen on the 2026-10-11 deployment, when those actions still threw into the error boundary. #334 (2026-10-12) moved booking (`createInvite`) onto `runAction`, and the revamp (#338, 2026-10-14) replaced `respondToInvite` — the accept step that threw the first message — with `declineInvite`, which returns its answer. What was left was quieter but the same problem: `runAction` logged every validation message at error level. Fixed in `lib/action-result.ts`: a rule saying no is now `refuse(…)`, which reaches the form the same way and is not logged; a real failure is still a thrown Error and still logged. Converted: the calls, interview-request and scholarship-call actions, and batch0 Chat's actions (slow mode alone would otherwise log an "error" per impatient poster).
- **`[action:reportDm] Tell us what's wrong so we can act on it.` (/admin/messages).** Logged on 2026-10-11, while the DM report queue still existed — and already as an inline answer: `[action:…]` is `runAction`'s log prefix, so the staff member saw the message on the form and the only fault was the error-level log line. The page is gone since the revamp (Chat replaced DMs in 0101), and `next.config.js` already forwards `/admin/messages` and `/admin/messages/<id>` to `/admin/support`. `lib/retired-routes.test.ts` now pins that forward, and checks that every retired admin and dashboard page forwards to a page that exists. Chat's own report validation (the same message, in `app/chat/actions.ts`) is a refusal now, so it can't come back as an error line.
- **`[cron/webinar-followups] candidate read failed Gateway Timeout` and `[blog] failed to load DB posts: Gateway Timeout`.** One Supabase gateway blip, not two query problems: both 504s landed within five seconds of each other (2026-10-15 21:00 UTC), each after about five seconds, against tables of 33 and 2 rows that already have the partial indexes their filters use (`events_pending_share_idx`, `blog_posts_published_idx`). The cron's read has `limit(20)`; the blog's reads every published row, which is two. Both already degrade correctly — the cron answers 200 and the next 15-minute run picks the webinar up (the claim stamp keeps that idempotent), and the homepage renders the committed posts without the database ones for that one request. No index, limit or migration was warranted, so none was added.

---

## Still open (P3 polish — post-launch)

These don't block launch but improve the experience over time. Re-checked on 2026-10-17 against the October 2026 revamp: five are done (one had already shipped), two stay open with a narrower scope.

1. **Honeypot field on `/apply` — done, on `/signup`.** `/apply` has been behind sign-in since the revamp (middleware sends a signed-out visitor to `/signup`), so a field there would only ever meet people who already have an account. The open door is `signUpAction`: it creates the account pre-confirmed and sends a welcome email, so a script filling the form costs a junk account and a message to whatever address it typed. The form now has a field no person can see or reach — visually clipped rather than `display:none`, out of the tab order and the accessibility tree, a meaningless name plus 1Password/LastPass ignore flags so autofill leaves it alone. A filled one is refused before anything is created or sent and logged at warn, without the address. Why this is the right size: it costs real people nothing and stops form-filling scripts. It does not stop someone calling the action directly; that needs a per-IP limit on signup (below). `lib/honeypot.ts`.
2. **Bulk-invite for teams — done.** The Team tab's "By email" box takes several addresses — one per line, comma- or semicolon-separated, or a To line pasted from an email client — up to four, since a team is five. `inviteStudentsByEmail` sends each through the existing single invite, so the size cap, the cohort check, the dedupe and the bell are unchanged, and answers per address in that address's own words. Why per-address answers rather than a throw: a thrown message is stripped in production, which is why even the single-email box used to show "Something went wrong" instead of "No batch0 account found for that email". `lib/team-invites.ts`.
3. **Notification preferences — still open, re-scoped.** Not a polish-sized change: there is no preference column, about two dozen files call `sendEmail` directly besides the automation queue, and nearly every email today is operational (call bookings, assignment reminders, receipts, support replies), so which of them a student may switch off is a product decision. Its own PR: a profiles column (migration), one gate in `sendEmail`/`sendTemplated` keyed on the template's category, and a Settings toggle. More urgent than the toggle: bulk sends and automations have no unsubscribe link at all (`footerExtra` in `lib/email/render.ts` is the only hook), and anything promotional needs one before it goes out at scale.
4. **Investor cap on simultaneous intro requests — done.** An investor can have at most five intros waiting on the team (`requested`); a slot frees the moment the team makes the intro or passes. Found and fixed alongside: the old upsert put an intro the team had already moved on (made, met, committed, passed) back to `requested` whenever it was submitted again from a second tab — so a made intro reappeared in the queue as new. Now a still-waiting request can be reworded (no second bell) and a progressed one is never reset. It is a soft cap (two requests in the same instant can both see four), which is fine for what it protects. `lib/intro-requests.ts`.
5. **Per-student progress link from `/admin/students` — already done.** Every row on `/admin/students` opens `/admin/students/[id]`, which has had the progress panel (`getStudentProgress`: course, flows, resources, where the student stopped) and a link to the `/admin/progress` roster since before the revamp. Nothing to add.
6. **Per-team completion on `/admin/teams/[id]` — done.** The page opens with a Readiness card: the share of released assignments the team's enrolled members have handed in, who is behind, and where the Demo Day deck, video and submission stand. It is cut from the cohort's completion matrix (summed over student × assignment pairs) rather than counted separately, so it can never disagree with `/admin/assignments`; a member outside the team's cohort is shown as not enrolled instead of dragging the number to zero. Investors don't see `/admin`, so this is for the staff judging readiness, which is where the decision is made anyway. `teamCompletion` in `lib/assignments.ts`.
7. **Streaming-error persistence for `/api/ai/chat` — still open, re-scoped; the safe part done.** The premise was half wrong: a reply that dies mid-stream records neither the partial text nor its token usage — usage is only accrued after a complete stream. Persisting the partial under a `failed` flag means a column, a migration and a guarded hydrate, and the hydrate-skip it proposes shows the student exactly the conversation they see today, so it buys an admin-side record rather than a better retry. Done instead: the failure is logged (it left no server trace at all), the student sees "The reply was cut off by an error on our side and wasn't saved. Send your message again." instead of the provider's raw error JSON, and a failure after the reply was saved no longer claims it was lost. Still open: counting the tokens a failed stream consumed toward the monthly quota, a small leak already bounded by the hourly chat limit.

Residual found while doing #1: `/signup` has no rate limit. `forgot-password` and the public support form already use `checkRateLimit` per IP; signup should too, with a ceiling generous enough for a classroom signing up together from one school network.

---

## Operator checklist (pre-launch)

Configuration tasks no code can do for you.

1. **Apply migrations**: every file in `supabase/migrations/` in order; for this release, `0093`–`0101` (`docs/migrations-2026-10.md`).
2. **Verify storage buckets** exist: `course-videos`, `course-materials`, `resources`, `recordings` (private, 0095), `student-files` and `team-drive` (private, read-only since 0094), `team-logos` (public). The submissions bucket should be gone after migration 0013.
3. **Enable Realtime** for the `notifications` table in Supabase Dashboard → Database → Publications → `supabase_realtime`. The bell falls back to a 60s poll if Realtime is off, so this isn't strictly required but the UX is noticeably worse without it.
4. **Environment variables** present in production. Required: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `STRIPE_SECRET_KEY`, `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`, `STRIPE_WEBHOOK_SECRET`, `ANTHROPIC_API_KEY`, `CRON_SECRET`, `NEXT_PUBLIC_SITE_URL`. Optional: `NEXT_PUBLIC_SENTRY_DSN` (error reporting), `RESEND_API_KEY` + `RESEND_FROM` (transactional email via Resend — without them, `sendEmail` no-ops in dev and logs `disabled` in prod). `SAFEGUARDING_CONTACT_EMAIL` (recommended: an adult outside the batch0 team that a student is pointed to when they report a chat conversation every moderator is part of; see docs/chat.md).
5. **Stripe webhook endpoint** points at `https://<domain>/api/stripe/webhook` with `checkout.session.completed`, `payment_intent.succeeded`, and `charge.refunded` subscribed.
6. **Supabase Auth settings:** "Confirm email" is enabled (otherwise typo-emails silently succeed at signup).
7. **Lock the Discord server, then retire the Discord app.** The integration is gone (0101): nothing kicks people from the server or strips their roles any more when they leave the program, change role or are deleted, and deleting the bot or the app removes no member, role or channel. So when the deploy goes live, post a pointer to `/chat`, then take away the student and mentor roles' (and `@everyone`'s) permission to view channels, or delete the server. Until it's locked, remove anyone you take out of the program from it by hand. Then delete the `DISCORD_*` environment variables from the deployment, and clear the Interactions Endpoint URL in the Discord developer portal (or delete the app) — `/api/discord/interactions` no longer exists. The community now lives in batch0 Chat.
8. **Smoke test Demo Day** end-to-end before announcing: one test team submits a deck link + video link, an investor scores it, an investor requests an intro, an admin progresses the intro through the funnel.

---

## How to keep this honest

- Run an audit before each major release. Append a new "## YYYY-MM-DD audit" section with new findings.
- When you fix something here, mark it done with a brief note on *why* the fix is correct (not just *what* you changed). Future readers shouldn't have to reconstruct the threat model.
- When you discover something new, file it under the right severity. Don't lose findings to the gravity of "I'll get to it" — every open issue is a P-something with a written goal.
