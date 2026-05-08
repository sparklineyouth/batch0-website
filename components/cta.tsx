"use client";
import React from "react";
import Image from "next/image";
import { motion } from "framer-motion";
import FilloutEmbed from "./fillout-embed";

export default function CTA() {
  return (
    <section id="apply" className="relative py-24 md:py-32 px-6">
      <div className="mx-auto max-w-5xl">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-100px" }}
          transition={{ duration: 0.6 }}
          className="text-center"
        >
          <div className="mx-auto w-16 h-16 animate-spark-pulse">
            <Image src="/logo.svg" alt="SparkLine" width={64} height={64} />
          </div>
          <p className="mt-6 text-sm font-medium uppercase tracking-[0.2em] text-spark">
            Reserve your seat
          </p>
          <h2 className="mt-3 text-4xl md:text-6xl font-bold tracking-tighter text-white">
            Your startup, <span className="shine">funded</span>,<br />
            before you graduate.
          </h2>
          <p className="mt-5 max-w-xl mx-auto text-lg text-white/60">
            Cohort 1 launches Summer 2026. 20 seats. $97. Real investors on
            Demo Day. Apply in under 2 minutes.
          </p>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 30 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-100px" }}
          transition={{ duration: 0.7 }}
          className="relative mt-12"
        >
          <div
            aria-hidden
            className="absolute -top-20 left-1/2 -translate-x-1/2 h-72 w-[36rem] rounded-full bg-spark/25 blur-[140px] pointer-events-none"
          />
          <div
            aria-hidden
            className="absolute -inset-px rounded-3xl bg-gradient-to-b from-spark/40 via-spark/10 to-transparent pointer-events-none"
            style={{
              padding: "1px",
              WebkitMask:
                "linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0)",
              WebkitMaskComposite: "xor",
              maskComposite: "exclude",
            }}
          />
          <div className="relative overflow-hidden rounded-3xl border border-white/10 bg-gradient-to-b from-zinc-900/80 to-black shadow-[0_30px_80px_-20px_rgba(250,204,21,0.25)]">
            <div className="flex items-center justify-between gap-3 px-5 py-3 border-b border-white/10 bg-black/40">
              <div className="flex items-center gap-2">
                <span className="h-2.5 w-2.5 rounded-full bg-red-400/80" />
                <span className="h-2.5 w-2.5 rounded-full bg-amber-300/80" />
                <span className="h-2.5 w-2.5 rounded-full bg-emerald-400/80" />
              </div>
              <div className="flex items-center gap-2 text-xs text-white/50">
                <Image src="/logo.svg" alt="" width={14} height={14} />
                sparklineyouth.org/apply
              </div>
              <div className="text-[10px] uppercase tracking-widest text-spark">
                Live
              </div>
            </div>
            <div className="bg-white">
              <FilloutEmbed formId="i1adofwJdnus" />
            </div>
          </div>
          <p className="mt-6 text-center text-xs text-white/40">
            Limited seats · Applications reviewed on a rolling basis · Questions?{" "}
            <a
              href="mailto:hello@sparklineyouth.org"
              className="text-spark hover:underline"
            >
              hello@sparklineyouth.org
            </a>
          </p>
        </motion.div>
      </div>
    </section>
  );
}
