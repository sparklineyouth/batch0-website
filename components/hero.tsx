import React from "react";
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
  // Live signal beats the static "Applications open" pill when there's
  // either a countdown to share or the cohort is filling up.
  const liveSignal = settings.applicationsOpen
    ? derived.applicationsCountdownLabel ||
      (derived.spotsLabel && derived.spotsLeft <= 5 && derived.spotsLeft > 0
        ? derived.spotsLabel
        : "")
    : "";
  const acceptingLabel =
    liveSignal ||
    (settings.applicationsOpen
      ? "Applications open"
      : "Applications closed");
  const headline = derived.cohortHeadline;
  const isAuthed = !!authedHome;
  const ctaHref = isAuthed ? authedHome! : "/apply";
  const ctaLabel = isAuthed ? "Go to dashboard" : "Start your application";
  const spotsSubLine =
    derived.spotsLabel && derived.spotsLabel !== liveSignal
      ? derived.spotsLabel
      : "";

  return (
    <section className="relative overflow-hidden pt-20 pb-14 sm:pt-32 sm:pb-20 md:pt-44 md:pb-28">
      <div
        aria-hidden
        className="absolute inset-x-0 -top-16 h-64 bg-gradient-to-b from-spark/[0.08] to-transparent pointer-events-none"
      />

      <div className="relative mx-auto max-w-5xl px-5 sm:px-6">
        {/* Eyebrow now reads as a proper pill on mobile — easier to anchor
            the eye, less likely to look like an afterthought line of text. */}
        <div className="inline-flex max-w-full items-center gap-2 rounded-full border border-spark/30 bg-spark/[0.06] px-3 py-1.5 text-[10px] sm:text-[11px] font-medium uppercase tracking-[0.18em] sm:tracking-[0.2em] text-spark">
          <span aria-hidden className="relative flex h-1.5 w-1.5">
            <span className="absolute inset-0 animate-ping rounded-full bg-spark/70" />
            <span className="relative h-1.5 w-1.5 rounded-full bg-spark" />
          </span>
          <span className="truncate">{headline} · {acceptingLabel}</span>
        </div>

        <h1 className="mt-5 sm:mt-6 text-[40px] sm:text-6xl md:text-[80px] font-bold tracking-[-0.04em] leading-[1] text-white">
          Learn to build a startup.
          <br />
          Get <span className="shine">funded</span> for it.
        </h1>

        <p className="mt-5 sm:mt-7 max-w-2xl text-[15px] sm:text-lg md:text-xl text-white/80 leading-[1.55] sm:leading-relaxed">
          SparkLine Youth is a 4-week, fully virtual entrepreneurship
          program for U.S. high schoolers. Apply, learn how to launch a
          real startup, then earn the chance for SparkLine sponsorship
          and warm intros to our investor network.
        </p>

        <div className="mt-6 sm:mt-9 flex flex-col sm:flex-row items-stretch sm:items-center gap-2.5 sm:gap-3">
          <a
            href={ctaHref}
            className="press group inline-flex items-center justify-center gap-2 rounded-lg bg-spark px-5 py-4 sm:py-3 text-[15px] font-semibold text-black shadow-[0_8px_24px_-8px_rgba(250,204,21,0.5)] hover:bg-spark-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-spark focus-visible:ring-offset-2 focus-visible:ring-offset-black"
          >
            {ctaLabel}
            <span aria-hidden className="transition-transform group-hover:translate-x-0.5">→</span>
          </a>
          <a
            href="#how-it-works"
            className="press inline-flex items-center justify-center gap-2 rounded-lg border border-white/15 px-5 py-4 sm:py-3 text-[15px] font-medium text-white/90 hover:border-white/30 hover:bg-white/[0.04]"
          >
            See how it works
          </a>
        </div>
        {!isAuthed && (
          <p className="mt-3 text-[13px] sm:text-xs text-white/65">
            Free to apply · {derived.priceLabel} only if accepted
            {spotsSubLine && (
              <span className="ml-2 text-spark/90">· {spotsSubLine}</span>
            )}
          </p>
        )}

        {/* Proof row — bordered 2×2 card on mobile so it reads as a unit,
            inline 4-up on desktop. The price gets the spark tint so it
            visually anchors the row. */}
        <dl className="mt-10 sm:mt-14 grid grid-cols-2 rounded-2xl border border-white/10 overflow-hidden sm:rounded-none sm:border-0 sm:border-t sm:border-white/10 sm:gap-x-8 sm:pt-8 sm:grid-cols-4 [&>*:nth-child(2n)]:border-l [&>*:nth-child(n+3)]:border-t [&>*]:border-white/10 sm:[&>*:nth-child(2n)]:border-l-0 sm:[&>*:nth-child(n+3)]:border-t-0">
          <ProofStat
            label="Cohort size"
            value={derived.capacityLabel}
            sub="Seats per cohort"
          />
          <ProofStat
            label="Tuition"
            value={derived.priceLabel}
            sub="Free to apply"
            accent
          />
          <ProofStat label="Format" value="4 wks" sub="Fully virtual" />
          <ProofStat label="Pitch Day" value="Live" sub="Sponsors + investors" />
        </dl>
      </div>
    </section>
  );
}

function ProofStat({
  label,
  value,
  sub,
  accent = false,
}: {
  label: string;
  value: string;
  sub: string;
  accent?: boolean;
}) {
  return (
    <div className="px-4 py-4 sm:p-0">
      <dt className="text-[10px] sm:text-[11px] font-medium uppercase tracking-[0.16em] sm:tracking-[0.18em] text-white/55">
        {label}
      </dt>
      <dd
        className={`mt-1 sm:mt-1.5 text-[22px] sm:text-2xl md:text-3xl font-semibold tracking-tight ${
          accent ? "text-spark" : "text-white"
        }`}
      >
        {value}
      </dd>
      <dd className="mt-0.5 text-[11px] sm:text-xs text-white/60">{sub}</dd>
    </div>
  );
}
