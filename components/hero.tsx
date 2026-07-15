import React from "react";
import type { SiteConfig } from "@/lib/site-config";
import { ApplyCta } from "@/components/apply-cta";

const WEEK_WORDS = [
  "zero", "one", "two", "three", "four", "five", "six",
  "seven", "eight", "nine", "ten", "eleven", "twelve",
];

/**
 * The hero — minimal and big. Five elements total, all flush on the same
 * left edge: the identifier line, the three-beat sentence (proportioned
 * ~1 : 3 : 1.5, the block owning ~70% of the viewport), one facts line,
 * and the apply button with its # comment. Black space is part of the
 * composition. "yours." is the hero's single amber type moment.
 *
 * "one company" is sized so the sentence fills the screen without ever
 * wrapping mid-word: VT323 sets ~0.44em per character, so 11 characters
 * fit any container at ≤ ~18.5vw; the clamp stays under that at every
 * viewport. Facts render from site-config; the week count is computed
 * from the cohort's real dates.
 */
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
    <section className="flex min-h-[calc(100svh-6rem)] flex-col justify-center py-10 md:py-12">
      {/* 1 · identifier */}
      <p className="t-small text-ink-soft">
        <b className="font-semibold text-ink">batch0</b> · a startup
        accelerator for high schoolers
      </p>

      {/* 2 · the sentence — one flush-left block, ~1 : 3 : 1.5 */}
      <h1 className="mt-6 flex grow flex-col justify-center md:mt-4">
        <span className="block font-display text-[clamp(24px,5.5vw,66px)] leading-[0.95] text-ink-soft">
          {weeksWord} weeks
        </span>
        <span className="block font-display text-[clamp(58px,16.5vw,200px)] leading-[0.85] text-ink">
          one company
        </span>
        <span className="block font-display text-[clamp(34px,8.25vw,100px)] leading-[0.95] text-phosphor">
          yours.
        </span>
      </h1>

      {/* 3 · one facts line */}
      <p className="t-small mt-8 text-ink-soft">
        {closeLabel && settings.applicationsOpen && (
          <>
            apply by <span data-retype>{closeLabel}</span> ·{" "}
          </>
        )}
        <span data-retype>{derived.priceLabel} only if accepted</span> ·{" "}
        <span data-retype>0% equity</span>
      </p>

      {/* 4 + 5 · the button and its comment — CTA #1 of 3 */}
      <div className="mt-5 flex flex-wrap items-center gap-4">
        {isAuthed ? (
          <a
            href={authedHome!}
            className="press inline-flex items-center justify-center bg-phosphor px-5 py-3.5 text-[15px] font-semibold lowercase text-on-phosphor hover:bg-phosphor-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-phosphor focus-visible:ring-offset-2 focus-visible:ring-offset-paper"
          >
            go to dashboard
          </a>
        ) : (
          <ApplyCta
            label={`apply for ${cohortLabel.toLowerCase()}`}
            location="hero"
          />
        )}
        <span className="aside-note">$0 to apply</span>
      </div>
    </section>
  );
}
