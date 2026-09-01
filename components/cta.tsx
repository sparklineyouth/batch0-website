import React from "react";
import type { SiteConfig } from "@/lib/site-config";
import { Seam } from "@/components/section-kit";
import { ApplyCta } from "@/components/apply-cta";
import { ZeroThread } from "@/components/zero-thread";

/**
 * The closing ask.
 *
 * The scattered grey pixel field that used to run behind this section
 * (<Sky zone="close" />) is gone. It scattered low-contrast specks over
 * the page's most important control, which read as rendering debris
 * rather than atmosphere — and it was the last remaining animated thing
 * below the hero. Nothing replaces it: the closing beat is stronger for
 * being the one section that is only a statement and a button.
 *
 * This is the page's ONE centred section. Every other section is
 * left-anchored, so centring here marks the ending without needing any
 * extra ornament.
 */
export default function CTA({ config }: { config: SiteConfig }) {
  const { derived, settings } = config;
  const cohortCode = String(config.cohort?.cohortNumber ?? 1).padStart(3, "0");
  const closeLabel = config.cohort?.applicationsCloseAt
    ? new Date(config.cohort.applicationsCloseAt)
        .toLocaleDateString("en-US", { month: "short", day: "numeric" })
        .toLowerCase()
    : null;

  return (
    <>
      <Seam />
      <section id="apply-cta" className="sec font-body">
        <div className="mx-auto flex max-w-[42rem] flex-col items-center text-center">
          <p className="sec-eyebrow">cohort {cohortCode}</p>

          {settings.applicationsOpen ? (
            <>
              <h2 className="sec-display mt-6 max-w-[9ch]">
                be in <span className="text-phosphor">it.</span>
              </h2>
              <p className="sec-lead mt-8 max-w-[38ch]">
                Nine weeks, {derived.priceLabel.toLowerCase()} only if you get
                in, and you keep all of it.
              </p>

              <div className="mt-10">
                <ApplyCta
                  label={`apply for cohort ${cohortCode}`}
                  location="final-cta"
                />
              </div>

              <p className="sec-body mt-6 text-ink-faint">
                <ZeroThread>$0</ZeroThread> to apply
                {closeLabel ? ` · applications close ${closeLabel}` : ""} ·{" "}
                <ZeroThread>0%</ZeroThread> equity
              </p>
            </>
          ) : (
            <>
              <h2 className="sec-display mt-6 max-w-[14ch]">
                applications are closed for now.
              </h2>
              <p className="sec-lead mt-8 max-w-[40ch]">
                {settings.applicationsClosedMessage}
              </p>
            </>
          )}
        </div>
      </section>
    </>
  );
}
