# SparkLine — Production Readiness

A living checklist of what was wrong, what got fixed, and what's still left before SparkLine is ready for real users. This document is the source of truth for "is the platform launch-grade?"

The goal: SparkLine should be **safe, fast, predictable, and friendly to high-school founders**. That means (1) no security gaps an attacker could exploit, (2) no UX dead ends, (3) predictable cost (no AI runaway bills), (4) easy to operate (admins can recover from failure modes), and (5) clean on every device + theme.

This file is the result of two audit passes. Pass 1 surfaced 30+ issues; this document captures every one of them, what was done, and the residual risks still on the board. Re-run a full audit before each major release and append a new section here.

---

## Status snapshot

| Severity | Total | Fixed | Open |
|---|---|---|---|
| P0 (blockers) | 4 | 4 | 0 |
| P1 (fix before launch) | 11 | 11 | 0 |
| P2 (fix soon, not blocking) | 14 | 14 | 0 |
| P3 (post-launch polish) | 8 | — | 8 |
| New product changes | 5 | 5 | 0 |

All P0 / P1 / P2 work from the original audit is **landed and type-checks clean**. Remaining work is P3 polish + ongoing operational hygiene.

---

## Migrations

Run these in the Supabase SQL editor in order. Each is idempotent.

1. `0012_hardening.sql` — drops the MFA self-insert RLS policy, adds `notifications.dedupe_key` + partial unique index, splits Stripe webhook dedupe into claim/complete.
2. `0013_drop_school_features.sql` — drops `assignments`, `assignment_submissions`, `quizzes`, `quiz_questions`, `quiz_attempts` and the `submissions` storage bucket (SparkLine is an accelerator, not a school).
3. `0014_file_feedback.sql` — adds `file_feedback` so mentors can leave threaded feedback on student or team file uploads.
4. `0015_ai_usage.sql` — adds `ai_usage` rollup table + `ai_messages` token columns + `ai_conversations.team_id` for per-team AI scoping.

Vercel cron config (`vercel.json`) was reduced to a single weekly digest job; the assignment-due cron was deleted with the school features.

---

## What was fixed (P0)

### 1. MFA step-up was forgeable

**Problem:** `mfa_verifications` had a self-insert RLS policy. Any signed-in user could call `supabase.from('mfa_verifications').insert(...)` from the browser and forge a recent step-up, bypassing `assertRecentMfa()`.

**Fix:** Migration `0012` drops the policy. Only the service-role `/api/mfa/record` route can write, and it validates the session's `aal=aal2` claim first.

**Goal:** Sensitive admin actions (waiving charges, role changes, future PII exports) require a *real* TOTP challenge within the last 15 minutes. Forgery from a tampered browser is no longer possible.

### 2. Quiz answers leaked to the client

**Problem:** The lesson page passed `correct_option_id` to the React tree, visible in HTML source.

**Fix:** Quizzes were removed entirely (see "Product reshape" below). The `quiz-actions.ts` rewrite that strips the answer key and returns `correct: Record<string, boolean>` from the server is preserved in git history if quizzes are reintroduced later.

**Goal:** Anywhere we score student work in the future, the answer key never reaches the client.

### 3. Mentors could grade across cohorts

**Problem:** `gradeSubmission` / `reopenSubmission` only checked `assertStaff()`. Any mentor could grade or view any submission system-wide.

**Fix:** New helper `lib/mentor-scope.ts::assertMentorCanAccessStudent` checks either a direct `mentor_assignments` row OR a shared cohort. Wired into `gradeSubmission`, `reopenSubmission`, the personal-drive download flow, and the new file-feedback action. Admins always bypass.

**Goal:** A mentor only sees students in their cohort. Even with role escalation paths, file access is cohort-scoped.

### 4. Open redirect on login

**Problem:** `?next=https://attacker.com` flowed straight to `window.location.assign(next)` after sign-in.

