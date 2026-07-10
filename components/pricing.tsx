import React from "react";
import type { SiteConfig } from "@/lib/site-config";

/**
 * Tuition, stated like a receipt. Absorbs the old "problem" and
 * "comparison" sections down to their one defensible, persuasive fact:
 * serious programs cost thousands; this one doesn't.
 */
export default function Pricing({ config }: { config: SiteConfig }) {
  const { derived } = config;
  return (
    <section id="tuition" className="border-t border-line px-5 py-20 sm:px-6 md:py-28">
      <div className="mx-auto grid max-w-[1100px] gap-10 md:grid-cols-12 md:gap-8">
        <div className="md:col-span-5">
          <h2 className="font-display text-[clamp(1.75rem,3.5vw,2.5rem)] font-bold leading-[1.08] tracking-[-0.02em] text-ink">
            {derived.priceLabel}, once
          </h2>
          <p className="mt-4 max-w-[34rem] text-[15px] leading-[1.65] text-ink-soft">
            Free to apply — tuition is charged only if you&apos;re accepted.
            Comparable summer programs (LaunchX, LeanGap) list tuition in the
            $3,000–$8,000+ range.
            {/* TODO(RISH): re-verify current LaunchX / LeanGap list prices
                before each cohort; logged in NEEDED_FACTS.md. */}{" "}
            Tuition here covers the program itself; sponsorship and any
            introductions are merit-based, never paid for, and never
            guaranteed.
          </p>
          {derived.isRegionalPrice && (
            <p className="mt-3 text-[13px] text-ink-faint">
              Showing adjusted pricing for your region.
            </p>
          )}
        </div>
        <div className="md:col-span-7 md:pl-6">
          <dl className="ledger max-w-[30rem] text-ink-soft">
            {[
              ["Application", "free"],
              ["Tuition", `${derived.priceLabel} · only if accepted`],
              ["Hidden fees", "none"],
              ["Equity taken", "none"],
              ["Refunds", "see refund policy"],
            ].map(([k, v]) => (
              <div key={k} className="ledger-row">
                <dt className="uppercase tracking-[0.08em] text-ink-faint">{k}</dt>
                <span aria-hidden className="ledger-dots" />
                <dd className="text-right font-medium text-ink">{v}</dd>
              </div>
            ))}
          </dl>
          <p className="mt-5 text-[13px] text-ink-faint">
            Full terms:{" "}
            <a href="/refund-policy" className="link-ink">
              refund policy
            </a>
            {" · "}
            <a href="/terms" className="link-ink">
              terms
            </a>
            . Reduced regional pricing applies automatically in select
            countries.
          </p>
        </div>
      </div>
    </section>
  );
}
