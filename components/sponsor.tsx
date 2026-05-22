import React from "react";
import { Reveal } from "@/components/ui/reveal";

const pillars = [
  {
    k: "AI Audit",
    v: "Free 48-hour operations review with a prioritized opportunity map and vendor recommendations.",
  },
  {
    k: "AI Roadmap",
    v: "90-day implementation plan with budget projections and build-vs-buy analysis.",
  },
  {
    k: "Full Build",
    v: "Custom AI tools, system integration, staff training, and post-launch support.",
  },
];

const stats = [
  { v: "10+", k: "AI products shipped", sub: "Across medical, e-commerce, ops" },
  { v: "8 yrs", k: "Founder experience", sub: "Quantiphi, Schroders, robotics" },
  { v: "12–20 hr", k: "Weekly time saved", sub: "Reported by clients" },
];

export default function Sponsor() {
  return (
    <section
      id="sponsor"
      className="relative border-y border-white/10 px-5 sm:px-6 py-16 sm:py-20 md:py-32"
    >
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-spark/40 to-transparent"
      />

      <div className="mx-auto max-w-6xl">
        <Reveal className="max-w-2xl">
          <div className="inline-flex items-center gap-2 rounded-full border border-spark/30 bg-spark/[0.06] px-3 py-1.5 text-[11px] sm:text-xs font-medium uppercase tracking-[0.22em] text-spark">
            <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-spark animate-spark-pulse" />
            Presenting sponsor
          </div>
          <h2 className="mt-5 text-[34px] sm:text-4xl md:text-6xl font-bold tracking-[-0.03em] leading-[1.05] sm:leading-[1.02] text-white">
            Powered by{" "}
            <span className="text-spark">Impetus AI</span>.
          </h2>
          <p className="mt-4 sm:mt-5 max-w-xl text-[15px] sm:text-[17px] text-white/75 leading-[1.6]">
            SparkLine Youth runs on the backing of{" "}
            <span className="text-white">Impetus AI</span> — AI consulting
            for local businesses. They bring enterprise-grade AI strategy
            to small and medium-sized companies that don't have Fortune 500
            resources, and they fund the seats, mentors, and infrastructure
            that make this cohort free to apply.
          </p>
        </Reveal>

        <Reveal
          delay={80}
          className="mt-10 sm:mt-12 grid grid-cols-1 gap-4 sm:gap-5 md:grid-cols-3"
        >
          {pillars.map((p) => (
            <div
              key={p.k}
              className="group relative overflow-hidden rounded-xl border border-white/10 bg-white/[0.02] p-5 sm:p-6 transition-colors hover:border-spark/30 hover:bg-spark/[0.03]"
            >
              <div className="flex items-center gap-2">
                <span
                  aria-hidden
                  className="h-1.5 w-1.5 rounded-full bg-spark"
                />
                <p className="text-[11px] font-medium uppercase tracking-[0.2em] text-spark">
                  {p.k}
                </p>
              </div>
              <p className="mt-3 text-[14px] sm:text-[15px] text-white/80 leading-[1.55]">
                {p.v}
              </p>
            </div>
          ))}
        </Reveal>

        <Reveal
          delay={120}
          className="mt-10 sm:mt-12 grid grid-cols-1 gap-y-5 sm:grid-cols-3 sm:gap-x-6 md:gap-x-10"
        >
          {stats.map((s) => (
            <div
              key={s.k}
              className="border-t border-white/10 pt-4 sm:border-t-0 sm:border-l sm:pl-5 sm:pt-0 sm:first:border-l-0 sm:first:pl-0"
            >
              <dt className="text-[11px] font-medium uppercase tracking-[0.18em] text-white/55">
                {s.k}
              </dt>
              <dd className="mt-1.5 text-3xl sm:text-3xl md:text-4xl font-semibold tracking-tight text-white">
                {s.v}
              </dd>
              <dd className="mt-0.5 text-xs text-white/65">{s.sub}</dd>
            </div>
          ))}
        </Reveal>

        <Reveal delay={160} className="mt-10 sm:mt-12 flex flex-col sm:flex-row sm:items-center gap-4 sm:gap-6">
          <a
            href="https://impetusai.net"
            target="_blank"
            rel="noopener noreferrer"
            className="press group inline-flex items-center justify-center gap-2 rounded-lg bg-spark px-5 py-3 text-[14px] sm:text-[15px] font-semibold text-black shadow-[0_8px_24px_-8px_rgba(250,204,21,0.5)] hover:bg-spark-200"
          >
            Visit impetusai.net
            <span aria-hidden className="transition-transform group-hover:translate-x-0.5">
              →
            </span>
          </a>
          <a
            href="mailto:hello@impetusai.net"
            className="inline-flex items-center justify-center gap-2 rounded-lg border border-white/15 bg-white/[0.02] px-5 py-3 text-[14px] sm:text-[15px] font-medium text-white/85 hover:border-spark/30 hover:text-spark"
          >
            hello@impetusai.net
          </a>
          <p className="text-[13px] text-white/55 sm:ml-auto">
            New Jersey · serving global clients
          </p>
        </Reveal>
      </div>
    </section>
  );
}
