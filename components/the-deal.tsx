import React from "react";
import Link from "next/link";
import type { SiteConfig } from "@/lib/site-config";
import { Section, Eyebrow, Fig } from "@/components/section-kit";
import { TermsAnchor } from "@/components/anchors";
import { ZeroThread } from "@/components/zero-thread";
import { ApplyCta } from "@/components/apply-cta";

/**
 * The deal — the whole factual offer, and the page's first ask.
 *
 * Statement on the left, the terms ledger drawn on the right. The
 * tracer is the equity zero, which is also the amber row in the anchor:
 * the drawing and the sentence are making the same point in two
 * materials, which is what stops the anchor reading as decoration.
 */
export default function TheDeal({
  config,
  authedHome,
}: {
  config: SiteConfig;
  /** Signed-in visitors get their role home instead of the apply pitch. */
  authedHome?: string | null;
}) {
  const { derived, settings } = config;
  const dates = derived.dateRangeLabel.replace("→", "–").toLowerCase();
  const cohortCode = config.cohort?.cohortNumber
    ? String(config.cohort.cohortNumber).padStart(3, "0")
    : "001";
  const closeLabel = config.cohort?.applicationsCloseAt
    ? new Date(config.cohort.applicationsCloseAt)
        .toLocaleDateString("en-US", { month: "short", day: "numeric" })
        .toLowerCase()
    : null;

  const terms: [string, string][] = [
    ["applications close", closeLabel ?? "tba"],
    ["cohort runs", dates || "dates tba"],
    ["tuition", `${derived.priceLabel.toLowerCase()}, only if accepted`],
    ["equity taken", "none"],
  ];

  return (
    <Section id="the-deal">
      <div className="grid grid-cols-12 items-start gap-x-6 gap-y-14">
        {/* ── statement ──────────────────────────────────────────── */}
        <div className="col-span-12 md:col-span-7">
          <Eyebrow>the deal</Eyebrow>
          <h2 className="sec-display mt-6 max-w-[12ch]">
            free to apply. <ZeroThread>0%</ZeroThread> equity. ever.
          </h2>
          <p className="sec-lead mt-8 max-w-[44ch]">
            {derived.priceLabel} once, and only if you get in. Everything you
            build stays yours — no equity, no IP claim, no royalties.
          </p>
        </div>

        {/* ── anchor ─────────────────────────────────────────────── */}
        <div className="col-span-12 md:col-span-4 md:col-start-9">
          <div className="mx-auto max-w-[20rem] md:mx-0">
            <TermsAnchor />
            <Fig n="01" className="mt-5">
              the terms, in full
            </Fig>
          </div>
        </div>
      </div>

      {/* ── the ledger, read as a table ────────────────────────── */}
      <dl className="mt-16 max-w-[42rem]">
        {terms.map(([k, v]) => (
          <div
            key={k}
            className="flex items-baseline justify-between gap-6 border-t border-line py-3.5 last:border-b"
          >
            <dt className="sec-body text-ink-faint">{k}</dt>
            <dd className="text-right text-[15px] font-medium text-ink">{v}</dd>
          </div>
        ))}
      </dl>

      {/* ── the ask ────────────────────────────────────────────── */}
      <div className="mt-12 flex flex-wrap items-center gap-x-6 gap-y-4">
        {authedHome ? (
          <a
            href={authedHome}
            className="press inline-flex items-center justify-center bg-phosphor-fill px-6 py-3.5 text-[15px] font-semibold lowercase text-on-phosphor hover:bg-phosphor-fill-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-phosphor focus-visible:ring-offset-2 focus-visible:ring-offset-paper"
          >
            go to dashboard
          </a>
        ) : (
          <ApplyCta label={`apply for cohort ${cohortCode}`} location="the-deal" />
        )}
        <p className="sec-body text-ink-faint">
          <ZeroThread>$0</ZeroThread> to apply
          {settings.applicationsOpen && closeLabel ? ` · closes ${closeLabel}` : ""}
          {" · "}
          <Link href="/refund-policy" className="link-ink">
            refund policy
          </Link>
          {derived.isRegionalPrice ? " · regional pricing applied" : ""}
        </p>
      </div>
    </Section>
  );
}
