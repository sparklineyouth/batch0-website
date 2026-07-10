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
      body: "Free. One form about you and what you want to build: a real idea, a half-formed hunch, or nothing yet. All three are fine; week one exists to find the idea.",
    },
    {
      title: "Get a decision by email",
      body: "Applications are reviewed on a rolling basis. We admit students who show they'll actually do the work.",
    },
    {
      title: "Enroll",
      body: `${derived.priceLabel} tuition, charged only if you're accepted. That's the whole cost: no upsells, no materials fees. Refund terms are published on the refund policy page.`,
    },
    {
      title: "Build for four sprint weeks",
      body: "Validate, build, market, pitch — one sprint each week, each ending in a deliverable for your own company. Live sessions run on Zoom.",
    },
    {
      title: "Pitch at demo day",
      body: "The cohort closes with a live demo day where you present the company you built. Standouts may be offered SparkLine sponsorship: a non-dilutive grant, decided on merit, never guaranteed.",
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
            Five steps between reading this sentence and pitching a company
            you built. The dates are set by the cohort calendar
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
