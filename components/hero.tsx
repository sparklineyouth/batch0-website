import React from "react";
import type { SiteConfig } from "@/lib/site-config";
import { ApplyCta } from "@/components/apply-cta";
import { CalendarIcon, BlocksIcon, FolderIcon } from "@/components/icons/pixel-icon";

const WEEK_WORDS = [
  "zero", "one", "two", "three", "four", "five", "six",
  "seven", "eight", "nine", "ten", "eleven", "twelve",
];

/**
 * The hero — a typographic cascade. One sentence at three volumes:
 * "nine weeks" (small) → "one company" (huge) → "yours." (amber, medium),
 * with the pixel icons punctuating the reading path. The identifier line
 * is the quiet opening beat; identity + CTA sit inside the first viewport
 * at 1440 and 390 (machine-verified in the design lab).
 *
 * Every fact renders from site-config. The week count is computed from the
 * cohort's real dates so the sentence can never drift from the calendar.
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
  const dates = derived.dateRangeLabel.replace("→", "to").toLowerCase();

  // Week count from the real cohort dates (falls back to the fallback
  // cohort's dates upstream, so this is always the calendar's truth).
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
    <header className="border-b border-phosphor/25 px-5 pb-16 pt-10 sm:px-6 md:pb-24 md:pt-14">
      <div className="mx-auto max-w-[1100px]">
        {/* the quiet opening beat */}
        <p className="text-[13px] text-ink-soft">
          <b className="font-semibold text-ink">batch0</b> · a startup
          accelerator for high schoolers · {cohortLabel.toLowerCase()} is{" "}
          {settings.applicationsOpen ? "open" : "closed"}
        </p>

        {/* the cascade — one sentence, three volumes */}
        <h1 className="mt-10 md:mt-14">
          <span className="flex flex-wrap items-center gap-3 text-[clamp(17px,2.2vw,26px)] text-ink-soft sm:gap-4">
            {weeksWord} weeks
            <CalendarIcon size={3} className="shrink-0" />
            <span className="text-ink-faint">{dates || "dates tba"}</span>
          </span>
          <span className="mt-2 flex flex-wrap items-center gap-[3vw] font-display text-[clamp(64px,13vw,190px)] leading-[0.85] text-ink md:ml-[8vw]">
            one company
            <BlocksIcon size={8} className="hidden shrink-0 sm:inline-grid" />
          </span>
          <span className="ml-[16vw] mt-3 flex items-center gap-4 font-display text-[clamp(40px,6vw,84px)] leading-[0.9] text-phosphor md:ml-[26vw] md:gap-5">
            yours.
            <FolderIcon size={4} className="shrink-0" />
            <span aria-hidden className="cursor-block" />
          </span>
        </h1>

        {/* facts, verbatim true */}
        <p className="mt-10 text-[13px] text-ink-soft md:ml-[8vw]">
          {closeLabel && settings.applicationsOpen && (
            <>
              <span className="text-phosphor/60">apply by:</span>{" "}
              <span data-retype>{closeLabel}</span> ·{" "}
            </>
          )}
          <span className="text-phosphor/60">tuition:</span>{" "}
          <span data-retype>{derived.priceLabel} only if accepted</span> ·{" "}
          <span className="text-phosphor/60">equity:</span>{" "}
          <span data-retype>0%</span>
        </p>

        {/* CTA #1 of 3 (hero · closing poster · nav chrome) */}
        <div className="mt-6 flex flex-wrap items-center gap-4 md:ml-[8vw]">
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
      </div>
    </header>
  );
}
