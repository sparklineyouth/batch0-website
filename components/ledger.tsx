import React from "react";
import type { SiteConfig } from "@/lib/site-config";

/**
 * The Cohort Ledger — the site's signature element (DESIGN.md). A mono,
 * dotted-leader filing of the cohort's facts. Every value renders from
 * live site-config, so the ledger can never drift from the truth. When
 * Cohort 1 produces real artifacts, rows become the cohort log.
 */
export function Ledger({
  config,
  rows = "full",
  animate = false,
  className = "",
}: {
  config: SiteConfig;
  /** "full" = hero block; "strip" = the two-row version for the final CTA. */
  rows?: "full" | "strip";
  /** Applies the staggered hero rise — use once per page. */
  animate?: boolean;
  className?: string;
}) {
  const { derived, settings } = config;
  const dates = derived.dateRangeLabel.replace("→", "–");
  const applicationsValue = derived.applicationsCountdownLabel;

  // Tuition is the row a visitor actually stops on, so during a sale it shows
  // the old price struck through beside the new one — the way a price is
  // normally marked down. It is also the highest server-rendered mention of
  // the discount on the page, which matters beyond marketing: Google decides
  // whether to keep a <title> partly on whether the page corroborates it, and
  // a title advertising a sale is far more likely to be discarded when the
  // visible content near the top never mentions one.
  const tuition: React.ReactNode = derived.isPromoPrice ? (
    <>
      <span className="sr-only">was </span>
      <span className="font-normal text-ink-faint line-through">
        {derived.listPriceLabel}
      </span>{" "}
      <span className="sr-only">now </span>
      {derived.priceLabel} · {derived.promoPercentLabel}% off
    </>
  ) : (
    `${derived.priceLabel} · charged only if accepted`
  );

  const all: [string, React.ReactNode][] =
    rows === "strip"
      ? [
          [derived.cohortLabel || "Cohort", `${derived.cohortName}${dates ? ` · ${dates}` : ""}`],
          ["Applications", applicationsValue],
        ]
      : [
          [derived.cohortLabel || "Cohort", derived.cohortName],
          ["Dates", dates || "TBA"],
          ["Format", "live, online · high schoolers 13–18"],
          ["Tuition", tuition],
          ["Equity taken", "none"],
          ["Applications", applicationsValue],
        ];

  return (
    <dl className={`ledger text-ink-soft ${className}`} aria-label="Cohort facts">
      {all.map(([k, v], i) => (
        <div
          key={k}
          className={`ledger-row ${animate ? `animate-rise rise-${Math.min(i + 2, 5)}` : ""}`}
        >
          <dt className="uppercase tracking-[0.08em] text-ink-faint">{k}</dt>
          <span aria-hidden className="ledger-dots" />
          <dd className="text-right font-medium text-ink">{v}</dd>
        </div>
      ))}
    </dl>
  );
}
