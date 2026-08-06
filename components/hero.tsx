import React from "react";
import { ThemedImage } from "@/components/themed-image";
import type { SiteConfig } from "@/lib/site-config";
import { HeroEntrance } from "@/components/hero-entrance";
import { PixelDissolve } from "@/components/pixel-dissolve";
import { smolderShade } from "@/components/smolder";

const WEEK_WORDS = [
  "zero", "one", "two", "three", "four", "five", "six",
  "seven", "eight", "nine", "ten", "eleven", "twelve",
];

/**
 * The hero — full-bleed artwork with a knockout-zero lockup lifted into
 * the open sky above the skyline. Three elements on one centre axis:
 * identifier · the cascade ("nine weeks" / "one c0mpany" at poster scale
 * with the pixel-0 sitting IN the word as a letter / "yours.") · a quiet
 * scroll cue. No CTA and no facts line — the ask moved to "the deal", so
 * the image gets to be the whole first screen.
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

export default function Hero({ config }: { config: SiteConfig }) {
  const start = config.cohort?.startsOn;
  const end = config.cohort?.endsOn;
  const weeks =
    start && end
      ? Math.max(1, Math.round((Date.parse(end) - Date.parse(start)) / (7 * 864e5)))
      : 9;
  const weeksWord = WEEK_WORDS[weeks] ?? String(weeks);

  return (
    <section className="relative h-[100svh] min-h-[600px] w-full overflow-hidden">
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
          First consumer of <ThemedImage/>: night and day frames are both
          in the markup, CSS picks one before the first paint. */}
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

      <div className="relative z-10 mx-auto flex h-full max-w-[1100px] flex-col items-center px-5 text-center sm:px-6">
        {/* The lockup is lifted into the OPEN SKY band. Dead-centre put
            "mpany" straight through the lit towers in both frames; at this
            offset the type sits on flat sky and the skyline reads clean
            underneath it. The clamp keeps that relationship from 390 up. */}
        <div className="flex flex-col items-center pt-[clamp(6.75rem,17vh,10.5rem)]">
          {/* 1 · identifier — one line, no parenthetical */}
          <p data-entrance-reveal className="t-small hero-ink-soft relative">
            a startup accelerator for high schoolers
          </p>

          {/* 2 · the sentence — ONE cascade. Tight leading plus negative
              margins scaled to EACH line's own font-size (the head lines
              and the poster line are wildly different sizes, so a single
              em value would not close both gaps evenly). */}
          <h1 className="relative mt-4 flex flex-col items-center leading-[0.9]">
            <span className="t-head hero-ink-soft block leading-[0.9]">
              <Chars text={`${weeksWord} weeks`} frag="top" />
            </span>
            <span className="hero-ink -mt-[0.1em] block whitespace-nowrap font-display text-[clamp(52px,15vw,190px)] leading-[0.9]">
              <Chars text="one c" frag="l" />
              <HeroZero />
              <Chars text="mpany" frag="r" />
            </span>
            {/* "yours." keeps the amber — it is the accent's second beat
                after the pixel-0 — but takes the halo so it separates from
                the sky in the day frame, where burnt amber is weakest. */}
            <span className="t-head hero-halo -mt-[0.14em] block leading-[0.9] text-phosphor">
              <Chars text="yours." frag="bottom" />
              <span aria-hidden data-typeon-cursor className="cursor-block" />
            </span>
          </h1>
        </div>

        {/* 3 · the one quiet cue at the foot of the image. No CTA here —
            the ask lives in "the deal" now, one scroll down. */}
        <div
          data-entrance-reveal
          className="mt-auto pb-[max(8.5rem,calc(env(safe-area-inset-bottom)+8.5rem))]"
        >
          <span className="hero-ink-soft t-small inline-flex flex-col items-center gap-1 lowercase tracking-[0.14em]">
            scroll
            <span aria-hidden className="hero-scroll-cue">
              ↓
            </span>
          </span>
        </div>
      </div>

      {/* The seam into the page below. */}
      <PixelDissolve edge="bottom" height={112} seed={7} />

      <HeroEntrance />
    </section>
  );
}
