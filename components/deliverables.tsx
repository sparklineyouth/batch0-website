import React from "react";

/**
 * What you leave with — concrete artifacts, no values-speak. Each item is
 * a thing that exists at the end of the cohort, produced by the student,
 * owned by the student.
 */
const DELIVERABLES: { title: string; body: string }[] = [
  {
    title: "A validated Lean Canvas",
    body: "Tested in interviews with strangers who owe you nothing.",
  },
  {
    title: "A shipped v1",
    body: "Landing page, no-code MVP, or working prototype. Live on the internet, with a URL you can send to anyone.",
  },
  {
    title: "A business model that holds up",
    body: "Revenue, pricing, and unit economics you can defend when someone sharp pushes back.",
  },
  {
    title: "A go-to-market plan",
    body: "Positioning, a distribution wedge, and a concrete path to your first hundred users.",
  },
  {
    title: "An investor-grade pitch deck",
    body: "Written, rehearsed, and delivered live at demo day.",
  },
  {
    title: "100% of your company",
    body: "SparkLine takes no equity, no IP, and no royalties. Everything you build is yours.",
  },
];

export default function Deliverables() {
  return (
    <section className="border-t border-line px-5 py-20 sm:px-6 md:py-28">
      <div className="mx-auto max-w-[1100px]">
        <h2 className="font-display text-[clamp(1.75rem,3.5vw,2.5rem)] font-bold leading-[1.08] tracking-[-0.02em] text-ink">
          What you leave with
        </h2>
        <p className="mt-4 max-w-[38rem] text-[15px] leading-[1.65] text-ink-soft">
          Every week ends in an artifact, built on your own company. By demo
          day the pile looks like this:
        </p>
        <ul className="mt-10 grid gap-x-10 gap-y-8 sm:grid-cols-2 lg:grid-cols-3">
          {DELIVERABLES.map((d) => (
            <li key={d.title} className="border-t-2 border-spark pt-4">
              <h3 className="text-[1.0625rem] font-semibold tracking-tight text-ink">
                {d.title}
              </h3>
              <p className="mt-1.5 text-[15px] leading-[1.6] text-ink-soft">
                {d.body}
              </p>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
