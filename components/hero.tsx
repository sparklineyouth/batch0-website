import React from "react";
import Image from "next/image";
import type { SiteConfig } from "@/lib/site-config";

export default function Hero({
  config,
  authedHome,
}: {
  config: SiteConfig;
  /** If the visitor is already signed in, route the primary CTA to
   *  their role home instead of showing the apply pitch. */
  authedHome?: string | null;
}) {
  const { derived, settings } = config;
  const acceptingLabel = settings.applicationsOpen
    ? "Applications open"
    : "Applications closed";
  const headline = derived.cohortHeadline;
  const isAuthed = !!authedHome;
  const ctaHref = isAuthed ? authedHome! : "/apply";
  const ctaLabel = isAuthed
    ? "Go to dashboard"
    : `Apply · ${derived.priceLabel} if accepted`;

  // One signature treatment: a single restrained spark glow up top.
  // Removed the grid backdrop, blurred orb, and radial wash.
  return (
    <section className="relative overflow-hidden pt-32 pb-20 md:pt-44 md:pb-28">
      <div
        aria-hidden
        className="absolute inset-x-0 -top-16 h-64 bg-gradient-to-b from-spark/[0.07] to-transparent pointer-events-none"
      />

      <div className="relative mx-auto max-w-5xl px-6">
        <div className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-[0.2em] text-spark">
          <span className="h-1.5 w-1.5 rounded-full bg-spark" />
          {headline} · {acceptingLabel}
        </div>

        <h1 className="mt-6 text-[44px] sm:text-6xl md:text-[80px] font-bold tracking-[-0.04em] leading-[0.98] text-white">
          Build a real startup.
          <br />
          Pitch real investors.
        </h1>

        <p className="mt-7 max-w-2xl text-lg md:text-xl text-white/80 leading-relaxed">
          SparkLine is the 4-week, fully virtual accelerator for U.S.
          high schoolers. Take an idea from raw concept to investor-ready
          pitch — and walk into Demo Day with a real shot at funding.
        </p>

        <div className="mt-9 flex flex-col sm:flex-row items-start sm:items-center gap-3">
          <a
            href={ctaHref}
            className="press inline-flex items-center justify-center gap-2 rounded-md bg-spark px-5 py-3 text-[15px] font-semibold text-black hover:bg-spark-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-spark focus-visible:ring-offset-2 focus-visible:ring-offset-black"
          >
            {ctaLabel}
            <span aria-hidden>→</span>
          </a>
          <a
            href="#how-it-works"
            className="press inline-flex items-center justify-center gap-2 rounded-md border border-white/15 px-5 py-3 text-[15px] font-medium text-white/90 hover:border-white/30 hover:bg-white/[0.04]"
          >
            See how it works
          </a>
        </div>
        {!isAuthed && (
          <p className="mt-3 text-xs text-white/65">
            Free to apply. Pay {derived.priceLabel} only if accepted.
          </p>
        )}

        {/* Proof row — concrete facts in lieu of testimonials we don't have yet. */}
        <dl className="mt-14 grid grid-cols-2 gap-x-8 gap-y-6 border-t border-white/10 pt-8 sm:grid-cols-4">
          <ProofStat
            label="Cohort size"
            value={derived.capacityLabel}
            sub="Seats per cohort"
          />
          <ProofStat
            label="Tuition"
            value={derived.priceLabel}
            sub="Free to apply"
          />
          <ProofStat label="Format" value="4 wks" sub="Fully virtual" />
          <ProofStat label="Demo Day" value="Live" sub="Angel investors" />
        </dl>
      </div>
    </section>
  );
}

function ProofStat({
  label,
  value,
  sub,
}: {
  label: string;
  value: string;
  sub: string;
}) {
  return (
    <div>
      <dt className="text-[11px] font-medium uppercase tracking-[0.18em] text-white/60">
        {label}
      </dt>
      <dd className="mt-1.5 text-2xl md:text-3xl font-semibold tracking-tight text-white">
        {value}
      </dd>
      <dd className="mt-0.5 text-xs text-white/65">{sub}</dd>
    </div>
  );
}
