import React from "react";
import Link from "next/link";

// The real syllabus — four one-week sprints. The full week-by-week detail
// lives on /program; this is the home-page summary.
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

// The summary table in the broadsheet system's grammar: standard section
// anatomy (command head, hairline, shared left margin), mono lowercase
// chrome, off-white values. Sits inside the page's single shared container
// like every other section — no container of its own.
export default function Curriculum() {
  return (
    <section id="curriculum" className="border-t border-phosphor/25 py-14 md:py-20">
      <p className="cmdline font-mono">
        <b>cat curriculum.txt</b>{" "}
        <span className="mtime">· modified 2026-07-14</span>
      </p>
      <h2 className="t-head mt-4 text-ink">four sprints, four artifacts</h2>
      <p className="t-body mt-4 max-w-[38rem] text-ink-soft">
        Each sprint is one startup skill applied to your own company,
        closed out by a deliverable you shipped yourself.
      </p>

      <div className="mt-8 overflow-x-auto">
        <table className="w-full min-w-[560px] border-collapse text-left">
          <thead>
            <tr className="border-b border-phosphor/25">
              <th scope="col" className="t-small py-3 pr-4 font-mono font-medium lowercase tracking-[0.06em] text-phosphor/60">
                week
              </th>
              <th scope="col" className="t-small py-3 pr-4 font-mono font-medium lowercase tracking-[0.06em] text-phosphor/60">
                sprint
              </th>
              <th scope="col" className="t-small py-3 pr-4 font-mono font-medium lowercase tracking-[0.06em] text-phosphor/60">
                you build
              </th>
              <th scope="col" className="t-small py-3 font-mono font-medium lowercase tracking-[0.06em] text-phosphor/60">
                you ship
              </th>
            </tr>
          </thead>
          <tbody>
            {WEEKS.map((w) => (
              <tr key={w.week} className="border-b border-line last:border-b-0 align-top">
                {/* step numbers are NOT deal-zeroes — they stay faint */}
                <td className="t-small py-4 pr-4 font-mono lowercase text-ink-faint">{w.week}</td>
                <td className="t-body py-4 pr-4 font-semibold lowercase text-ink">{w.title}</td>
                <td className="t-small max-w-[26rem] py-4 pr-4 text-ink-soft">
                  {w.body}
                </td>
                <td className="t-small py-4 font-mono font-medium lowercase text-ink">
                  {w.deliverable}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* this section's one action */}
      <p className="t-small mt-5">
        <Link href="/program" className="link-ink">
          full week-by-week program
        </Link>{" "}
        <span aria-hidden className="text-phosphor">
          →
        </span>
      </p>
    </section>
  );
}
