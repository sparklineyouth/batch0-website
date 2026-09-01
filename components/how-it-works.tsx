import React from "react";
import Link from "next/link";
import type { SiteConfig } from "@/lib/site-config";
import { ThemedImage } from "@/components/themed-image";
import { Section, Eyebrow, Fig } from "@/components/section-kit";

/**
 * The program — the page's main art beat.
 *
 * The same building, twice: steel frame under a crane, then the finished
 * tower with its windows lit. They are placed INSIDE the run of steps
 * rather than banded above or below it — the first plate lands where the
 * work starts, the second where it ships — so scrolling the five steps
 * physically walks the construction. That is the whole idea of the
 * section, told in pictures instead of stated in a caption.
 *
 * Both plates are theme-paired and carry the same radial dissolve as the
 * tree, so they meet the page the way every other anchor does.
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

  const plateAfter: Record<number, { night: string; day: string; fig: string; cap: string }> = {
    2: {
      night: "/build-night.png",
      day: "/build-day.png",
      fig: "04",
      cap: "break ground — week one",
    },
    4: {
      night: "/tower-night.png",
      day: "/tower-day.png",
      fig: "05",
      cap: "it stands — demo day",
    },
  };

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
        {steps.map((s, i) => {
          const plate = plateAfter[i];
          return (
            <React.Fragment key={s.title}>
              <li className="grid grid-cols-12 gap-x-6 gap-y-2 border-t border-line py-7 last:border-b">
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

              {plate && (
                <li className="grid grid-cols-12 gap-x-6 py-10">
                  <figure className="col-span-12 md:col-span-8 md:col-start-3">
                    <ThemedImage
                      night={plate.night}
                      day={plate.day}
                      alt=""
                      width={1672}
                      height={941}
                      sizes="(max-width: 768px) 92vw, 680px"
                      className="plate-feather h-auto w-full"
                    />
                    <figcaption className="mt-4">
                      <Fig n={plate.fig}>{plate.cap}</Fig>
                    </figcaption>
                  </figure>
                </li>
              )}
            </React.Fragment>
          );
        })}
      </ol>

      <p className="sec-body mt-10">
        <Link href="/program" className="link-ink">
          see the full week-by-week program
        </Link>
      </p>
    </Section>
  );
}
