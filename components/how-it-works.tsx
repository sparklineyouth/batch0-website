import React from "react";
import Link from "next/link";
import type { SiteConfig } from "@/lib/site-config";

/**
 * How it works — the page's first QUIET section (volume rhythm: the loud
 * cascade hero needs rest after it). One job: answer "what happens to me".
 * Its one action is the /program link; per the one-ask rule there is no
 * apply CTA here.
 *
 * The real sequence, straight from the application lifecycle the platform
 * enforces (draft → submitted → accepted → paid → enrolled → demo day).
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
    <section
      id="how-it-works"
      className="border-t border-phosphor/25 px-5 py-14 sm:px-6 md:py-20"
    >
      <div className="mx-auto max-w-[1100px]">
        <p className="cmdline font-mono">
          <b>cat how-it-works.txt</b>{" "}
          <span className="mtime">· modified 2026-07-14</span>
        </p>
        <h2 className="mt-4 font-display text-[clamp(1.375rem,2.6vw,1.875rem)] leading-[1.05] text-ink">
          how it works: five steps{dates ? `, ${dates}` : ""}
        </h2>
        <ol className="mt-6 max-w-[72ch]">
          {steps.map((s, i) => (
            <li
              key={s.title}
              className="grid grid-cols-[6ch_1fr] border-t border-line py-3.5 last:border-b last:border-line"
            >
              <span aria-hidden className="font-mono text-[13px] text-phosphor">
                0{i + 1}
              </span>
              <div>
                <h3 className="text-[14.5px] font-semibold text-ink">{s.title}</h3>
                <p className="mt-1 max-w-[64ch] text-[13.5px] leading-[1.6] text-ink-soft">
                  {s.body}
                </p>
              </div>
            </li>
          ))}
        </ol>
        {/* this section's one action */}
        <p className="mt-5 text-[13.5px]">
          <Link href="/program" className="link-ink">
            see the full program
          </Link>{" "}
          <span aria-hidden className="text-phosphor">
            →
          </span>
        </p>
      </div>
    </section>
  );
}
