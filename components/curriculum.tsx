import React from "react";
import Link from "next/link";

// The real syllabus — four sprints (each a taught week + a build week),
// bookended by kickoff and demo day: nine weeks total. The full
// week-by-week detail lives on /program; this is the home-page summary.
export const WEEKS = [
  {
    week: "Step 1",
    title: "Validate",
    body: "Lean Canvas, problem-solution fit, and customer interviews with strangers. End the week with a hypothesis you've tested in the wild.",
    deliverable: "Validated Lean Canvas",
  },
  {
    week: "Step 2",
    title: "Build",
    body: "Ship a v1: landing page, no-code MVP, or working prototype. Business model, pricing, and unit economics that hold up to a sharp question.",
    deliverable: "MVP + business model",
  },
  {
    week: "Step 3",
    title: "Market",
    body: "Go-to-market plan, competitive landscape, positioning. Find your first hundred users and the distribution wedge that gets you there.",
    deliverable: "GTM plan + brand",
  },
  {
    week: "Step 4",
    title: "Pitch",
    body: "Final deck, rehearsals, and a live pitch at demo day. Standouts may be offered batch0 sponsorship. Never guaranteed.",
    deliverable: "Live demo-day pitch",
  },
];

export default function Curriculum() {
  return (
    <section id="curriculum" className="border-t border-line px-5 py-20 sm:px-6 md:py-28">
      <div className="mx-auto max-w-[1100px]">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h2 className="font-display text-[clamp(1.75rem,3.5vw,2.5rem)] font-bold leading-[1.08] tracking-[-0.02em] text-ink">
              Four sprints, four artifacts
            </h2>
            <p className="mt-4 max-w-[38rem] text-[15px] leading-[1.65] text-ink-soft">
              Each sprint is one startup skill applied to your own company:
              a taught week, then a build week to apply it, closed out by a
              deliverable you shipped yourself. With kickoff and demo day,
              that's the full nine weeks.
            </p>
          </div>
          <Link href="/program" className="link-ink text-[15px] font-medium">
            Full week-by-week program
          </Link>
        </div>

        <div className="mt-10 overflow-x-auto">
          <table className="w-full min-w-[560px] border-collapse text-left">
            <thead>
              <tr className="border-b border-ink/20">
                <th scope="col" className="py-3 pr-4 font-mono text-[12px] font-medium uppercase tracking-[0.08em] text-ink-faint">
                  Week
                </th>
                <th scope="col" className="py-3 pr-4 font-mono text-[12px] font-medium uppercase tracking-[0.08em] text-ink-faint">
                  Sprint
                </th>
                <th scope="col" className="py-3 pr-4 font-mono text-[12px] font-medium uppercase tracking-[0.08em] text-ink-faint">
                  You build
                </th>
                <th scope="col" className="py-3 font-mono text-[12px] font-medium uppercase tracking-[0.08em] text-ink-faint">
                  You ship
                </th>
              </tr>
            </thead>
            <tbody>
              {WEEKS.map((w) => (
                <tr key={w.week} className="border-b border-line last:border-b-0 align-top">
                  <td className="py-4 pr-4 font-mono text-[13px] text-ink-faint">{w.week}</td>
                  <td className="py-4 pr-4 text-[15px] font-semibold text-ink">{w.title}</td>
                  <td className="max-w-[26rem] py-4 pr-4 text-[14px] leading-[1.55] text-ink-soft">
                    {w.body}
                  </td>
                  <td className="py-4 font-mono text-[13px] font-medium text-ink">
                    {w.deliverable}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}
