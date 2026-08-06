import React from "react";
import { ThemedImage } from "@/components/themed-image";
import { HeroEntrance } from "@/components/hero-entrance";
import { smolderShade } from "@/components/smolder";

/**
 * The hero — a painting taller than the fold, with two lines of type set
 * into its clear sky: the identifier and "one c0mpany", the pixel-0
 * sitting in the word as a letter. Nothing else. No CTA, no facts line
 * (both moved to "the deal"), no scroll cue.
 *
 * Server markup IS the settled state (no-JS / reduced-motion see it
 * instantly); HeroEntrance assembles it once per visit. Every character
 * is a pre-rendered span so the entrance can reveal without any layout
 * shift, and the 0's blocks carry .px-cell so PixelField keeps the glyph
 * cursor-reactive after it settles — the one living element in the hero.
 */

// The wordmark-family portrait zero, 12×14 — same blockiness as the
// icon set. Sized in em so it scales with the poster clamp.
const ZERO_ROWS = [
  "..########..",
  ".##......##.",
  "##........##",
  "##........##",
  "##........##",
  "##........##",
  "##........##",
  "##........##",
  "##........##",
  "##........##",
  "##........##",
  "##........##",
  ".##......##.",
  "..########..",
];
// VT323's cap height is ~0.7em; 14 rows at 0.05em puts the glyph exactly at
// cap height (spec allows up to ~1.15× for presence), feet on the baseline.
const ZERO_BLOCK_EM = 0.05;

function HeroZero() {
  const cells: React.ReactNode[] = [];
  ZERO_ROWS.forEach((row, r) => {
    for (let c = 0; c < 12; c++) {
      if (row[c] !== "#") continue;
      const si = smolderShade(r, c, ZERO_ROWS.length, 12);
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
      style={{ width: `${ZERO_BLOCK_EM * 12}em`, height: `${ZERO_BLOCK_EM * 14}em` }}
    >
      <span
        className="absolute inset-0 grid"
        style={{
          gridTemplateColumns: `repeat(12, ${ZERO_BLOCK_EM}em)`,
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

export default function Hero() {
  return (
    // TALLER THAN THE FOLD. The painting runs ~126svh, so a band of it
    // lives below the first screen: scrolling reveals more picture before
    // anything hands off, and that below-fold band is where the fade to
    // the page happens. The sentinel still measures from the top, so the
    // nav's transparent→solid switch is unaffected.
    <section className="relative h-[126svh] min-h-[820px] w-full overflow-hidden">
      {/* The chrome floats over this section; the sentinel spans the top
          quarter so <OverHeroChrome> turns opaque as soon as the visitor
          scrolls, before the lockup travels up under the nav. */}
      <div
        id="hero-sentinel"
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-[25vh]"
      />

      {/* The image IS the hero background — it replaces the pixel/star
          scatter that used to run here (<Sky zone="hero" />). The `close`
          zone in the closing poster is untouched. Decorative, so alt="".
          object-top keeps the sky (and the lockup's clear band) anchored
          while the extra height spills the foreground below the fold. */}
      <ThemedImage
        night="/hero-night.png"
        day="/hero-day.png"
        alt=""
        fill
        priority
        sizes="100vw"
        className="object-cover object-top"
      />

      {/* NO SCRIM. The type carries itself: .hero-ink flips colour with the
          theme and brings a halo in the opposite direction. A wash strong
          enough to do the same job also flattened the painting. */}

      {/* OFF-CENTRE, INTO THE CLEAR SKY.
          Both paintings share a layout: open sky upper-centre-left, a tall
          tower cluster down the right third, tree canopy in the top-left
          corner. Centred at poster scale the headline ran straight through
          those right-hand towers, so on md+ the lockup shifts left of
          centre and the type is capped smaller — it lands in flat sky and
          stops short of the towers in BOTH frames. Below md the towers sit
          low in the crop and there is no room to shift, so it recentres. */}
      <div className="relative z-10 mx-auto h-full max-w-[1100px] px-5 sm:px-6">
        <div className="flex flex-col items-center pt-[clamp(6.5rem,15vh,9.25rem)] text-center md:max-w-[62%] md:items-start md:pt-[clamp(7rem,16vh,10rem)] md:text-left">
          {/* 1 · identifier */}
          <p data-entrance-reveal className="t-small hero-ink-soft relative">
            a startup accelerator for high schoolers
          </p>

          {/* 2 · the one anchor headline. "nine weeks" and "yours." are
              gone; the pixel-0 sits in the word as a letter and is the
              hero's only amber. */}
          <h1 className="hero-ink relative mt-3 block whitespace-nowrap font-display text-[clamp(52px,11vw,132px)] leading-[0.9] md:mt-4">
            <Chars text="one c" frag="l" />
            <HeroZero />
            <Chars text="mpany" frag="r" />
          </h1>
        </div>
      </div>

      {/* SOFT PAINTERLY HANDOFF. The bottom of the taller image dissolves
          into the page over the below-fold band — a plain gradient to the
          page colour, no scatter and no band edge. --paper is already
          theme-reactive, so this is correct in both frames for free.
          (PixelDissolve is still in the codebase for other seams.) */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 bottom-0 h-[42vh]"
        style={{
          background:
            "linear-gradient(to bottom, rgb(var(--paper) / 0) 0%, rgb(var(--paper) / 0.18) 34%, rgb(var(--paper) / 0.55) 62%, rgb(var(--paper) / 0.88) 84%, rgb(var(--paper)) 100%)",
        }}
      />

      <HeroEntrance />
    </section>
  );
}
