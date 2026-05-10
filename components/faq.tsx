"use client";
import React, { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Plus } from "lucide-react";

const faqs = [
  {
    q: "Who is SparkLine for?",
    a: "Any U.S. high schooler ages 13–18 with a business idea — or even a half-baked one — and the motivation to build it. No prior experience required.",
  },
  {
    q: "How much does it cost?",
    a: "$97 for the full 4-week cohort. That's it. No hidden fees, no upsells. Compare that to LaunchX or LeanGap at $3,000–$8,000+.",
  },
  {
    q: "Is it really fully virtual?",
    a: "Yes. Pre-recorded video modules + live weekly group sessions on Zoom + an active Discord community. You can join from anywhere in the U.S.",
  },
  {
    q: "Will I actually pitch real investors?",
    a: "Yes. On Week 4, we host a live Demo Day where you pitch your startup to real angel investors over Zoom. Investors who like your pitch can choose to fund you.",
  },
  {
    q: "What if I don't have an idea yet?",
    a: "Week 1 is built for that. We walk you through customer discovery and problem validation so you can find a real opportunity — not just guess.",
  },
  {
    q: "How big are the cohorts?",
    a: "Small enough that mentors and peers know you. Cohort 1 (Summer 2026) is capped at 24 students. Cohort 2 expands to 40.",
  },
  {
    q: "What do I walk away with?",
    a: "A validated Lean Canvas, a complete business model, a go-to-market plan, and a polished, investor-ready pitch deck — plus the network and credibility to keep going.",
  },
];

export default function FAQ() {
  const [open, setOpen] = useState<number | null>(0);

  return (
    <section id="faq" className="relative py-24 md:py-32 px-6">
      <div className="mx-auto max-w-3xl">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-100px" }}
          transition={{ duration: 0.6 }}
          className="text-center"
        >
          <p className="text-sm font-medium uppercase tracking-[0.2em] text-spark">
            FAQ
          </p>
          <h2 className="mt-3 text-4xl md:text-5xl font-bold tracking-tight text-white">
            Questions, answered.
          </h2>
        </motion.div>

        <div className="mt-12 divide-y divide-white/10 rounded-2xl border border-white/10 bg-white/[0.02]">
          {faqs.map((f, i) => (
            <div key={f.q}>
              <button
                onClick={() => setOpen(open === i ? null : i)}
                className="flex w-full items-center justify-between gap-4 px-6 py-5 text-left hover:bg-white/[0.02] transition-colors"
              >
                <span className="text-base md:text-lg font-medium text-white">
                  {f.q}
                </span>
                <Plus
                  className={`h-5 w-5 shrink-0 text-spark transition-transform duration-300 ${
                    open === i ? "rotate-45" : ""
                  }`}
                />
              </button>
              <AnimatePresence initial={false}>
                {open === i && (
                  <motion.div
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: "auto", opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    transition={{ duration: 0.3, ease: "easeOut" }}
                    className="overflow-hidden"
                  >
                    <p className="px-6 pb-5 text-white/60 leading-relaxed">
                      {f.a}
                    </p>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
