import React from "react";
import Link from "next/link";
import type { SiteConfig } from "@/lib/site-config";
import { Section, Eyebrow } from "@/components/section-kit";

/**
 * The program — five steps, as a plain numbered run.
 *
 * The build/tower construction plates that used to be interleaved here
 * have been removed, so the steps carry the section on their own. The
 * numbered rail down the left is what gives it structure without art.
 */

type Step = { title: string; body: string };

export default function HowItWorks({ config }: { config: SiteConfig }) {
  const { derived } = config;
  const dates = derived.dateRangeLabel.replace("→", "to").toLowerCase();

  const steps: Step[] = [
    {
      title: "apply",
      body: "Free. Come with an idea you want to build, or just a desire to learn. We admit students who show they'll actually do the work, not just ideas.",
    },
    {
      title: "get a decision by email",
      body: "Applications are reviewed on a rolling basis. Each application is thoughtfully and thoroughly reviewed by our team.",
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
    <Section id="how-it-works">
      <div className="max-w-[46rem]">
        <Eyebrow>the program</Eyebrow>
        <h2 className="sec-display mt-6 max-w-[14ch]">
          nine weeks. five steps. one{" "}
          <span className="text-phosphor">build.</span>
        </h2>
        <p className="sec-lead mt-8 max-w-[44ch]">
          {dates ? `${dates}. ` : ""}Live sessions, mentorship and a demo day,
          all online, designed to fit around school.
        </p>
      </div>

      <ol className="mt-16">
        {steps.map((s, i) => (
          <li
            key={s.title}
            className="grid grid-cols-12 gap-x-6 gap-y-2 border-t border-line py-7 last:border-b"
          >
            <span
              aria-hidden
              className="col-span-12 font-display text-[20px] leading-none text-ink-faint md:col-span-2"
            >
              0{i + 1}
            </span>
            <h3 className="col-span-12 text-[19px] font-medium leading-[1.3] text-ink md:col-span-4">
              {s.title}
            </h3>
            <p className="sec-body col-span-12 max-w-[52ch] md:col-span-6">
              {s.body}
            </p>
          </li>
        ))}
      </ol>

      <p className="sec-body mt-10">
        <Link href="/program" className="link-ink">
          see the full week-by-week program
        </Link>
      </p>
    </Section>
  );
}
