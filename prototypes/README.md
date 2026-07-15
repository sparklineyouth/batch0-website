# Round 2 — Composition prototypes (current)

Color system fixed per Round 1 pick: **amber-chrome** (frames/labels/prompts
amber, readable content off-white). Round 2 diverges the BONES — no
headline-left/card-right hero, no centered-headline-plus-buttons anywhere.

- **round2-1.html — THE SESSION**: the homepage is one continuous terminal
  session. Boot-sequence hero (`$ batch0 --init` prints its output with
  aligned dotted-leader statuses), sections are command outputs in a single
  tty column with the prompts hanging into the gutter, apply CTAs are
  prompts waiting for input, nav is a fixed bottom tmux bar
  (`batch0 | 0:home* 1:program … | T−Nd · HH:MM`). Strains: scanability/
  scroll length, and the conceit must extend to every page or it collapses.
- **round2-2.html — THE BOARD**: departure-board manifest. Every section is
  full-width hairline rows on one fixed CODE | ENTRY | REMARKS grid; the hero
  is one giant row (001 / headline / BOARDING · T−Nd); amber marks divider
  and actionable (→ GATE) rows; sticky column header carries the live clock.
  390px re-forms each row into a designed two-line cell. Strains: long-form
  prose needs escape-hatch rows; the giant 001 carries the whole first
  impression.
- **round2-3.html — THE BROADSHEET**: poster composition. Enormous anchors
  (slashed pixel 0 bleeding off the right edge with the readout knocked out
  of its base, a giant $130, closing BE IN IT.) with dense colon-aligned
  smallprint packed in the counterspace. `overflow-x: clip` keeps the bleeds
  from creating sideways scroll. Strains: doesn't template — every new page
  needs art direction; long-form must fall back to plain reading columns.

Full theses + honest strain notes in each file's header comment. Renders:
`docs/design-audit/shots/r2-*` (gitignored, regenerable).

---

# Round 1 — Color-direction prototypes (superseded)

Three fully-styled static homepages exploring the amber-phosphor-terminal
reference (Ampex/IBM amber CRTs, neofetch). Open each file directly in a
browser — no build step. Fonts load from Google Fonts (VT323 + IBM Plex Mono);
offline they fall back to the system mono stack.

Shared across all three (the reference details):
- **Live status bar** — cohort code, dates, `APPLY BY AUG 10 · T−Nd · HH:MM:SS`
  ticking real time, hairline rule beneath.
- **Neofetch hero readout** — pixel-art 0 beside colon-aligned
  `COHORT: / RUNS: / FORMAT: / TUITION: / EQUITY: / APPLY BY:` rows; label
  column fixed-width so every colon lands on the same column.
- **Command headers** — `$ cat how-it-works.txt`, `$ ls -la ~/artifacts`,
  `$ whoami`, `$ man batch0`, `$ apply --cohort 001`.
- **Paths as nav** (`/program`, `/blog`, …), `$ apply` as the CTA verb.
- **Box-drawing** — `├─ └─` FAQ tree with `│` answer rail; B/C frame the
  readout with `┌ ┐` caps.
- **Block cursor** — blinks after the hero highlight and closes the footer
  (`connection to batch0 closed▮`); `steps()` blink, disabled under
  `prefers-reduced-motion`.
- **`ls -la` artifacts listing** — "What you leave with" as a file manifest,
  ending `drwx------ your-company/ — 100% yours`.
- **Terminal footer** — `$ logout · © 2026 Sparkline Youth LLC`.
- Facts everywhere: Aug 17 – Oct 18 · apply by Aug 10 · $130 · 0% equity.
- 390 px: status bar condenses (center segment hides), hero stacks, readout
  keeps its alignment, `ls` notes wrap under filenames.

No scanlines, no glow, no bezel, no gradients — in any direction.

## direction-a.html — READOUT (amber-restrained)
Off-white stays the ink; the terminal identity comes entirely from structure.
Amber only: CTA fill, the 0, focus rings, and ONE data highlight per screen
(APPLY BY AUG 10). The safest evolution of the current rule — if structure
can't carry the identity without color, the structure isn't good enough.

## direction-b.html — FULL PHOSPHOR (amber-forward)
Amber IS the ink, off-white flips to the emphasis role (the hero highlight
block, key values, hover states). Top **and** bottom (vim-style) status bars.
Contrast verified: #FFBB00 on #0c0c0d ≈ **11.5:1** (AAA, no size minimums);
secondary amber text must stay ≥ 62 % opacity (≈ 4.9:1 AA); the dimmer tier
is decorative-only. Blog **article bodies** would flip to off-white — long
reads in amber fatigue; all chrome stays phosphor.

## direction-c.html — AMBER CHROME (hybrid, recommended)
Role split like a real session: everything that frames (status bar, prompts,
nav paths, rules, ledger labels, step numbers, tree glyphs) is amber;
everything you read (headlines, body, data values) is off-white. B's
unmistakable phosphor hum with A's reading ergonomics; the one-amber-highlight
hero rule still holds because chrome ≠ highlight.

Full theses + per-direction /program·/apply·blog extension notes live in the
HTML comment atop each file. Reference renders: `docs/design-audit/shots/proto-*`
(gitignored, regenerable).
