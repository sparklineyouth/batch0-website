import React from "react";
import { Lightbulb, Hammer, Rocket, Trophy } from "lucide-react";
import { Reveal } from "@/components/ui/reveal";

const weeks = [
  {
    week: "Week 1",
    title: "Validate",
    icon: Lightbulb,
    body: "Lean Canvas. Problem/solution fit. Real customer discovery interviews. End the week with a hypothesis you've actually tested.",
    deliverable: "Validated Lean Canvas",
  },
  {
    week: "Week 2",
    title: "Build",
    icon: Hammer,
    body: "Business Model Canvas, revenue model, pricing strategy. We turn your idea into a viable business — not a school project.",
    deliverable: "Business Model + Pricing",
  },
  {
    week: "Week 3",
    title: "Market",
    icon: Rocket,
    body: "Go-to-market strategy, competitive analysis, brand positioning. Find your first 100 customers and the wedge that gets you there.",
    deliverable: "GTM Plan + Brand",
  },
  {
    week: "Week 4",
    title: "Pitch",
    icon: Trophy,
    body: "Final pitch deck. Demo day rehearsals with mentors. Pitch live, on Zoom, to real angel investors who can fund you.",
    deliverable: "Investor Pitch (Live)",
  },
];

export default function Curriculum() {
  return (
    <section id="curriculum" className="relative py-16 md:py-32 px-6">
      <div className="absolute inset-0 grid-bg opacity-40 pointer-events-none" />
      <div className="relative mx-auto max-w-6xl">
        <Reveal className="text-center max-w-3xl mx-auto">
          <p className="text-sm font-medium uppercase tracking-[0.2em] text-spark">
            The 4-week sprint
          </p>
          <h2 className="mt-3 text-4xl md:text-5xl font-bold tracking-tight text-white">
            From raw idea to investor-ready.
          </h2>
          <p className="mt-5 text-lg text-white/60">
            Every week has a structured deliverable. You finish the program
            with a complete, fundable startup package — not a participation
            certificate.
          </p>
        </Reveal>

        <div className="mt-16 relative">
          <div
            aria-hidden
            className="absolute left-1/2 -translate-x-1/2 top-0 bottom-0 w-px bg-gradient-to-b from-transparent via-spark/40 to-transparent hidden md:block"
          />
          <div className="grid gap-6 md:gap-12">
            {weeks.map((w, i) => (
              <Reveal
                key={w.week}
                delay={i * 80}
                className={`relative md:grid md:grid-cols-2 md:gap-12 items-center ${
                  i % 2 === 1 ? "md:[&>*:first-child]:order-2" : ""
                }`}
              >
                <div
                  className={`relative rounded-2xl border border-white/10 bg-gradient-to-br from-white/[0.04] to-white/[0.01] p-7 md:p-8 hover:border-spark/30 transition-colors duration-150 ${
                    i % 2 === 1 ? "md:text-right" : ""
                  }`}
                >
                  <div
                    className={`flex items-center gap-3 ${
                      i % 2 === 1 ? "md:justify-end" : ""
                    }`}
                  >
                    <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-spark text-black">
                      <w.icon className="h-5 w-5" />
                    </div>
                    <span className="text-xs uppercase tracking-widest text-spark">
                      {w.week}
                    </span>
                  </div>
                  <h3 className="mt-4 text-3xl font-bold text-white">
                    {w.title}
                  </h3>
                  <p className="mt-3 text-white/60 leading-relaxed">{w.body}</p>
                  <div
                    className={`mt-5 inline-flex items-center gap-2 text-xs font-medium text-spark ${
                      i % 2 === 1 ? "md:flex-row-reverse" : ""
                    }`}
                  >
                    <span className="h-px w-6 bg-spark" />
                    Deliverable: {w.deliverable}
                  </div>
                </div>

                <div className="hidden md:flex justify-center">
                  <div className="relative">
                    <div className="h-20 w-20 rounded-full bg-spark/10 border border-spark/30 flex items-center justify-center">
                      <span className="text-3xl font-black text-spark">
                        0{i + 1}
                      </span>
                    </div>
                    <div className="absolute inset-0 rounded-full bg-spark/20 blur-xl -z-10" />
                  </div>
                </div>
              </Reveal>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