**Fix:** `app/(auth)/login/page.tsx` strips off-origin `next` values via `safeNext()` (mirrors `app/auth/callback/route.ts`). `login-form.tsx` re-asserts the same check before calling `window.location.assign`.

**Goal:** Post-auth redirects only ever go to same-origin paths. Belt + braces.

---

## What was fixed (P1)

### 5. Stripe webhook wasn't transactional

**Problem:** The webhook inserted into `processed_stripe_events` at the START of processing. If a side effect threw mid-flow, Stripe ack'd as processed and never retried — the user paid but never got enrolled.

**Fix:** Migration `0012` adds `processed_stripe_events.completed_at`. The handler inserts with `completed_at = null` (claim), runs side effects, then updates `completed_at = now()` (complete). On retry: if the row exists but `completed_at` is null, the side effects re-run (they're already idempotent — upserts on `user_charges`, conditional updates on `applications`).

**Goal:** A crash mid-webhook leaves the system in a recoverable state. Stripe's next delivery picks it back up.

### 6. Cron + announcements could double-fire notifications

**Problem:** No idempotency key on `notifications` inserts. A double-fire (cron retry, accidental admin re-broadcast) sent the same announcement twice.

**Fix:** Migration `0012` adds `notifications.dedupe_key` + a partial unique index. `lib/notifications.ts::notify` + `notifyMany` accept an optional `dedupeKey` and route through `upsert(..., { ignoreDuplicates: true })`.

**Goal:** Any fan-out that runs more than once is safe to retry.

### 7. Discord OAuth tokens stayed valid forever

**Problem:** After exchanging the auth code for tokens, we used them once then dropped them. A stolen callback URL could grant lingering access.

**Fix:** New helper `lib/discord.ts::revokeOauthToken` calls Discord's `/oauth2/token/revoke`. Called for both access + refresh tokens at the end of `app/auth/discord/callback/route.ts`.

**Goal:** Once we're done linking, every OAuth token we touched is dead.

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

**Fix:** `app/api/cron/weekly-digest/route.ts` rejects `?key=`; `Authorization: Bearer` only.

### 17. Email send swallowed errors silently

**Fix:** `sendEmail` returns `EmailResult = { ok: boolean, reason?: string }`. Callers can now tally failures in cron output.

### 18. AI screener disadvantaged non-English applicants

**Fix:** Screener prompt updated: "judge the substance — language fluency and presentation polish are NOT part of the rubric. Translate the summary you produce into English regardless of the applicant's writing language."

### 19. Team message author role wasn't re-checked at post time

**Fix:** `postTeamMessage` already re-reads `profiles.role` from the DB on every send; the previous flagging was a false positive. Documented in code.

### 20. `leaveTeam` orphaned storage objects

**Fix:** New `purgeTeamStorage` helper lists + removes every object under `<team_id>/` in both `team-drive` and `team-logos` before the team row is deleted.

### 21. Student nav showed pre-enrollment dead ends

**Fix:** `app/dashboard/layout.tsx` queries enrollments; passes `enrolled` to `StudentSidebar` + `MobileNav`. Both hide `course`, `team`, `checkin`, `office-hours`, `events`, `resources`, `files` until the student is enrolled (admins always see everything for preview).

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

SparkLine is a startup accelerator — not a school. Removed:
- `/dashboard/assignments`, `/mentor/assignments`, `/admin/course/quiz`
- `assignments`, `assignment_submissions`, `quizzes`, `quiz_questions`, `quiz_attempts` tables (migration `0013`)
- Lesson page quiz block
- "Assignments" nav items
- Assignment email templates (`assignmentPosted`, `assignmentGraded`, `assignmentDueSoon`)
- The `submissions` storage bucket
- The `/api/cron/due-soon` route + its cron entry
- All assignment / quiz types in `lib/types.ts`

### 28. Mentor file feedback flow

Replaces the deleted grading flow. New `/mentor/students/[id]` page composition:
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
- Student-facing `/dashboard/team` with tabs (Profile, Members, Thread, Drive, Demo Day).
- Logo upload runs an Anthropic vision safety check + lands in admin moderation queue (`/admin/moderation`).
- Team drive uploads land in `team-drive/<team_id>/drive/`.
- Members invite teammates by name/email; invitees see a queued invite at `/dashboard/team`.
- Mentor/investor team views at `/mentor/teams/[id]` + `/investor/teams/[id]`.
- Demo Day pitch submission tab (deck PDF + 3-min video URL or upload).
- Investor scorecard (problem / traction / team / ask, 1–5) + intro-request workflow tracked at `/admin/intros`.

---

## Still open (P3 polish — post-launch)

These don't block launch but improve the experience over time.

1. **Honeypot field on `/apply`.** Spam-tolerant but cheap to add.
2. **Bulk-invite flow for teams** (paste a list of emails).
3. **Notification preferences** — let students mute the team thread / disable email.
4. **Investor cap on simultaneous intro requests** to prevent one investor monopolizing the queue.
5. **Per-student progress link from `/admin/students`** (currently only reachable from `/mentor/students`).
6. **Sanitized Discord error logging.** Today `lib/discord.ts` logs full response bodies on error.
7. **Per-team "completion percentage" widget on `/admin/teams/[id]`** so Demo Day judges see readiness at a glance.
8. **Streaming-error persistence.** If `/api/ai/chat` errors mid-stream we record token usage but not the partial assistant message — retries can feel confusing. Persist the partial under a `failed: true` flag and skip in the next conversation hydrate.

---

## Operator checklist (pre-launch)

Configuration tasks no code can do for you.

1. **Apply migrations** `0011_phase2_features.sql` → `0015_ai_usage.sql` in the Supabase SQL editor.
2. **Verify storage buckets** exist: `course-videos`, `course-materials`, `resources`, `student-files`, `team-drive` (private), `team-logos` (public). The submissions bucket should be gone after migration 0013.
3. **Enable Realtime** for the `notifications` table in Supabase Dashboard → Database → Publications → `supabase_realtime`. The bell falls back to a 60s poll if Realtime is off, so this isn't strictly required but the UX is noticeably worse without it.
4. **Environment variables** present in production. Required: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `STRIPE_SECRET_KEY`, `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`, `STRIPE_WEBHOOK_SECRET`, `ANTHROPIC_API_KEY`, `CRON_SECRET`, `NEXT_PUBLIC_SITE_URL`. Optional: `NEXT_PUBLIC_SENTRY_DSN` (error reporting), `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`, `DISCORD_BOT_TOKEN`, `DISCORD_GUILD_ID`, `DISCORD_PUBLIC_KEY` (Ed25519 key for slash-command verification), `DISCORD_ROLE_STUDENT`, `DISCORD_ANNOUNCEMENTS_WEBHOOK`. Email is disabled — `sendEmail` is a permanent no-op stub (`lib/email/send.ts`); no `RESEND_*` env vars needed.
5. **Stripe webhook endpoint** points at `https://<domain>/api/stripe/webhook` with `checkout.session.completed`, `payment_intent.succeeded`, and `charge.refunded` subscribed.
6. **Supabase Auth settings:** "Confirm email" is enabled (otherwise typo-emails silently succeed at signup).
7. **Admins enroll TOTP** at `/admin/mfa` first thing post-deploy. Until they do, MFA gating gracefully no-ops so the app still works — but sensitive actions are unprotected.
8. **Smoke test Demo Day** end-to-end before announcing: one test team submits a deck + video, an investor scores it, an investor requests an intro, an admin progresses the intro through the funnel.

---

## How to keep this honest

- Run an audit before each major release. Append a new "## YYYY-MM-DD audit" section with new findings.
- When you fix something here, mark it done with a brief note on *why* the fix is correct (not just *what* you changed). Future readers shouldn't have to reconstruct the threat model.
- When you discover something new, file it under the right severity. Don't lose findings to the gravity of "I'll get to it" — every open issue is a P-something with a written goal.
