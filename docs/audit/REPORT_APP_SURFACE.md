# REPORT_APP_SURFACE.md — batch0 app-surface audit, 2026-07-14

The 2026-07-10 overhaul ([REPORT.md](REPORT.md)) audited the **marketing
surface**: `/`, `/program`, `/sponsors`, the legal pages. This pass covers what
that one didn't — the **authenticated app** (dashboard, admin, mentor,
investor), the **admin-editable data in the database**, and the **light/dark
theming** across both.

Companion: [NEEDED_FACTS.md](NEEDED_FACTS.md) (updated — #1, #2, #6 resolved).

---

## The headline: the repo said batch0, production said Sparkline Youth

**Every applicant was being asked "Why Sparkline Youth?" on the live
application form** — the dead brand, on the money path (application → $130).

The rebrand did its job in code: `lib/application-questions.ts` and the seed in
`0035_application_questions.sql` both said "Why batch0?". But 0035 seeds with
`on conflict (key) do nothing` — correct, since it must never clobber an
admin's edits, but it means **the seed only ever applies to a fresh database**.
Production already had the row, so it kept the pre-rebrand text. Code and
production silently diverged, and re-running the migration could never fix it.

> **Renaming a seed does not rename the data it already seeded.**
> Any future content change to 0035 needs a companion patch migration.

Fixed by [`0038_fix_application_questions_brand.sql`](../../supabase/migrations/0038_fix_application_questions_brand.sql),
which patches the two stale fields *only when they still hold the exact stale
strings*, so a deliberate admin edit is never overwritten. Applied to
production 2026-07-14; the pre-change value was backed up first.

A full scan of every text column in `cohorts`, `challenges`, `announcements`,
`resources`, `events`, `blog_posts`, `teams`, and `site_settings` found **no
other** stale-brand or stale-claim content.

## Claims the product couldn't back

The marketing pass eliminated fabricated claims from public pages; the same
class survived inside the dashboard, where only logged-in students see it.

| Claim | Reality | Resolution |
|---|---|---|
| "in four weeks" (dashboard hero) | Cohort runs Aug 17 → Oct 18 (~9 weeks) | Duration claim dropped (Rish confirmed ~9 weeks) |
| "these 4 weeks" (application placeholder) | same | Dropped, in code + seed + prod |
| "ship in 4 weeks" (reviewer scorecard) | same | → "ship within the cohort" |
| "a credit toward a 1:1 mentor session" (referral card) | No credit system exists in the schema; the word appears nowhere else in the codebase. **0 mentor accounts exist.** | Removed |
| "We'll fast-track their application" | No fast-track/priority mechanism in code or schema | **Kept, and now actually built** — see below |

### The fast-track, built

The referral card's remaining promise was still only a promise, so it's now a
feature. No schema change was needed — `applications.referral_code` has been
captured since migration 0005 (via `?ref=`, surviving the signup bounce through
localStorage); nothing had ever *read* it outside the leaderboard.

- **`lib/referrals.ts`** — two helpers, both extracted so the leaderboard and
  the applications queue share one implementation instead of two copies:
  - `resolveReferrersByCode()` maps codes → the students who own them
    (lowercases both sides, dedupes, tolerates a code whose account is gone).
  - `tallyApplicationsByReferralCode()` counts applications per code.
    Deliberately **unfiltered** by status/cohort — "how many has this student
    brought in, ever" shouldn't change when you filter the list to `submitted`.
  `computeReferralLeaderboard` now composes both rather than owning the join
  and the bucketing itself.
- **`/admin/applications`**
  - **"Referred first"** sort — partitions referred applications to the top
    (stable: Newest ordering is preserved within each half).
  - **"Referred" filter flag** — shows only applicants who arrived through a
    referral link, with a live count. Composes with the status pills, so
    "submitted + referred" is reachable.
  - **"Referred by"** column — badges each applicant with the referrer's
    *name*, not an opaque code.
  - **"Referrals"** column — how many applications that student has brought in,
    with a green `✓n` for how many reached paid/enrolled.
- **`/admin/applications/[id]`** — "Referred by (code)" showed a bare string
  like `a3f9k2`, which tells a reviewer nothing. It now reads
  **Fast-tracked · [Referrer Name] · code**, linking to the referrer's profile.

Note the two directions are easy to confuse and are deliberately distinct:
`applications.referral_code` is the code that brought an applicant **in**;
`profiles.referral_code` is the applicant's **own** code, the one they hand out.
The "Referred by" column reads the former, "Referrals" the latter.

The promise is now backed by the review queue itself: a referred applicant
visibly rises to the top of the list the reviewer works through.

**Param composition.** The three filters (`status`, `sort`, `referred`) all
route through a single `hrefWith()` builder. The page previously had separate
per-pill URL builders, which silently dropped each other's params the moment a
third one existed; verified that from `?status=draft&sort=score`, toggling
Referred yields `?status=draft&sort=score&referred=1`.

## The stale fallback that defeated its own purpose

`FALLBACK_COHORT` in `lib/site-config.ts` exists so a Supabase outage can't
show stale facts. It had drifted to the cohort's *original* dates
(Jul 30 → Sep 13) while the real row moved to Aug 17 → Oct 18 — so during an
outage it would have displayed dates **five weeks out of date**, which is
precisely what it exists to prevent. Now matches the row, carries
`applicationsCloseAt`, and is dated with a re-check instruction.

## Sidebar

The user's report was "the sidebar in the dashboard is weird." Four separate
defects, all confirmed in the browser before fixing:

1. **The current page could be invisible.** The admin nav is ~1110px of links
   in a ~533px scrollport. On `/admin/email/blast` the active item sat **341px
   below the visible area** and the nav never scrolled to it — you landed on a
   page whose nav entry you couldn't see. Now the nav scrolls its own
   scrollport (never `scrollIntoView`, which would yank the page) to bring the
   active item into view.
2. **Two items highlighted at once.** Active state was a bare
   `pathname.startsWith(href)`, so every ancestor lit up too:
   `/admin/mentors/match` marked both "Mentors" and "Mentor match" active — in
   two different groups — and put `aria-current="page"` on both, which is also
   an a11y violation (two "current" links). Same for
   `/admin/email` + `/admin/email/blast`. Now resolved by longest-matching
   href, boundary-aware (`href + "/"`), against the *unfiltered* groups so
   search can't change what's current. Fixed in both the desktop sidebar and
   the mobile drawer, which carried an identical copy of the bug.
3. **The scrollbar was invisible in light mode.** `.scrollbar-thin` hardcoded
   `rgba(255,255,255,0.18)` — a white thumb on the near-white (`#f7f7f5`)
   sidebar. Combined with (1), there was no affordance at all that half the nav
   was below the fold. Now derived from `--ink`, so it flips with the theme.
4. **Staff links looked permanently selected.** "Admin panel" / "View as" /
   "Staff" used `text-phosphor-ink` + `hover:bg-phosphor/10` — the *exact*
   active-state styling. Phosphor now means one thing only: *you are here*.
   The section label does the grouping.

Also unified: nav rows and footer controls shared no styling (`rounded-md`/
`py-1.5` vs `rounded-lg`/`py-2`), so the seam showed. One exported
`SIDEBAR_ROW` in `components/sidebar-nav.tsx` is now used by all four role
sidebars. As a side effect the student nav reclaimed the ~19px that had been
clipping "Settings" in half at 900px tall.

## Light / dark

Theming is two systems: CSS tokens (`--paper`/`--ink`/…) for the ~200 converted
files, plus a `.theme-light` compat layer overriding dark-authored literal
utilities in the 15 that were never converted. Diffing every dark-literal
utility *used* against every one *covered* found 4 real gaps:

- `bg-black/20` — rendered the admin application-questions cards as 20%-black
  panels on the white page. Added.
- `hover:border-white/40` — the cohort page's "About batch0" button lost its
  border on hover in light mode. Added.
- **`app/cohort/[slug]/page.tsx` had an inline `borderColor:
  rgba(255,255,255,0.1)`** duplicating the `border-white/10` class already on
  the element. Being inline, it outranked the light-mode override — a white
  border on a white page. Removed; the class does the job in both themes.
- `text-black` on `bg-phosphor` (error page, team page) → `text-on-phosphor`,
  the token the design system documents for exactly this.

Two dark literals are **deliberately** not mirrored (toggle knob, accent-fill
text) — now documented in `globals.css` so they don't get "completed" later.

A contrast walker run over `/`, `/program`, and `/cohort/[slug]` in both themes
reports **0 text/background pairs below 2:1**.

## Verification

- `npx tsc --noEmit` — clean.
- `npm run build` — compiled successfully, no errors or warnings.
- Sidebar fixes confirmed live in the browser at 1280×900 in both themes:
  active count 1 (was 2), active item scrolled into view, scrollbar thumb
  `rgba(20,20,20,0.25)` on light / `rgba(245,245,244,0.25)` on dark.
- `/apply` step 3 re-rendered from production data: label "Why batch0?",
  no "Sparkline", no "4 weeks".

## Not fixed — deliberate

- **`demo_day_date` is still null** (NEEDED_FACTS #3). The program page says
  "the last day of the cohort."
- **batch0.org has no SPF record.** Only a `google-site-verification` TXT.
  Inbound mail works (MX → `smtp.google.com`), so `hello@batch0.org` is a real,
  reachable address — unlike the impetusai.net black hole the last audit found.
  But flipping `RESEND_FROM` to batch0.org before SPF/DKIM are in place would
  hurt deliverability. Outbound still sends as sparklineyouth.org by design.
- **`active_cohort_id` / `active_cohort_name` are null** in `site_settings`.
  `/apply` falls back to the single existing cohort row, so this is currently
  harmless — but it becomes load-bearing the moment a second cohort exists.
  Pin it at /admin/settings before Cohort 2.
