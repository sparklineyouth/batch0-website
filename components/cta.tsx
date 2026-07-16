import React from "react";
import type { SiteConfig } from "@/lib/site-config";
import { Ledger } from "@/components/ledger";
import { ApplyCta } from "@/components/apply-cta";

/**
 * The closing poster — the page's final LOUD movement, and CTA #2 of the
 * page's three asks (hero · here · nav chrome). One job: the ask. Same
 * section anatomy as everything else; only the volume differs (t-poster).
 */
export default function CTA({ config }: { config: SiteConfig }) {
  const { derived, settings } = config;
  const cohortLabel = derived.cohortLabel || "the next cohort";

  return (
    <section id="apply-cta" className="border-t border-phosphor/25 py-14 md:py-20">
      <p className="cmdline font-mono">
        <b>
          apply --cohort {String(config.cohort?.cohortNumber ?? 1).padStart(3, "0")}
        </b>
      </p>
      <h2 className="t-poster mt-5 max-w-[9ch] text-ink">
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
              label={`apply for cohort ${String(config.cohort?.cohortNumber ?? 1).padStart(3, "0")}`}
              location="final-cta"
            />
            <span className="aside-note">
              free to apply · {derived.priceLabel} charged only if accepted
            </span>
          </div>
        </>
      ) : (
        <p className="t-body mt-7 max-w-[38rem] text-ink-soft">
          {settings.applicationsClosedMessage}
        </p>
      )}
    </section>
  );
}
