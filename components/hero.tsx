"use client";
import React from "react";
import Image from "next/image";
import { motion } from "framer-motion";

export default function Hero() {
  return (
    <section className="relative overflow-hidden pt-32 pb-20 md:pt-40 md:pb-28">
      <div className="absolute inset-0 grid-bg pointer-events-none" />
      <div className="absolute inset-x-0 -top-24 h-[40rem] bg-spark-radial pointer-events-none" />
      <div
        aria-hidden
        className="absolute left-1/2 top-1/3 h-[28rem] w-[28rem] -translate-x-1/2 rounded-full bg-spark/20 blur-[140px] pointer-events-none"
      />

      <div className="relative mx-auto max-w-6xl px-6 text-center">
        <motion.div
          initial={{ scale: 0.6, opacity: 0, rotate: -10 }}
          animate={{ scale: 1, opacity: 1, rotate: 0 }}
          transition={{ duration: 0.9, ease: [0.16, 1, 0.3, 1] }}
          className="mx-auto mb-8 w-24 h-24 md:w-28 md:h-28 animate-spark-pulse"
        >
          <Image src="/logo.svg" alt="SparkLine" width={120} height={120} priority />
        </motion.div>

        <motion.div
          initial={{ y: 20, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          transition={{ delay: 0.15, duration: 0.7 }}
          className="inline-flex items-center gap-2 rounded-full border border-spark/30 bg-spark/10 px-3.5 py-1 text-xs font-medium text-spark"
        >
          <span className="relative flex h-2 w-2">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-spark opacity-75" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-spark" />
          </span>
          Cohort 1 — Summer 2026 — Now accepting applications
        </motion.div>

        <motion.h1
          initial={{ y: 28, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          transition={{ delay: 0.25, duration: 0.8 }}
          className="mt-6 text-5xl md:text-7xl font-bold tracking-tighter text-white glow-text"
        >
          Build a real startup.<br />
          Pitch <span className="shine">real investors.</span>
        </motion.h1>

        <motion.p
          initial={{ y: 20, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          transition={{ delay: 0.4, duration: 0.7 }}
          className="mx-auto mt-6 max-w-2xl text-lg md:text-xl text-white/60"
        >
          SparkLine is the 4-week, fully virtual accelerator for high schoolers.
          Take your idea from raw concept to investor-ready pitch — and walk away
          with a real shot at funding before you graduate.
        </motion.p>

        <motion.div
          initial={{ y: 16, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          transition={{ delay: 0.55, duration: 0.7 }}
          className="mt-10 flex flex-col sm:flex-row items-center justify-center gap-3"
        >
          <a
            href="#apply"
            className="group relative w-full sm:w-auto inline-flex items-center justify-center gap-2 rounded-full bg-spark px-6 py-3 text-base font-semibold text-black shadow-[0_0_60px_-10px_rgba(250,204,21,0.6)] hover:shadow-[0_0_80px_-5px_rgba(250,204,21,0.8)] transition-all"
          >
            Apply for $97 · Summer 2026
            <span className="transition-transform group-hover:translate-x-0.5">→</span>
          </a>
          <a
            href="#how-it-works"
            className="w-full sm:w-auto inline-flex items-center justify-center gap-2 rounded-full border border-white/15 bg-white/5 px-6 py-3 text-base font-medium text-white hover:bg-white/10 transition-colors"
          >
            See how it works
          </a>
        </motion.div>

        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.85, duration: 0.7 }}
          className="mt-16 flex flex-wrap items-center justify-center gap-x-10 gap-y-4 text-xs uppercase tracking-[0.18em] text-white/40"
        >
          <span>Ages 13–18</span>
          <span className="h-1 w-1 rounded-full bg-white/20" />
          <span>4 Weeks · Fully Virtual</span>
          <span className="h-1 w-1 rounded-full bg-white/20" />
          <span>Real Angel Investors</span>
          <span className="h-1 w-1 rounded-full bg-white/20" />
          <span>Open Year-Round</span>
        </motion.div>
      </div>
    </section>
  );
}
