import React from "react";
import type { SiteConfig } from "@/lib/site-config";
import { Ledger } from "@/components/ledger";
import { ApplyCta } from "@/components/apply-cta";

/**
 * The closing poster — the page's third and final LOUD moment, and CTA #2
 * of the page's three asks (hero · here · nav chrome). One job: the ask.
 */
export default function CTA({ config }: { config: SiteConfig }) {
  const { derived, settings } = config;
  const cohortLabel = derived.cohortLabel || "the next cohort";

  return (
    <section
      id="apply-cta"
      className="border-t border-phosphor/25 px-5 py-20 sm:px-6 md:py-32"
    >
      <div className="mx-auto max-w-[1100px]">
        <p className="cmdline font-mono">
          <b>apply --cohort {String(config.cohort?.cohortNumber ?? 1).padStart(3, "0")}</b>
        </p>
        <h2 className="mt-5 max-w-[9ch] font-display text-[clamp(4rem,12vw,10.5rem)] leading-[0.85] text-ink">
          {settings.applicationsOpen ? (
            <>
              be in <span className="text-phosphor">it.</span>
              <span aria-hidden className="cursor-block" />
            </>
          ) : (
            <>applications are closed for now.</>
          )}
        </h2>
        {settings.applicationsOpen ? (
          <>
            <div className="mt-7 max-w-[30rem]">
              <Ledger config={config} rows="strip" />
            </div>
            <div className="mt-7 flex flex-wrap items-center gap-4">
              <ApplyCta
                label={`apply for ${cohortLabel.toLowerCase()}`}
                location="final-cta"
              />
              <span className="aside-note">
                free to apply · {derived.priceLabel} charged only if accepted
              </span>
            </div>
          </>
        ) : (
          <p className="mt-7 max-w-[38rem] text-[15px] leading-[1.6] text-ink-soft">
            {settings.applicationsClosedMessage}
          </p>
        )}
      </div>
    </section>
  );
}
