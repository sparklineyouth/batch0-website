# batch0 — Ultimate Design Audit

**Date:** 2026-07-14 · **Branch:** `test` · **Method:** 27 full-page + interaction
screenshots (12 public pages × desktop 1440 / mobile 390, plus mobile-nav-open,
FAQ-expanded, signup-focused) captured against the live dev server rendering its
production **fallback** content (Cohort 1, Aug 17 → Oct 18, apps close Aug 10,
$130 / $0-to-apply / 0% equity). 11 vision agents each owned one lens; a
challenger stress-tested all 33 recommendations against brand invariants, scope,
and the actual source; this synthesis resolves the conflicts.

**Tooling (committed):** `scripts/design-audit/capture-all.mjs`. Screenshots live
in `docs/design-audit/shots/` (gitignored, regenerable: run the dev server on
:3100, then `node scripts/design-audit/capture-all.mjs`).

---

## Scope & invariant reconciliation (read first)

This is a **UI/UX rework only** — no logic, data, routing, feature, or content
changes. The challenger confirmed several audit suggestions are really content/
owner decisions, not UI tasks; those are quarantined in "Owner follow-ups" below
and are **not** in the punch list.

**One standing contradiction to reconcile with the owner:** the shipped site
defaults to **light** (`:root` in globals.css is white paper) with a working
`next-themes` toggle. The rework brief says *flat black base, no light mode*.
Section 1 of the master plan (dark-only foundation) resolves this. Every design
finding below holds **regardless** of that decision — amber-as-text and the
mono ledger are wrong in both themes.

---

## Per-lens scores

| # | Lens | Score | One-line verdict |
|---|------|:---:|---|
| 1 | First impression | **4.0** | "What/who/next" mostly lands; challenges page is the exception. |
| 2 | Visual hierarchy | **3.0** | Amber does too many jobs, so it stops meaning "click here." |
| 3 | Typography & craft | **3.5** | Ledger+pixel pairing is strong; long-form and hero measure need work. |
| 4 | Spacing & rhythm | **3.0** | Orphaned right columns leave big dead gutters; one stray card. |
| 5 | Brand character | **3.0** | On-brand parts applied as a skin, not a system; type scale timid. |
| 6 | Conversion | **3.0** | Deadline under-surfaced; signup-before-apply friction. |
| 7 | Persona: 16-yo builder | **3.0** | Reads credible, but blog wall + empty challenges undercut it. |
| 8 | Persona: skeptical parent | **3.5** | Economics honesty is great; founder/entity trust is thin. |
| 9 | Mobile | **3.5** | Solid; ledger wraps at 390px and sticky CTA overlaps. |
| 10 | Motion & polish | **4.0** | Restraint is right; disclosure + focus affordances weak. |
| 11 | Competitive taste | **3.0** | Everything whispers at one volume; needs scale + rhythm. |

**Composite: ~3.3 / 5** — a genuinely good, on-brand foundation with a clear,
bounded set of high-leverage fixes. Not a rebuild.

---

## Consolidated PROTECT list (do not "improve" these)

Unanimous or near-unanimous across lenses — the rework must leave them intact:

1. **The amber last-word headline highlight** ("building", "Yours.", "Be in it.")
   — the signature move. Keep exactly **one** per hero; the fixes below exist
   largely to stop other elements from competing with it.
2. **The Cohort Ledger** — the dotted-leader, **mono** data-sheet (hero spec
   table + the "$130 once / EQUITY TAKEN none / HIDDEN FEES none" economics
   strip). The one truly art-directed device. Stays mono (see Kill list).
3. **Hero two-column baseline alignment** (headline stack vs. right ledger) —
   the strongest spacing moment on the site.
4. **"Who runs this" peer credibility** — two named 17-year-old founders who
   "read every application," and the honest "no glossy alumni stats yet."
5. **The plain-English, no-hype voice** and the no-equity / "your IP, your
   company" language.
6. **The signup mobile form** — full-bleed inputs, generous touch targets, CTA
   at natural thumb height.

---

## Punch list — challenger-vetted, ranked by impact ÷ effort

Every item below survived the challenger as **in-scope, on-brand, and real**
(false-premise and invariant-violating suggestions were cut — see below). Ordered
so the top items are the biggest wins for the least work.

