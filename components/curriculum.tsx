import React from "react";
import { Reveal } from "@/components/ui/reveal";

const weeks = [
  {
    week: "Week 1",
    title: "Validate",
    body:
      "Lean Canvas. Problem-solution fit. Real customer interviews — not friends and family. End the week with a hypothesis you've actually tested in the wild.",
    deliverable: "Validated Lean Canvas",
  },
  {
    week: "Week 2",
    title: "Build",
    body:
      "Ship a v1 — landing page, no-code MVP, or working prototype. Business model, pricing, and unit economics that hold up to a sharp question.",
    deliverable: "MVP + Business Model",
  },
  {
    week: "Week 3",
    title: "Market",
    body:
      "Go-to-market plan, competitive landscape, brand positioning. Find your first hundred users — and the distribution wedge that gets you there.",
    deliverable: "GTM Plan + Brand",
  },
  {
    week: "Week 4",
    title: "Pitch",
    body:
      "Final pitch deck. Rehearsals with mentors. Pitch live on Zoom — cohort standouts earn SparkLine sponsorship and warm intros to investors in our network.",
    deliverable: "Sponsor + Investor Pitch (Live)",
  },
];

export default function Curriculum() {
  return (
    <section id="curriculum" className="relative py-16 sm:py-20 md:py-32 px-5 sm:px-6">
      <div className="relative mx-auto max-w-6xl">
        <div className="grid gap-8 md:gap-16 md:grid-cols-12">
          <Reveal className="md:col-span-4">
            <p className="text-[11px] sm:text-xs font-medium uppercase tracking-[0.22em] text-spark">
              The 4-week sprint
            </p>
            <h2 className="mt-3 text-[32px] sm:text-4xl md:text-5xl font-bold tracking-[-0.02em] text-white leading-[1.05]">
              Idea to investor-ready.
            </h2>
            <p className="mt-4 sm:mt-5 text-base sm:text-lg text-white/75 leading-relaxed">
              Each week is a startup skill block, with a deliverable
              built on your own company. You finish with a fundable
              startup package and a live pitch to our sponsorship +
              investor panel — not a participation certificate.
            </p>
          </Reveal>

          <ol className="md:col-span-8 relative">
            <div
              aria-hidden
              className="absolute left-[7px] top-2 bottom-2 w-px bg-white/10"
            />
            {weeks.map((w, i) => (
              <Reveal
                key={w.week}
                as="li"
                delay={i * 60}
                className="relative pb-8 sm:pb-10 pl-8 sm:pl-9 last:pb-0"
              >
                <span
                  aria-hidden
                  className="absolute left-0 top-1.5 h-[15px] w-[15px] rounded-full border border-spark/60 bg-black"
                >
                  <span className="absolute inset-1 rounded-full bg-spark" />
                </span>
                <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                  <p className="text-[10px] sm:text-[11px] font-medium uppercase tracking-[0.18em] sm:tracking-[0.2em] text-white/45">
                    {w.week}
                  </p>
                  <p className="text-[10px] sm:text-[11px] font-medium uppercase tracking-[0.18em] sm:tracking-[0.2em] text-spark">
                    {w.deliverable}
                  </p>
                </div>
                <h3 className="mt-2 text-xl sm:text-2xl md:text-3xl font-semibold tracking-tight text-white">
                  {w.title}
                </h3>
                <p className="mt-2 max-w-2xl text-[14px] sm:text-[15px] text-white/75 leading-relaxed">
                  {w.body}
                </p>
              </Reveal>
            ))}
          </ol>
        </div>
      </div>
    </section>
  );
}
