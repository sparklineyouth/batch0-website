import React from "react";
import type { SiteConfig } from "@/lib/site-config";
import { Ledger } from "@/components/ledger";
import { ApplyCta } from "@/components/apply-cta";

export default function Hero({
  config,
  authedHome,
}: {
  config: SiteConfig;
  /** If the visitor is already signed in, route the primary CTA to
   *  their role home instead of the apply pitch. */
  authedHome?: string | null;
}) {
  const { derived } = config;
  const isAuthed = !!authedHome;
  const cohortLabel = derived.cohortLabel || "the next cohort";

  return (
    <section className="px-5 pb-16 pt-14 sm:px-6 sm:pt-20 md:pb-24 md:pt-28">
      <div className="mx-auto grid max-w-[1100px] gap-12 md:grid-cols-12 md:gap-8">
        <div className="md:col-span-7">
          {/* The rename is load-bearing information, not a footnote: anyone
              arriving from an old link, a flyer, or a teacher's rec needs to
              recognise the program in the first second. It sits above the
              headline for that reason, and stays until the new name stands
              on its own. */}
          <p className="animate-rise rise-1 mb-5 flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[12px] uppercase tracking-[0.14em] text-ink-faint">
            <span
              aria-hidden="true"
              className="inline-block h-1.5 w-1.5 shrink-0 bg-phosphor"
            />
            Formerly Sparkline Youth
          </p>

          <h1 className="animate-rise rise-2 font-display text-[clamp(3rem,7.5vw,5rem)] leading-[1.02] text-ink">
            Don&apos;t wait for college to start{" "}
            <span className="hl">building</span>
          </h1>

          <p className="animate-rise rise-3 mt-6 max-w-[38rem] text-[1.0625rem] leading-[1.6] text-ink-soft sm:text-lg">
            batch0 is a live, online startup accelerator for
            high schoolers. Seasonal build sprints, mentorship, and a supportive community
            resulting in a company of your own.
          </p>

          <div className="animate-rise rise-4 mt-8 flex flex-col items-stretch gap-3 sm:flex-row sm:items-center">
            {isAuthed ? (
              <a
                href={authedHome!}
                className="press inline-flex items-center justify-center gap-2 rounded-md bg-phosphor px-5 py-3.5 text-[15px] font-semibold text-on-phosphor shadow-cta hover:bg-phosphor-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-phosphor focus-visible:ring-offset-2 focus-visible:ring-offset-paper"
              >
                Go to dashboard
              </a>
            ) : (
              <ApplyCta
                label={`Apply for ${cohortLabel}`}
                location="hero"
              />
            )}
            <a
              href="/program"
              className="press inline-flex items-center justify-center rounded-md border border-line px-5 py-3.5 text-[15px] font-medium text-ink hover:border-ink/30"
            >
              See the program
            </a>
          </div>

          {!isAuthed && (
            <p className="animate-rise rise-5 mt-4 text-[13px] text-ink-faint">
              Free to apply · {derived.priceLabel} charged only if accepted
            </p>
          )}
        </div>

        {/* The Cohort Ledger — every row rendered from the live cohort
            record, so this block cannot drift from the truth. */}
        <div className="md:col-span-5 md:pl-6 md:pt-3">
          <Ledger config={config} animate className="border-t border-line pt-6 md:border-t-0 md:pt-0" />
        </div>
      </div>
    </section>
  );
}
