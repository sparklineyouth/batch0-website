import React from "react";
import { Reveal } from "@/components/ui/reveal";

const weeks = [
  {
    week: "Week 1",
    title: "Validate",
    body:
      "Lean Canvas. Problem/solution fit. Real customer-discovery interviews. End the week with a hypothesis you've actually tested.",
    deliverable: "Validated Lean Canvas",
  },
  {
    week: "Week 2",
    title: "Build",
    body:
      "Business Model Canvas, revenue model, pricing strategy. Turn your idea into a viable business — not a school project.",
    deliverable: "Business Model + Pricing",
  },
  {
    week: "Week 3",
    title: "Market",
    body:
      "Go-to-market strategy, competitive analysis, brand positioning. Find your first hundred customers and the wedge that gets you there.",
    deliverable: "GTM Plan + Brand",
  },
  {
    week: "Week 4",
    title: "Pitch",
    body:
      "Final pitch deck. Demo Day rehearsals with mentors. Pitch live on Zoom for the cohort grant pool — funded by our sponsor partners. Cash prizes, zero equity.",
    deliverable: "Grant Pitch (Live)",
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
              Every week ends with a structured deliverable. You finish the
              program with a complete, fundable startup package — not a
              participation certificate.
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
