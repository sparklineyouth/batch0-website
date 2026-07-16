import React from "react";
import type { SiteConfig } from "@/lib/site-config";
import { ApplyCta } from "@/components/apply-cta";
import { ZeroThread } from "@/components/zero-thread";
import { HeroEntrance } from "@/components/hero-entrance";
import { smolderShade } from "@/components/smolder";

const WEEK_WORDS = [
  "zero", "one", "two", "three", "four", "five", "six",
  "seven", "eight", "nine", "ten", "eleven", "twelve",
];

/**
 * The hero — a centered knockout-zero lockup. Five elements on one center
 * axis: identifier · the sentence ("nine weeks" head / "one c0mpany" at
 * poster scale with the pixel-0 sitting IN the word as a letter / "yours."
 * head, amber) · facts line · button + # comment. The pixel-0 is the
 * hero's only amber besides "yours.", the 0% and the $0.
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

export default function Hero({
  config,
  authedHome,
}: {
  config: SiteConfig;
  /** Signed-in visitors get their role home instead of the apply pitch. */
  authedHome?: string | null;
}) {
  const { derived, settings } = config;
  const isAuthed = !!authedHome;
  const cohortLabel = derived.cohortLabel || "the next cohort";

  const start = config.cohort?.startsOn;
  const end = config.cohort?.endsOn;
  const weeks =
    start && end
      ? Math.max(1, Math.round((Date.parse(end) - Date.parse(start)) / (7 * 864e5)))
      : 9;
  const weeksWord = WEEK_WORDS[weeks] ?? String(weeks);

  const closeLabel = config.cohort?.applicationsCloseAt
    ? new Date(config.cohort.applicationsCloseAt)
        .toLocaleDateString("en-US", { month: "short", day: "numeric" })
        .toLowerCase()
    : null;

  return (
    <section className="flex min-h-[calc(100svh-6rem)] flex-col items-center justify-center py-10 text-center md:py-12">
      {/* 1 · identifier (dim; the hero's amber belongs to the 0) */}
      <p data-entrance-reveal className="t-small text-ink-soft">
        batch0 · a startup accelerator for high schoolers{" "}
        <span className="aside-note ml-2">previously sparkline youth</span>
      </p>

      {/* 2 · the sentence — one centered lockup, the pixel-0 in the word */}
      <h1 className="my-4 flex grow flex-col items-center justify-center">
        <span className="t-head block text-ink-soft">
          <Chars text={`${weeksWord} weeks`} frag="top" />
        </span>
        <span className="block whitespace-nowrap font-display text-[clamp(52px,15vw,190px)] leading-[1] text-ink">
          <Chars text="one c" frag="l" />
          <HeroZero />
          <Chars text="mpany" frag="r" />
        </span>
        <span className="t-head mt-2 block text-phosphor">
          <Chars text="yours." frag="bottom" />
          <span aria-hidden data-typeon-cursor className="cursor-block" />
        </span>
      </h1>

      {/* 3+4+5 · facts, button, # comment — fade up last, space reserved */}
      <div data-entrance-reveal>
        <p className="t-small text-ink-soft">
          {closeLabel && settings.applicationsOpen && <>apply by {closeLabel} · </>}
          {derived.priceLabel} only if accepted ·{" "}
          <ZeroThread>0% equity</ZeroThread>
        </p>
        <div className="mt-5 flex flex-wrap items-center justify-center gap-4">
          {isAuthed ? (
            <a
              href={authedHome!}
              className="press inline-flex items-center justify-center bg-phosphor-fill px-5 py-3.5 text-[15px] font-semibold lowercase text-on-phosphor hover:bg-phosphor-fill-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-phosphor focus-visible:ring-offset-2 focus-visible:ring-offset-paper"
            >
              go to dashboard
            </a>
          ) : (
            <ApplyCta
              label={`apply for cohort ${String(config.cohort?.cohortNumber ?? 1).padStart(3, "0")}`}
              location="hero"
            />
          )}
          <span className="aside-note">
            <ZeroThread>$0 to apply</ZeroThread>
          </span>
        </div>
      </div>

      <HeroEntrance />
    </section>
  );
}
