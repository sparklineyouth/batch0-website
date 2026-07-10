import React from "react";
import type { SiteConfig } from "@/lib/site-config";
import { Ledger } from "@/components/ledger";
import { ApplyCta } from "@/components/apply-cta";

/** Final CTA — the deadline restated, then the button. */
export default function CTA({ config }: { config: SiteConfig }) {
  const { derived, settings } = config;
  const cohortLabel = derived.cohortLabel || "the next cohort";

  return (
    <section id="apply-cta" className="border-t border-line px-5 py-20 sm:px-6 md:py-28">
      <div className="mx-auto max-w-[1100px]">
        <h2 className="max-w-[24ch] font-display text-[clamp(2rem,4.5vw,3.25rem)] font-bold leading-[1.05] tracking-[-0.02em] text-ink">
          {settings.applicationsOpen ? (
            <>
              {derived.cohortLabel || "Cohort 1"} is the founding cohort.{" "}
              <span className="hl">Be in it.</span>
            </>
          ) : (
            "Applications are closed for now."
          )}
        </h2>
        <div className="mt-8 max-w-[30rem]">
          <Ledger config={config} rows="strip" />
        </div>
        <div className="mt-8 flex flex-col items-stretch gap-3 sm:flex-row sm:items-center">
          {settings.applicationsOpen ? (
            <>
              <ApplyCta label={`Apply for ${cohortLabel}`} location="final-cta" />
              <p className="text-[13px] text-ink-faint">
                Free to apply · {derived.priceLabel} charged only if accepted
              </p>
            </>
          ) : (
            <p className="max-w-[38rem] text-[15px] leading-[1.6] text-ink-soft">
              {settings.applicationsClosedMessage}
            </p>
          )}
        </div>
      </div>
    </section>
  );
}
