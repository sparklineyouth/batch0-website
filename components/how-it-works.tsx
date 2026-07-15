import React from "react";
import Link from "next/link";
import type { SiteConfig } from "@/lib/site-config";

/**
 * How it works — the page's first QUIET movement. One job: "what happens
 * to me"; its one action is the /program link (one-ask rule: no apply CTA).
 * Standard section anatomy: hairline, command+mtime head on the rail,
 * content on the shared 12-column grid.
 */
export default function HowItWorks({ config }: { config: SiteConfig }) {
  const { derived } = config;
  const dates = derived.dateRangeLabel.replace("→", "to").toLowerCase();
  const steps: { title: string; body: string }[] = [
    {
      title: "apply",
      body: "Free. Come with an idea you want to build, or just a desire to learn. We admit students who show they'll actually do the work, not just ideas.",
    },
    {
      title: "get a decision by email",
      body: "Applications are reviewed on a rolling basis. Each application and thoughtfully and thouroughly reviewed by our team.",
    },
    {
      title: "enroll",
      body: `${derived.priceLabel} tuition, charged only if you're accepted. That's it. Nothing more. Refund terms are published on the refund policy page.`,
    },
    {
      title: "build season",
      body: "Validate, build, market, pitch and most importantly, transform your idea into a company.",
    },
    {
      title: "pitch at demo day",
      body: "The cohort closes with a live demo day where you present the company you built. Standouts may be offered batch0 sponsorship, a non-dilutive grant, decided on merit, never guaranteed.",
    },
  ];

  return (
    <section id="how-it-works" className="border-t border-phosphor/25 py-14 md:py-20">
      <p className="cmdline font-mono">
        <b>cat how-it-works.txt</b>{" "}
        <span className="mtime">· modified 2026-07-14</span>
      </p>
      <h2 className="t-head mt-4 text-ink">
        how it works: five steps{dates ? `, ${dates}` : ""}
      </h2>
      <div className="mt-6 grid grid-cols-12 gap-x-6">
        <ol className="col-span-12 md:col-span-8">
          {steps.map((s, i) => (
            <li
              key={s.title}
              className="grid grid-cols-[6ch_1fr] border-t border-line py-3.5 last:border-b last:border-line"
            >
              <span aria-hidden className="t-small font-mono text-ink-faint">
                0{i + 1}
              </span>
              <div>
                <h3 className="t-body font-semibold text-ink">{s.title}</h3>
                <p className="t-small mt-1 max-w-[64ch] text-ink-soft">
                  {s.body}
                </p>
              </div>
            </li>
          ))}
        </ol>
      </div>
      {/* this section's one action */}
      <p className="t-small mt-5">
        <Link href="/program" className="link-ink">
          see the full program
        </Link>{" "}
        <span aria-hidden className="text-phosphor">
          →
        </span>
      </p>
    </section>
  );
}
