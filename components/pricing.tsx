import React from "react";
import Link from "next/link";
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
            {derived.isPromoPrice && (
              <>
                {/* The old price is struck through and de-emphasised rather
                    than removed: a discount is only legible next to the number
                    it replaces. It is announced to screen readers as
                    "was $130" instead of relying on the visual strike, which
                    carries no meaning in the accessibility tree. */}
                <span className="sr-only">Was </span>
                <span className="mr-3 font-normal text-ink-faint line-through decoration-[0.075em]">
                  {derived.listPriceLabel}
                </span>
                <span className="sr-only">, now </span>
              </>
            )}
            {derived.priceLabel}, once
          </h2>
          {derived.isPromoPrice && (
            <p className="mt-3 inline-flex items-center gap-2 bg-phosphor px-2.5 py-1 font-mono text-[12px] font-semibold uppercase tracking-[0.12em] text-on-phosphor">
              {derived.promoPercentLabel}% off · ends {derived.promoDeadlineLabel}
            </p>
          )}
          <p className="mt-4 max-w-[34rem] text-[15px] leading-[1.65] text-ink-soft">
            batch0 is 100% free to apply, tuition is charged only if you&apos;re accepted.
            Tuition covers the live cohort sessions, course materials,
            office hours and the final student showcase. You are paying for
            structure and feedback as you build. Revenue, investment and
            college admission outcomes are not guaranteed.
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
              [
                "Tuition",
                derived.isPromoPrice
                  ? `${derived.priceLabel} · was ${derived.listPriceLabel} · only if accepted`
                  : `${derived.priceLabel} · only if accepted`,
              ],
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
            <Link href="/refund-policy" className="link-ink">
              refund policy
            </Link>
            {" · "}
            <Link href="/terms" className="link-ink">
              terms
            </Link>
            . Reduced regional pricing applies automatically in select
            countries.
          </p>
        </div>
      </div>
    </section>
  );
}
