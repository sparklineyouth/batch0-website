# REPORT.md — batch0 overhaul, 2026-07-10

A stranger's audit map: what was found, what shipped, what remains for Rish.
Companion docs: [SLOP_REPORT.md](SLOP_REPORT.md) (73 before-findings),
[TECH_AUDIT.md](TECH_AUDIT.md), [COPY_AUDIT.md](COPY_AUDIT.md) (full before-corpus +
rewrite deck), [DECISIONS.md](DECISIONS.md) (10 recorded decisions),
[NEEDED_FACTS.md](NEEDED_FACTS.md) (16 questions), [../../DESIGN.md](../../DESIGN.md) (tokens).

## Before / after

Screenshots: `docs/audit/before/` and `docs/audit/after/` — every public
route at 390 / 768 / 1440px, full page. Highlights:

| | Before | After |
|---|---|---|
| Look | Black + yellow glow, scroll-jacked voids, Aceternity 3D mock | White paper, ink Bricolage display, one yellow, Cohort Ledger |
| Mobile home height | 11,399px (with dead black regions) | ~6,900px, every section readable at 390px |
| Fonts | none loaded (system stack, zero decisions) | Bricolage Grotesque / Public Sans / IBM Plex Mono, next/font |
| Nav | 4 anchors + 2 CTAs + drawer | Program · Sponsors · FAQ + one Apply button |
| Pages | one-pager + /sponsors | + /program (week-by-week); Founders page deliberately skipped (D4 — zero real student content) |

## Slop findings → resolution

Phase 1 found **73** (15 CRITICAL / 35 MAJOR / 23 MINOR). Resolution by class:

- **Fabricated claims (all 15 CRITICALs)** — resolved by deletion or
  honest rewrite: fake dashboard persona ("Riya"), "investor network"
  (12 sites), mentor-team claims (0 mentors exist), "active Discord
  community", "100 vetted teen founders", "Most popular" badge,
  self-sponsorship framed as backing, invented Impetus stats,
  comparison-table "year-round", "4-week" vs real dates (now: real dates
  + "four one-week build sprints"). Zero invented facts remain; every
  number on the site renders from the cohorts/settings tables or is
  marked `TODO(RISH)`.
- **Visual tells** — Aceternity container-scroll, marquee, glow/pulse
  keyframes, phosphor-radial/grid backgrounds, glassmorphism, 12+ uppercase
  eyebrow kickers, icon-card grids, gradient logo: all deleted. The
  design system now has one accent, one shadow, radius ≤ 8px, one
  orchestrated animation (hero rise, reduced-motion aware).
- **Technical** — robots/sitemap/canonicals moved to the real host (www),
  `/program` added to sitemap, unique titles/descriptions per page,
  FAQPage + corrected Organization JSON-LD, real favicon set generated
  from the de-slopped logo, OG image redesigned to the token system.

## Adversarial verification (Phase 6)

Three independent reviewers re-ran the checklist against the redesign:
**23 findings (1 CRITICAL / 8 MAJOR / 14 MINOR) — all fixed**, including:

- **impetusai.net has no DNS — hello@impetusai.net bounces.** Every
  reference (legal pages, billing, sponsor form mailto, Resend reply-to
  default, JSON-LD) now uses the verified `batch0youth@gmail.com`;
  dead links removed. This also retro-explains the old site's silent
  "email us" black holes. (NEEDED_FACTS #6.)
- Invisible white-on-white "Last updated" lines on all three legal pages;
  vanishing hover on the login "Forgot password" link.
- Banned word "journey" in the login subhead.
- Em-dash density (~1/50 words) cut to ≤1 per section; nine "X, not Y"
  aphorisms culled to one ("Grants, not swag").
- Over-implication of a "batch0 team" → sessions attributed to Rish by
  name, with a name-before-you-pay promise.
- Competitor price figures removed from machine-readable FAQ JSON-LD
  (kept in pricing prose with a re-verify TODO).
- Navbar glass artifact, dead glow/motion tokens, off-scale radius,
  CTA-fallback inconsistency — cleaned.

Swap-test judge verdict: "this copy would not survive being pasted onto
SparkHub or Spark Teen — which is exactly the point." Remaining MINOR
swap-risks are the two `TODO(RISH)` answers (hours/week, receipts) that
need facts, not writing.

## Lighthouse (mobile, production build)

| Page | Perf | A11y | Best practices | SEO |
|---|---|---|---|---|
| / | 98 | 100 | 96 | 100 |
| /program | 98 | 100 | 96 | 100 |
| /sponsors | 98 | 100 | 96 | 100 |
| /terms | — | 100 | — | 100 |

Target ≥ 95 everywhere: met.

## Functional verification

- **Apply funnel, end to end (real submission):** signup → account
  created → 4-step application wizard → submit → redirect to
  `/dashboard/application` with success banner. Test rows deleted after.
- **Analytics:** `apply_click` fires on every Apply CTA (hero, navbar,
  navbar-mobile, sticky-mobile, final-cta, program-page);
  `application_submitted` fires exactly once on the success redirect
  (verified via the URL-flag cleanup). Vercel Analytics; the script 404s
  on localhost by design and resolves on Vercel.
- **Links:** all 15 internal links on 8 public pages crawl clean; zero
  `href="#"`.
- **Crawlers:** robots allows search + AI crawlers explicitly (D9);
  GPTBot/ClaudeBot/PerplexityBot verified 200 on production. The brief's
  "blocked crawler" report traced to **batch0youth.com not resolving**
  (NEEDED_FACTS #12), not robots.txt.

## Definition of done — checklist

- [x] Zero swap-test failures (two TODO-gated answers noted)
- [x] Zero fabricated facts — all numbers from DB or TODO(RISH)
- [x] Zero CRITICAL/MAJOR slop findings surviving adversarial re-audit
- [x] One accent (phosphor yellow + its dark-amber text variant)
- [x] One typeface pairing with written rationale (DESIGN.md)
- [x] Working Apply flow with tracking, verified by real submission
- [x] robots / sitemap / canonicals / meta / OG / favicon complete
- [x] Lighthouse ≥ 95 mobile, all four categories
- [x] REPORT.md + NEEDED_FACTS.md a stranger could audit
