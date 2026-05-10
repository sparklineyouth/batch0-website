"use client";
import React from "react";
import Image from "next/image";
import Link from "next/link";
import { motion } from "framer-motion";

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
            Cohort 1 launches Summer 2026. 24 seats. $97. Real investors on
            Demo Day. Apply in under 5 minutes.
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

          <div className="relative mx-auto max-w-2xl overflow-hidden rounded-3xl border border-white/10 bg-gradient-to-b from-zinc-900/80 to-black p-10 md:p-14 shadow-[0_30px_80px_-20px_rgba(250,204,21,0.25)]">
            <div className="grid gap-8 md:grid-cols-3">
              <Stat label="Application fee" value="$0" sub="Free to apply" />
              <Stat label="If accepted" value="$97" sub="One-time, full cohort" />
              <Stat label="Cohort size" value="24" sub="Summer 2026" />
            </div>
            <div className="mt-10 flex flex-col items-center gap-3">
              <Link
                href="/signup"
                className="inline-flex h-12 items-center justify-center gap-2 rounded-lg bg-spark px-7 text-sm font-semibold text-black shadow-[0_0_24px_-6px_rgba(250,204,21,0.7)] transition hover:bg-spark-200"
              >
                Start your application
                <span aria-hidden>→</span>
              </Link>
              <p className="text-xs text-white/40">
                Already applied?{" "}
                <Link href="/login" className="text-white/60 hover:text-spark">
                  Log in
                </Link>
              </p>
            </div>
          </div>

          <p className="mt-6 text-center text-xs text-white/40">
            Limited seats · Applications reviewed on a rolling basis · Questions?{" "}
            <a
              href="mailto:sparkline.youth@gmail.com"
              className="text-spark hover:underline"
            >
              sparkline.youth@gmail.com
            </a>
          </p>
        </motion.div>
      </div>
    </section>
  );
}

function Stat({
  label,
  value,
  sub,
}: {
  label: string;
  value: string;
  sub: string;
}) {
  return (
    <div className="text-center">
      <div className="text-xs font-medium uppercase tracking-[0.2em] text-white/40">
        {label}
      </div>
      <div className="mt-2 text-4xl font-bold tracking-tight text-spark">
        {value}
      </div>
      <div className="mt-1 text-xs text-white/50">{sub}</div>
    </div>
  );
}
