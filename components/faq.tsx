"use client";
import React, { useState } from "react";
import { Plus } from "lucide-react";
import type { SiteConfig } from "@/lib/site-config";

export default function FAQ({ config }: { config: SiteConfig }) {
  const { derived } = config;
  const cohortPrefix = derived.cohortLabel
    ? `${derived.cohortLabel} (${derived.cohortName})`
    : derived.cohortName;

  const faqs = [
    {
      q: "Who is SparkLine Youth for?",
      a: "Any U.S. high schooler ages 13–18 with a business idea — or even a half-baked one — and the motivation to build it. No prior experience required.",
    },
    {
      q: "How much does it cost?",
      a: `${derived.priceLabel} for the full 4-week cohort. No hidden fees, no upsells. Comparable programs run $3,000–$8,000.`,
    },
    {
      q: "Is it really fully virtual?",
      a: "Yes. Pre-recorded video modules plus live weekly group sessions on Zoom and an active Discord community. You can join from anywhere in the U.S.",
    },
    {
      q: "Will I actually win real money?",
      a: "Yes. Demo Day ends live on Zoom in front of our sponsor grant panel. Top cohort startups win cash prizes from a pool funded by our sponsor partners — paid out directly to you, with zero equity taken. We also invite outside angel investors as observers; some may follow up with cohort standouts for separate investment conversations, but the cohort grant pool is the guaranteed prize.",
    },
    {
      q: "What if I don't have an idea yet?",
      a: "Week 1 is built for that. We walk you through customer discovery and problem validation so you can find a real opportunity — not just guess.",
    },
    {
      q: "How big are the cohorts?",
      a: `Small enough that mentors and peers know you by name. ${cohortPrefix} is capped at ${derived.capacityLabel} students.`,
    },
    {
      q: "What do I walk away with?",
      a: "A validated Lean Canvas, a complete business model, a go-to-market plan, and a polished, investor-ready pitch deck — plus the network and credibility to keep going.",
    },
    {
      q: "Does SparkLine Youth take equity or own my idea?",
      a: "No. You own 100% of your idea, your work, and your company — before, during, and after the cohort. SparkLine Youth takes no equity, no IP, and no royalties. The only thing we ask is that you let us say \"this project was built at SparkLine Youth\" when we talk about our alumni. That's it.",
    },
  ];

  const [open, setOpen] = useState<number | null>(0);

  return (
    <section id="faq" className="relative py-16 sm:py-20 md:py-32 px-5 sm:px-6">
      <div className="mx-auto max-w-4xl">
        <div className="grid gap-8 md:gap-16 md:grid-cols-12">
          <div className="md:col-span-4">
            <p className="text-[11px] sm:text-xs font-medium uppercase tracking-[0.22em] text-spark">
              FAQ
            </p>
            <h2 className="mt-3 text-[32px] sm:text-4xl md:text-5xl font-bold tracking-[-0.02em] text-white leading-[1.05]">
              Questions, answered.
            </h2>
          </div>

          <div className="md:col-span-8">
            <div className="divide-y divide-white/10 border-t border-white/10">
              {faqs.map((f, i) => {
                const isOpen = open === i;
                return (
                  <div key={f.q}>
                    <button
                      type="button"
                      onClick={() => setOpen(isOpen ? null : i)}
                      aria-expanded={isOpen}
                      aria-controls={`faq-panel-${i}`}
                      id={`faq-trigger-${i}`}
                      className="press flex w-full items-center justify-between gap-4 sm:gap-6 py-5 sm:py-6 text-left"
                    >
                      <span className="text-base sm:text-lg font-medium text-white">
                        {f.q}
                      </span>
                      <Plus
                        className={`h-4 w-4 shrink-0 text-white/40 transition-transform duration-200 ${
                          isOpen ? "rotate-45 text-spark" : ""
                        }`}
                      />
                    </button>
                    <div
                      id={`faq-panel-${i}`}
                      role="region"
                      aria-labelledby={`faq-trigger-${i}`}
                      hidden={!isOpen}
                      className={`grid overflow-hidden transition-[grid-template-rows,opacity] duration-300 ease-out ${
                        isOpen
                          ? "grid-rows-[1fr] opacity-100"
                          : "grid-rows-[0fr] opacity-0"
                      }`}
                    >
                      <div className="min-h-0">
                        <p className="max-w-2xl pb-5 sm:pb-6 pr-4 sm:pr-8 text-[14px] sm:text-[15px] text-white/75 leading-relaxed">
                          {f.a}
                        </p>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
