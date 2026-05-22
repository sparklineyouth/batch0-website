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
      a: "Any U.S. high schooler ages 13–18 who wants to learn how to build a real startup — and is willing to put in 4 weeks of focused work. Bring an idea, a half-formed hunch, or nothing at all. No prior experience required, but the application is selective.",
    },
    {
      q: "How much does it cost?",
      a: `${derived.priceLabel} for the full 4-week cohort. No hidden fees, no upsells. Comparable programs run $3,000–$8,000.`,
    },
    {
      q: "Is it really fully virtual?",
      a: "Yes. Pre-recorded skill modules plus live weekly group sessions on Zoom, 1:1 mentor checkpoints, and an active Discord community. You can join from anywhere in the U.S.",
    },
    {
      q: "How does the sponsorship and investor side actually work?",
      a: "Pitch Day at the end of Week 4 happens live on Zoom in front of the SparkLine team and our investor network. Cohort standouts may be offered direct sponsorship from SparkLine, and we make warm introductions to investors in our network — angels, scout funds, and pre-seed VCs interested in young founders. Sponsorship, if offered, is a non-dilutive grant. Investor intros are connections, not checks. We make no guarantee any of this leads to funding; what investors decide is up to them.",
    },
    {
      q: "What am I actually paying for?",
      a: "Tuition pays for the program: the 4-week curriculum, our team's mentor support, the Discord community, and a live pitch slot in front of our investor network. You are not paying for funding, an investment, or a sponsorship offer — those are merit-based, separate, and never guaranteed.",
    },
    {
      q: "What if I don't have an idea yet?",
      a: "Week 1 is built for that. We walk you through customer discovery and structured idea validation — so you find a real problem worth solving, not just guess at one.",
    },
    {
      q: "How big are the cohorts?",
      a: `Small enough that mentors and peers know you by name. ${cohortPrefix} is capped at ${derived.capacityLabel} students.`,
    },
    {
      q: "What do I walk away with?",
      a: "A validated Lean Canvas, a working v1 of your startup, a real business model, a go-to-market plan, and an investor-ready pitch deck — plus a live pitch in front of our investor network, with warm intros and a shot at SparkLine sponsorship for cohort standouts. Funding is never guaranteed.",
    },
    {
      q: "Does SparkLine Youth take equity or own my idea?",
      a: "No. You own 100% of your idea, your work, and your company — before, during, and after the cohort. SparkLine Youth takes no equity, no IP, and no royalties on the program itself. Sponsorship, if offered, is a non-dilutive grant. Any investment that comes from our investor intros is a separate conversation between you and the investor — we never take a cut, and we never guarantee a check.",
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
