import React from "react";
import type { SiteConfig } from "@/lib/site-config";
import { Ledger } from "@/components/ledger";
import { ApplyCta } from "@/components/apply-cta";
import { EnrollmentNotice } from "@/components/enrollment-notice";

export default function Hero({ config }: { config: SiteConfig }) {
  const { derived } = config;
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
            Turn your idea into customer research, a first version and a
            demo you can show. A small, live online cohort for high schoolers,
            with weekly work, founder feedback and people to build alongside.
          </p>

          <div className="animate-rise rise-4 mt-8 flex flex-col items-stretch gap-3 sm:flex-row sm:items-center">
            {/* /home redirects a signed-in visitor to their own panel and
                everyone else to /apply — so this stays a constant href and
                the hero can be prerendered. Only the label resolves in the
                browser, and it does so without shifting anything. */}
            <ApplyCta
              href="/home"
              label={derived.applicationLabel}
              signedInLabel="Go to dashboard"
              location="hero"
            />
            <a
              href="/program"
              className="press inline-flex items-center justify-center rounded-md border border-line px-5 py-3.5 text-[15px] font-medium text-ink hover:border-ink/30"
            >
              See the program
            </a>
          </div>

          <p className="animate-rise rise-5 mt-4 text-[13px] text-ink-faint">
            Free to apply · {derived.priceLabel} charged only if accepted
          </p>
          <EnrollmentNotice config={config} />
          <p className="mt-5 text-sm"><a href="/parents" className="link-ink">For parents: schedule, tuition and how it works →</a></p>
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