| # | Fix | Impact | Effort | Files |
|---|-----|:---:|:---:|---|
| 1 | **Challenges empty state:** it's the only `rounded-2xl border bg-wash` **card on the entire site** and fails the 3-second test (reads broken). Drop the card chrome → hairline-topped text block matching the program page's Demo-Day treatment, with **one** amber "Apply for Cohort 1" button; cut the huge pre-footer void; fix the wasted mobile fold. No invented "next challenge" date. | High | Low | `app/challenges/page.tsx` |
| 2 | **De-amber the decoration:** the concrete offender is the **6× `border-t-2 border-phosphor`** deliverable card-tops. Convert to `border-line`. Reserve amber for CTA + one hero highlight + focus rings only. | Med-High | Low | `components/deliverables.tsx:47` |
| 3 | **Focus + disclosure affordances (a11y, corroborated by code audit):** give form inputs a 2px amber `focus-visible` ring **with offset** (sanctioned amber use, matches the hero CTA); bump the FAQ `+/−` glyph contrast/weight and add a `bg-wash` lift on the open `<details>` so the answer is anchored to its question. | Med | Low | `components/ui/input.tsx`, `app/admin/audit/page.tsx` inputs, `components/faq.tsx` |
| 4 | **Mobile ledger + sticky CTA:** below ~420px, stack ledger label/value and drop the dotted leader (values currently wrap and crowd the dots); reserve `padding-bottom ≈ 72px` on the page container so the sticky CTA never covers the closing ledger/FAQ; fix the **white-on-yellow** sticky sub-label (`text-ink/70` → `text-on-phosphor/70`, ~1.5:1 in dark). | Med | Low | `components/ledger.tsx`, `globals.css` `.ledger`, `components/sticky-mobile-cta.tsx` |
| 5 | **Blog index focal point:** ~130-row list with no CTA and no entry point. Add **one** amber "Apply for Cohort 1" CTA in the header band and give the newest post visual weight. (Date-rail/title-size asks from the type lens are already shipped — no-op.) | Med | Low-Med | `app/blog/page.tsx` |
| 6 | **Long-form typography:** blog-post body is a uniform mono wall — increase H2 size/air so sections become landmarks. | Med | Low | `globals.css` `.blog-prose` |
| 7 | **Orphaned right columns / dead gutters:** in pricing (`pl-6`, 5/7 split) and founder (4/8), the short left heading floats while the right column runs long, leaving ~400px dead gutters. Constrain the right block's max-width and baseline-align the left heading to the first right line. | Med | Med | `components/pricing.tsx`, `components/founder.tsx` |
| 8 | **Commit the hero grid:** program & sponsors heroes keep the home's two-column frame but the right column is empty (only the home hero has ledger data), so the fold reads lopsided. Drop those to a single confident column. | Med | Med | `app/program/page.tsx`, `app/sponsors/page.tsx` hero blocks |
| 9 | **Cap hero display measure:** VT323 headlines run too wide and float; cap the measure so they break in 2–3 confident lines and sit tighter against the amber highlight. | Low-Med | Low | `components/hero.tsx`, program hero |
| 10 | **Enforce the existing type scale** (don't invent one): the `display-1/2 · title · body · meta` tokens already exist but blog/challenges/program lean on near-uniform sizing. Apply the tokens consistently so heads out-rank body and meta labels dim back. Also fold in the **sponsors single-highlight** (highlight one word, not two). | Med | Med | blog/challenges/program surfaces, `components/pricing.tsx`/sponsors headline |

---

## What the challenger CUT (do not do these)

- **VT323 in the Cohort Ledger figures** — *outright kill.* DESIGN.md sets the
  ledger in mono deliberately because it's a data-sheet. Hard invariant.
- **Amber as text / extra amber in the hero** — a second amber eyebrow (L1), an
  amber deadline strip (L6), and three amber stat chips (L6) all violate
  "amber sparingly / one highlight per hero / phosphor never as text." The
  facts they'd add ($0 to apply, 0% equity, close date) are **already** in the
  hero subhead and the ledger.
- **"Ledger everywhere"** — forcing the deliverables/"ships" lists into
  dotted-leader rows dilutes the signature; those are title+body, not label→value.
- **False-premise fixes (already shipped):** ledger values are already
  `text-ink font-medium`; blog index already has a category/date/reading-time
  rail; the `applicationsCountdownLabel` already derives "close in N days"; the
  how-it-works numerals are already `text-ink-faint`.
- **Uniform-vs-varied section padding** was a lens-vs-lens conflict — resolved:
  keep the existing uniform `py-20 md:py-28`, create contrast through **internal
  grouping** (item 7), not by breaking the metronome.

## Owner follow-ups (content/feature — NOT part of the UI rework)

Flagged by the personas, genuinely valuable, but out of scope — surface to Rish:
blog volume (~130 SEO posts read as a content farm to teens); founder headshots +
LinkedIn/X and a "For parents" entity/state panel (existing `TODO(RISH)` in
`founder.tsx`); payment-safety copy at signup (don't assert an unverified "7-day"
refund — the refund policy is already linked); de-hyping "REAL company"/"chance
of funding!" and whether the parent-FAQ belongs on the homepage.

---

## Revised Section 3 (marketing polish) — execution order

Section 3 of the master rework plan is now the punch list above, sequenced into
reviewable commits (each: change → `tsc --noEmit` → re-screenshot the affected
page → diff summary for approval):

- **3a — Challenges page** (punch #1): kill the only card, hairline empty state +
  single amber CTA, fix desktop void and mobile fold.
- **3b — Amber discipline** (punch #2, #10-sponsors): deliverables card-tops →
  `border-line`; sponsors headline to one highlight.
- **3c — Affordances & a11y** (punch #3, #4): focus-visible rings, FAQ disclosure,
  mobile ledger stacking, sticky-CTA padding + sub-label contrast. (Merges the
  earlier code/a11y audit's HIGH sticky-CTA contrast finding.)
- **3d — Editorial** (punch #5, #6): blog index focal CTA + newest-post weight;
  blog-post H2 scale.
- **3e — Layout composition** (punch #7, #8, #9): orphaned columns, single-column
  program/sponsors heroes, hero measure cap.
- **3f — Type-scale enforcement** (punch #10): apply existing tokens consistently
  across blog/challenges/program.

These slot **after** Section 1 (dark-only foundation — which also absorbs the
code-audit visual HIGHs: `global-error.tsx` `#FFD300`→`#FFBB00`, `backdrop-blur`
surfaces, and the two heavy 30px dropshadows) and Section 2 (wordmark amber-0).
No design edits begin until this revised plan is approved.
