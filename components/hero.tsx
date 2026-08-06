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

/** The name in the sky: VT323 "batch" with the pixel-0 as its last
 *  letter, so the amber lands on the zero exactly as it does in the
 *  wordmark. Rendered as type rather than the masked logo.svg because
 *  that mask is a single colour and could not hold the amber 0. */
function SkyName() {
  return (
    <span className="hero-ink block whitespace-nowrap font-display leading-[0.8] text-[clamp(58px,11.5vw,160px)]">
      <Chars text="batch" frag="l" />
      <HeroZero />
    </span>
  );
}

export default function Hero() {
  return (
    // THE WHOLE SCENE IN THE FOLD. The section takes the painting's own
    // 1672:941 aspect, so at desktop widths the image renders edge to edge
    // with NO crop at all — sky, skyline and the park foreground all read
    // without scrolling. (The previous object-top crop pushed the park
    // below the fold; that was the bug.) A min-height floor keeps the
    // hero from collapsing to a 219px letterbox on phones, where the
    // trade is a horizontal crop — vertical stays complete at any box
    // narrower than 1.777:1, so the foreground never gets cut.
    <section
      className="relative w-full overflow-hidden"
      style={{
        aspectRatio: "1672 / 941",
        minHeight: "clamp(560px, 74svh, 680px)",
        maxHeight: "100svh",
      }}
    >
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

      {/* NO SCRIM. The type carries itself: .hero-ink flips colour with the
          theme and brings a halo in the opposite direction. A wash strong
          enough to do the same job also flattened the painting. */}

      {/* THE NAME IN THE SKY.
          Both frames share one composition: tree canopy top-left, tall
          tower cluster right, horizon skyline below, and a clear pocket of
          sky between them running roughly x 27–75% / y 4–31% of the
          painting. The name is centred in that pocket — horizontally it
          lands at ~51% of the image, which is close enough to dead centre
          to just centre it, and vertically at 23% it breathes evenly
          between the nav above and the skyline below in BOTH frames. */}
      <h1
        data-entrance-reveal
        className="absolute left-1/2 top-[23%] z-10 -translate-x-1/2 -translate-y-1/2 md:left-[45.5%]"
      >
        <SkyName />
      </h1>

      {/* The tagline stays OUT of the sky pocket: bottom-left, over the
          park, where it reads as a caption to the scene rather than a
          second headline. Sits above the fade's strong end. */}
      <div className="pointer-events-none absolute inset-x-0 bottom-[13%] z-10">
        <div className="mx-auto max-w-[1100px] px-5 sm:px-6">
          <p
            data-entrance-reveal
            className="t-small hero-ink-soft max-w-[22ch] sm:max-w-none"
          >
            a startup accelerator for high schoolers
          </p>
        </div>
      </div>

      {/* SOFT PAINTERLY HANDOFF into the page — a plain gradient to the
          page colour, no scatter and no band edge. --paper is already
          theme-reactive, so this is correct in both frames for free.
          Sized as a PERCENTAGE of the hero, not vh: the hero is now the
          painting's own height, and the old 42vh band would have eaten
          the park the whole composition is built around.
          (PixelDissolve is still in the codebase for other seams.) */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 bottom-0 h-[26%]"
        style={{
          background:
            "linear-gradient(to bottom, rgb(var(--paper) / 0) 0%, rgb(var(--paper) / 0.10) 30%, rgb(var(--paper) / 0.42) 58%, rgb(var(--paper) / 0.84) 82%, rgb(var(--paper)) 100%)",
        }}
      />

      <HeroEntrance />
    </section>
  );
}
