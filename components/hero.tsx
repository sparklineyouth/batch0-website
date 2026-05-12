import React from "react";
import Image from "next/image";

export default function Hero() {
  return (
    <section className="relative overflow-hidden pt-24 pb-16 md:pt-40 md:pb-28">
      <div className="absolute inset-0 grid-bg pointer-events-none" />
      <div className="absolute inset-x-0 -top-24 h-[40rem] bg-spark-radial pointer-events-none" />
      <div
        aria-hidden
        className="absolute left-1/2 top-1/3 h-[28rem] w-[28rem] -translate-x-1/2 rounded-full bg-spark/20 blur-[140px] pointer-events-none"
      />

      <div className="relative mx-auto max-w-6xl px-6 text-center">
        <div className="mx-auto mb-7 h-20 w-20 md:h-28 md:w-28 animate-spark-pulse animate-fade-up">
          <Image src="/logo.svg" alt="SparkLine" width={120} height={120} priority />
        </div>

        <div
          className="inline-flex items-center gap-2 rounded-full border border-spark/30 bg-spark/10 px-3.5 py-1 text-xs font-medium text-spark animate-fade-up"
          style={{ animationDelay: "100ms" }}
        >
          <span className="relative flex h-2 w-2">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-spark opacity-75" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-spark" />
          </span>
          Cohort 1 · Summer 2026 · Now accepting applications
        </div>

        <h1
          className="mt-6 text-4xl sm:text-5xl md:text-7xl font-bold tracking-tighter text-white glow-text animate-fade-up"
          style={{ animationDelay: "180ms" }}
        >
          Build a real startup.
          <br />
          Pitch <span className="shine">real investors.</span>
        </h1>

        <p
          className="mx-auto mt-5 max-w-2xl text-base sm:text-lg md:text-xl text-white/60 animate-fade-up"
          style={{ animationDelay: "260ms" }}
        >
          SparkLine is the 4-week, fully virtual accelerator for high
          schoolers. Take your idea from raw concept to investor-ready
          pitch — and walk away with a real shot at funding before you
          graduate.
        </p>

        <div
          className="mt-8 md:mt-10 flex flex-col sm:flex-row items-center justify-center gap-3 animate-fade-up"
          style={{ animationDelay: "340ms" }}
        >
          <a
            href="/apply"
            className="press group relative w-full sm:w-auto inline-flex items-center justify-center gap-2 rounded-full bg-spark px-6 py-3 text-base font-semibold text-black shadow-[0_0_60px_-10px_rgba(250,204,21,0.6)] hover:bg-spark-200 hover:shadow-[0_0_80px_-5px_rgba(250,204,21,0.8)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-spark focus-visible:ring-offset-2 focus-visible:ring-offset-black"
          >
            Apply for $97 · Summer 2026
            <span className="transition-transform duration-100 group-hover:translate-x-0.5">→</span>
          </a>
          <a
            href="#how-it-works"
            className="press w-full sm:w-auto inline-flex items-center justify-center gap-2 rounded-full border border-white/15 bg-white/5 px-6 py-3 text-base font-medium text-white hover:border-white/30 hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-spark focus-visible:ring-offset-2 focus-visible:ring-offset-black"
          >
            See how it works
          </a>
        </div>

        <div
          className="mt-12 md:mt-16 flex flex-wrap items-center justify-center gap-x-6 sm:gap-x-10 gap-y-3 text-[10px] sm:text-xs uppercase tracking-[0.18em] text-white/40 animate-fade-in"
          style={{ animationDelay: "500ms" }}
        >
          <span>Ages 13–18</span>
          <span className="h-1 w-1 rounded-full bg-white/20" />
          <span>4 Weeks · Fully Virtual</span>
          <span className="h-1 w-1 rounded-full bg-white/20" />
          <span>Real Investors</span>
          <span className="h-1 w-1 rounded-full bg-white/20" />
          <span>Open Year-Round</span>
        </div>
      </div>
    </section>
  );
}
