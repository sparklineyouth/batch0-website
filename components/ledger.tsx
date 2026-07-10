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
  const applicationsValue = settings.applicationsOpen
    ? derived.applicationsCountdownLabel
      ? derived.applicationsCountdownLabel.toLowerCase()
      : "open — rolling review"
    : "closed";

  const all: [string, string][] =
    rows === "strip"
      ? [
          [derived.cohortLabel || "Cohort", `${derived.cohortName}${dates ? ` · ${dates}` : ""}`],
          ["Applications", applicationsValue],
        ]
      : [
          [derived.cohortLabel || "Cohort", derived.cohortName],
          ["Dates", dates || "TBA"],
          ["Format", "live, online · U.S. high schoolers"],
          ["Tuition", `${derived.priceLabel} · charged only if accepted`],
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
