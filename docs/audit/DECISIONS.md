# DECISIONS.md — SparkLine Youth overhaul

Decisions made where the brief, the codebase, or the facts pulled in different
directions. Each entry: what was decided, why, and what it overrode.

## D1 — Marketing surface goes light (white), keeping spark yellow
The codebase is dark-only on marketing (`bg-black`, glow effects). The brief
pins "YC-plain confidence": white background, near-black ink, one accent.
The existing brand hue `#FACC15` is not a purple-blue gradient, so per the
brief it stays — as the single accent. Yellow text on white fails WCAG AA
(≈1.6:1), so the accent system is: **#FACC15 fills with near-black text**
(buttons, highlight marks — ≈11:1) and **#8A6A00 (dark amber)** where the
accent must be text on white (links) at AA. The authenticated product app
(dashboard/admin/mentor/investor) keeps its existing dark theme — out of
scope; the funnel surface (marketing + auth pages) is what converts.

## D2 — Real data plumbing stays; hardcoded claims die
`lib/site-config.ts` already resolves the active cohort (dates, price,
capacity, spots, application close date) from the DB at request time. The
redesign keeps every dynamic value and deletes hardcoded claims that
contradict it. Verified live values (2026-07-10): Cohort 1 "Summer 2026",
Jul 30 → Sep 13 2026, $129.99 base (displays rounded "$130"; India override
$115), capacity 100, 0 enrolled, applications open, no close date set, no
demo-day date set.

## D3 — The "4-week" claim vs. the 6.5-week cohort window
Site copy says "4-week program" everywhere; the real cohort runs
Jul 30 → Sep 13 (6 weeks 3 days). The curriculum itself is authored as four
weeks (Validate / Build / Market / Pitch). Resolution: copy describes the
program as **four one-week build sprints** (true of the syllabus) and shows
the **real cohort dates** (true of the calendar), and never says "a 4-week
program" as a duration claim. The mismatch is logged as a CRITICAL question
in NEEDED_FACTS.md — either the dates include onboarding/buffer/demo-day
weeks (say so), or the cohort row needs correcting.

## D4 — "Founders" page skipped; honesty section instead
The brief's page map includes Founders/Projects "if content is thin, it's a
tight single section on Home instead, not a padded page." Content is not
thin — it is zero: 0 enrollments, 0 shipped student projects, 2 draft
applications. Home gets a "Who runs this" founder-credibility section
(Rish, Impetus AI LLC — the parent-trust asset) and the cohort-1 framing
("be a founding member"), not a fake proof wall. The signature element is
the honest **Cohort Ledger** (real dates/price/rules set in ledger rows),
per the brief's fallback: "the signature is the honest Cohort-1
countdown/deadline treatment."

## D5 — Apply stays the real gated flow; signup page becomes "step 1"
`/apply` requires an account (application rows belong to users; middleware
redirects logged-out visitors to `/signup?next=/apply`). Rather than build a
parallel fake public form, the Apply CTA keeps pointing at `/apply` and the
**signup page is reframed as "Apply — step 1: create your account"** with
the dates/criteria/what-happens-next content the brief wants on an Apply
page. The form the brief asks to verify end-to-end is the real one.

## D6 — Comparison table and "Problem" section folded into Pricing
The comparison table asserted competitor facts we can't stand behind
("LeanGap: investors — partial virtual"; "SparkLine: year-round" — false
with one cohort a year so far). The one persuasive, defensible fact —
serious programs cost $3,000–$8,000+ while SparkLine is $130 — moves into
the pricing section as one line (with a TODO to re-verify competitor
prices). The table and the generic "Youth entrepreneurship is broken"
essay section are cut.

## D7 — "Investor network" claims downgraded to what's verifiable
Copy claimed "our investor network — angels, scout funds, and pre-seed
VCs." The system has zero investor accounts and nothing verifiable behind
the phrase. Demo day is real (it's the program's design and the platform
has investor/demo-day features built). Rewritten copy promises what the
program controls: a live demo day where students pitch, sponsorship
decided by SparkLine (real, funded by Impetus AI), and intros **if and
when** investors are in the room — with named investors logged in
NEEDED_FACTS as the unlock for stronger copy. The existing "funding is
never guaranteed" hedge survives everywhere it appeared; it's the most
credible sentence on the old site.

## D8 — Fake dashboard persona removed
The scroll-jacked product mockup greeted a fabricated student ("Welcome,
Riya"). The product is real software, so the replacement is a real,
neutral screenshot ("Your dashboard") — or no imagery. No invented names
anywhere.

## D9 — robots.txt: allow AI crawlers, keep gated areas blocked
The brief's "live site refuses automated access" finding did not
reproduce: robots.txt allows `*` and GPTBot/ClaudeBot/PerplexityBot all
receive HTTP 200 (tested 2026-07-10). Likely cause of the external report:
**sparklineyouth.com does not resolve at all** (the brief's own URL). The
.org robots stays permissive, now with explicit AI-crawler allowance
documented; `/apply` stays disallowed (it's an auth redirect, not
content — the crawlable Apply story lives on / and /program).
sparklineyouth.com registration/redirect is a NEEDED_FACTS item for Rish.

## D10 — Price displays as "$130"
The charge is $129.99; `site-config` rounds display to "$130". Rounding
*up* by a cent is honest (no one gets charged more than the sticker).
Kept — one consistent number everywhere beats "$129.99" precision noise.
JSON-LD price corrected to the exact 129.99.
