# DESIGN.md — batch0

Direction: **YC-plain confidence.** White page, near-black ink, one yellow,
dense specific text, almost nothing moves. The site should feel like a
sharp founder's term sheet with a highlighter on it — not a SaaS template.
Reference restraint: ycombinator.com (text density, zero decoration),
stripe.com (type contrast), linear.app (discipline). Reference ≠ copy.

## Color

| Token | Value | Use |
|---|---|---|
| `paper` | `#FFFFFF` | Page background. The only background. |
| `wash` | `#F7F7F5` | At most two quiet zones (pricing band, footer). Never boxes-in-boxes. |
| `ink` | `#141414` | Headlines, body, buttons-on-yellow. Never pure #000. |
| `ink-soft` | `#4A4A4A` | Secondary body text. |
| `ink-faint` | `#767676` | Captions, meta. AA on white (4.54:1). |
| `line` | `#E4E4E1` | 1px hairlines. The only border color. |
| `phosphor` | `#FFBB00` | THE accent. Fills only: primary CTA, highlight marks, focus rings. Always with `ink` text (≈11:1). Never as text on white. |
| `phosphor-ink` | `#8C6700` | The accent as text (links, live meta) — AA on white (5.2:1). Same hue family, darkened; not a second accent. |
| `error` | `#B42318` | Form errors only. |

No gradients. No shadows except one: `shadow-cta` = `0 1px 2px rgb(20 20 20 / 0.08)` on the primary button. No glow, no blur, no translucency.

## Type

One idea: **a terminal.** The logo is set in VT323, so the type system is
the logo's own voice rather than a face chosen next to it.

**Display: VT323** (Google). The DEC VT320 terminal face the batch0
wordmark is drawn in. Carries headlines, nav, the wordmark, and section
heads. Two hard constraints, enforced centrally by `.font-display` in
globals.css — do not fight them at the call site:
- **One weight (400).** `font-bold` has no real weight to reach for, so the
  browser fakes one and smears the pixels. `font-synthesis: none` refuses
  it. Build hierarchy with **size**, never weight.
- **No negative tracking.** It collides stems on a fixed pixel grid.
- VT323 is optically small for its em box: display sizes run ~15–20%
  larger than the proportional face they replaced.

**Body: IBM Plex Mono** (Google, 400/500/600). Same terminal DNA, but with
real weights, a readable lowercase, and a proper italic. Takes body copy,
long-form legal, and every dense product surface — VT323 at 16px over a
page of Terms is unreadable, and the dashboard needs weight to build
hierarchy. Bound to the Tailwind `sans` key, so `font-sans` and default
body text resolve to it.

Rationale in one line: *the wordmark's voice for display, the same voice
with a readable spine for everything you actually have to read.*

Scale (rem, desktop → mobile via clamp). Display rows carry no weight or
tracking column on purpose — VT323 has one weight, and `.font-display`
pins tracking; both are listed above as hard constraints:
- `display-1` hero: `clamp(3rem, 7.5vw, 5rem)` / leading 1.02
- `display-2` section: `clamp(2rem, 4vw, 2.875rem)` / 1.08
- `title` : 1.1875rem / 1.35 / 600
- `body` : 1rem / 1.65, measure 65–72ch, ink-soft for long runs
- `meta` : 0.8125rem mono / 1.5 (ledger, labels — replaces ALL uppercase-eyebrow patterns)
- Body links: `ink` with 2px `phosphor` underline (`text-decoration-color`), hover fills to highlight.

## Shape & depth
Radius: 6px on buttons/inputs, 0 elsewhere. Borders: 1px `line`, used only
where a boundary means something (table rows, FAQ dividers, input fields).
No cards. Sections are typography + whitespace separated by hairlines.

## Spacing & layout
4/8 scale. Content max-width **1100px**, gutters 20px mobile / 24px desktop.
Section rhythm: 96px mobile / 128px desktop between sections. Left-aligned
everything — no centered hero. Two-column at `md+` where a section has a
lede + detail (12-col grid, 4/8 split), single column below.

## Motion
Static by default. **One orchestrated moment:** on hero load, the headline
and the Cohort Ledger rows rise 8px and fade in, staggered ~70ms, once,
CSS-only. Nothing else animates except link/button hover color and the FAQ
disclosure. `prefers-reduced-motion` disables all of it. Deleted: marquee,
scroll-jacked sections, ping/pulse dots, glow keyframes, whileInView
reveals, hover-scale.

## Signature element — the Cohort Ledger
The one memorable thing, built only from true values: a mono-set,
dotted-leader ledger block that states the cohort like a filing —

```
COHORT 1 ······················ Summer 2026
DATES ····················· Jul 30 – Sep 13
FORMAT ················· live, online (US)
TUITION ······· $130 · charged only if accepted
EQUITY TAKEN ·························· none
APPLICATIONS ···· open — reviewed on a rolling basis
```

It appears full-size in the hero, and as a one-line strip above the final
CTA. Every row renders from `site-config` (live DB values), so it can never
drift from the truth. When Cohort 1 produces real artifacts, the same
treatment becomes the "cohort log" ("Wk 3 · first customer interviews
shipped") — the element is designed to grow into the proof engine.

## Imagery
None on v1, except: the real product screenshot (neutral data, no invented
students) if used on /program, and the founder's real receipts when Rish
supplies them. No AI stock, no 3D blobs, no decorative SVG backgrounds.
The OG image is typography on white with a yellow ledger rule — same system.

## Voice (summary; full rules in the brief)
Second person, plain verbs, numbers and dates over adjectives. Reads like a
sharp 18-year-old explaining the program to a friend. Every button says
what happens: **"Apply for Cohort 1"** — one name for one action, everywhere.
The hedge stays: funding is never guaranteed.
