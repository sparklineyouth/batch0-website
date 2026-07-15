import React from "react";
import type { SiteConfig } from "@/lib/site-config";
import { ApplyCta } from "@/components/apply-cta";

const WEEK_WORDS = [
  "zero", "one", "two", "three", "four", "five", "six",
  "seven", "eight", "nine", "ten", "eleven", "twelve",
];

/**
 * The hero — a PURE TYPE cascade (no icons: the sentence carries it).
 * One sentence at the page's three volumes — body → poster → head — with
 * each beat starting on a line of the shared 12-column grid (beat 2 on
 * column 2, beat 3 on column 4). The identifier line is the quiet opening
 * beat; identity + CTA sit inside the first viewport at 1440 and 390.
 *
 * Every fact renders from site-config; the week count is computed from the
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
    <section className="py-14 md:py-20">
      {/* the quiet opening beat */}
      <p className="t-small text-ink-soft">
        <b className="font-semibold text-ink">batch0</b> · a startup
        accelerator for high schoolers · {cohortLabel.toLowerCase()} is{" "}
        {settings.applicationsOpen ? "open" : "closed"}
      </p>

      {/* the cascade — one sentence, three volumes, on the grid */}
      <h1 className="mt-10 md:mt-14">
        <span className="t-body block text-ink-soft">
          {weeksWord} weeks{" "}
          <span className="text-ink-faint">· {dates || "dates tba"}</span>
        </span>
        <span className="t-poster mt-2 block text-ink md:ml-[8.333%]">
          one company
        </span>
        <span className="t-head ml-[16.666%] mt-3 block text-phosphor md:ml-[25%]">
          yours.
          <span aria-hidden className="cursor-block" />
        </span>
      </h1>

      {/* facts, verbatim true */}
      <p className="t-small mt-10 text-ink-soft md:ml-[8.333%]">
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
      <div className="mt-6 flex flex-wrap items-center gap-4 md:ml-[8.333%]">
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
