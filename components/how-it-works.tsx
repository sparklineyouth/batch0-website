import React from "react";
import type { SiteConfig } from "@/lib/site-config";

/**
 * The real sequence, straight from the application lifecycle the platform
 * enforces (draft → submitted → accepted → paid → enrolled → demo day).
 * Numbered because it genuinely is a sequence.
 */
export default function HowItWorks({ config }: { config: SiteConfig }) {
  const { derived } = config;
  const steps: { title: string; body: string }[] = [
    {
      title: "Apply",
      body: "Free. Come with an idea you want to build, or just a desire to learn. We admit students who show they'll actually do the work, not just ideas.",
    },
    {
      title: "Get a decision by email",
      body: "Applications are reviewed on a rolling basis. Each application and thoughtfully and thouroughly reviewed by our team.",
    },
    {
      title: "Enroll",
      body: `${derived.priceLabel} tuition, charged only if you're accepted. That's it. Nothing more. Refund terms are published on the refund policy page.`,
    },
    {
      title: "Build season",
      body: "Validate, build, market, pitch and most importantly, transform your idea into a company.",
    },
    {
      title: "Pitch at demo day",
      body: "The cohort closes with a live demo day where you present the company you built. Standouts may be offered Sparkline sponsorship, a non-dilutive grant, decided on merit, never guaranteed.",
    },
  ];

  return (
    <section id="how-it-works" className="border-t border-line px-5 py-20 sm:px-6 md:py-28">
      <div className="mx-auto grid max-w-[1100px] gap-10 md:grid-cols-12 md:gap-8">
        <div className="md:col-span-4">
          <h2 className="font-display text-[clamp(1.75rem,3.5vw,2.5rem)] font-bold leading-[1.08] tracking-[-0.02em] text-ink">
            How it works
          </h2>
          <p className="mt-4 max-w-[34rem] text-[15px] leading-[1.65] text-ink-soft">
            There are just 5 steps to building a real company at Sparkline. The dates are set by the {derived.cohortLabel} calendar
            {derived.dateRangeLabel
              ? ` (${derived.dateRangeLabel.replace("→", "–")})`
              : ""}
            .
          </p>
        </div>
        <ol className="md:col-span-8">
          {steps.map((s, i) => (
            <li
              key={s.title}
              className="flex gap-5 border-b border-line py-6 first:pt-0 last:border-b-0 sm:gap-6"
            >
              <span
                aria-hidden
                className="mt-0.5 font-mono text-[13px] font-medium text-ink-faint"
              >
                {i + 1}
              </span>
              <div>
                <h3 className="text-[1.0625rem] font-semibold tracking-tight text-ink">
                  {s.title}
                </h3>
                <p className="mt-1.5 max-w-[38rem] text-[15px] leading-[1.6] text-ink-soft">
                  {s.body}
                </p>
              </div>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
