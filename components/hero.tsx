import React from "react";
import { ThemedImage } from "@/components/themed-image";
import { HeroEntrance } from "@/components/hero-entrance";
import { smolderShade } from "@/components/smolder";

/**
 * The hero — the whole painting in the fold, with the NAME floating in
 * its pocket of open sky and the tagline as a quiet caption over the
 * park. Nothing else: no CTA, no facts line (both live in "the deal").
 *
 * Server markup IS the settled state (no-JS / reduced-motion see it
 * instantly); HeroEntrance assembles it once per visit. Every character
 * is a pre-rendered span so the entrance can reveal without any layout
 * shift, and the 0's blocks carry .px-cell so PixelField keeps the glyph
 * cursor-reactive after it settles — the one living element in the hero.
 */

// The wordmark zero, 8×14, drawn to sit as a LETTER rather than a badge.
//
// Measured against VT323 at 112px: a character advance is 45.9px (0.41em)
// and the cap height is 78.4px (0.70em). The previous 12-wide grid came
// out 67.2px — 46% wider than every other letter in "batch" — which is
// what made the 0 read as a glyph bolted onto the end of the word rather
// than the last letter of it. At 8 columns the width is 0.40em ≈ 44.8px,
// within a pixel of the advance. Height was already right and is
// unchanged, and the 2-block stem matches VT323's own stem weight.
const ZERO_ROWS = [
  "..####..",
  ".##..##.",
  "##....##",
  "##....##",
  "##....##",
  "##....##",
  "##....##",
  "##....##",
  "##....##",
  "##....##",
  "##....##",
  "##....##",
  ".##..##.",
  "..####..",
];
const ZERO_COLS = ZERO_ROWS[0].length;
// VT323's cap height is ~0.7em; 14 rows at 0.05em puts the glyph exactly at
// cap height (spec allows up to ~1.15× for presence), feet on the baseline.
const ZERO_BLOCK_EM = 0.05;

function HeroZero() {
  const cells: React.ReactNode[] = [];
  ZERO_ROWS.forEach((row, r) => {
    for (let c = 0; c < ZERO_COLS; c++) {
      if (row[c] !== "#") continue;
      const si = smolderShade(r, c, ZERO_ROWS.length, ZERO_COLS);
      cells.push(
        <span
          key={`${r}-${c}`}
          data-hz
          data-si={si}
          data-shade={`var(--smolder-${si})`}
          className="px-cell bg-phosphor-fill"
          data-base="amber"
          style={{
            gridColumn: c + 1,
            gridRow: r + 1,
            background: `var(--smolder-${si})`,
          }}
        />,
      );
    }
  });
  return (
    // The grid is ABSOLUTE inside a fixed-size inline-block. With no
    // in-flow children the wrapper's baseline is unambiguously its bottom
    // margin edge, so the glyph's feet sit ON the text baseline like a
    // letter — any in-flow grid would synthesize a baseline from its first
    // row and hang the 0 below the word.
    <span
      aria-hidden="true"
      className="relative mx-[0.015em] inline-block select-none align-baseline"
      style={{ width: `${ZERO_BLOCK_EM * ZERO_COLS}em`, height: `${ZERO_BLOCK_EM * ZERO_ROWS.length}em` }}
    >
      <span
        className="absolute inset-0 grid"
        style={{
          gridTemplateColumns: `repeat(${ZERO_COLS}, ${ZERO_BLOCK_EM}em)`,
          gridAutoRows: `${ZERO_BLOCK_EM}em`,
        }}
      >
        {cells}
      </span>
    </span>
  );
}

/** Pre-split text into per-character spans so the entrance reveals with
 *  visibility toggles — zero layout shift, and the settled markup is
 *  complete for no-JS/reduced-motion/crawlers. */
function Chars({ text, frag }: { text: string; frag: string }) {
  return (
    <span data-frag={frag}>
      {[...text].map((ch, i) => (
        <span key={i} data-ch>
          {ch === " " ? " " : ch}
        </span>
      ))}
    </span>
  );
}

/** The name in the sky: VT323 "batch" with the pixel-0 as its last
 *  letter, so the amber lands on the zero exactly as it does in the
 *  wordmark. Rendered as type rather than the masked logo.svg because
 *  that mask is a single colour and could not hold the amber 0. */
function SkyName() {
  return (
    <span className="hero-ink block whitespace-nowrap font-display leading-[0.8] text-[clamp(40px,8vw,112px)]">
      <Chars text="batch" frag="l" />
      <HeroZero />
    </span>
  );
}

export default function Hero() {
  return (
    // FULL SCREEN ON LANDING. The hero owns the whole first viewport —
    // you arrive inside the painting, not looking at a picture with page
    // showing underneath it. Any viewport narrower than the painting's
    // 1.777:1 is scaled by HEIGHT under object-cover, so the complete
    // vertical scene (sky → skyline → park → path → water → flowers)
    // still reads and only the left/right margins crop.
    <section className="relative h-[100svh] min-h-[560px] w-full overflow-hidden">
      {/* The chrome floats over this section; the sentinel spans the top
          quarter so <OverHeroChrome> turns opaque as soon as the visitor
          scrolls, before the lockup travels up under the nav. */}
      <div
        id="hero-sentinel"
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-[25vh]"
      />

      {/* object-CENTER, not object-top: with a box narrower than the
          painting's 1.777:1 the scale is driven by height, so the full
          vertical scene — sky, skyline, park, path, water, flowers — is
          always present and only the left/right margins ever crop.
          Decorative, so alt="". */}
      <ThemedImage
        night="/hero-night.png"
        day="/hero-day.png"
        alt=""
        fill
        priority
        sizes="100vw"
        className="object-cover object-center"
      />

      {/* NO SCRIM AND NO HALO. The colour flip alone carries the type:
          near-white on the night frame, charcoal on the day frame. A wash
          strong enough to help flattened the painting, and a glow behind
          pixel type read as haze around the very edges VT323 depends on. */}

      {/* THE NAME IN THE SKY.
          Both frames share one composition: tree canopy top-left, tall
          tower cluster right, horizon skyline below, and a clear pocket of
          sky between them running roughly x 27–75% / y 4–31% of the
          painting. The name is centred in that pocket — horizontally it
          lands within a couple of percent of dead centre, so it is simply
          centred — and at the smaller size it clears the canopy and the
          tower cluster with room either side. Vertically 23% breathes
          evenly between the nav above and the skyline below. */}
      <h1
        data-entrance-reveal
        className="absolute left-1/2 top-[23%] z-10 -translate-x-1/2 -translate-y-1/2"
      >
        <SkyName />
      </h1>

      {/* NOTHING ELSE LIVES HERE. The tagline used to sit bottom-left over
          the park and could not be made legible in the day frame with
          colour alone — that corner carries both deep shadow and blown
          highlight, so every ink collided with one end of the range. It
          moved to <Thesis/>, onto the solid page background. Solving it
          by removing it from the artwork rather than by stacking a scrim,
          a glow or a panel back on top of the painting. */}

      {/* SOFT PAINTERLY HANDOFF into the page. BOTH the height and the
          ramp are theme tokens, because the two frames need genuinely
          different treatments: the night frame's foreground is dark and
          swallows a tall band, the day frame's is the brightest part of
          the picture and the same band reads as fog eating the park.
          See --hero-fade / --hero-fade-h in globals.css.
          (PixelDissolve is still in the codebase for other seams.) */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 bottom-0"
        style={{ height: "var(--hero-fade-h)", background: "var(--hero-fade)" }}
      />

      <HeroEntrance />
    </section>
  );
}
