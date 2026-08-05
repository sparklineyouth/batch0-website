import React from "react";
import type { SiteConfig } from "@/lib/site-config";
import { ZeroThread } from "@/components/zero-thread";

/**
 * Cohort 001 — the honest proof section. There are no alumni, no outcome
 * stats, and no testimonials, so this section does not pretend otherwise:
 * it names the gap first, then argues why being in the first cohort is
 * worth something on its own terms.
 *
 * NOTHING here may become a fabricated testimonial or invented metric.
 * The opening paragraph moved up from the old fine-print "who runs this"
 * block, which is where this argument originally lived.
 */
export default function FoundingCohort({ config }: { config: SiteConfig }) {
  const { derived } = config;
  const cohortCode = config.cohort?.cohortNumber
    ? String(config.cohort.cohortNumber).padStart(3, "0")
    : "001";
  const capacity = derived.capacityLabel;

  const reasons: { k: string; v: string }[] = [
    {
      k: "smallest room we will ever run",
      v: `Cohort ${cohortCode} is capped at ${capacity}. Every later cohort will be bigger. This is the highest founder-attention-per-student ratio batch0 will ever have.`,
    },
    {
      k: "the founders are in the room",
      v: "Not TAs, not a recorded course. Rishabh and Taran run every live session, read every application, and give feedback directly.",
    },
    {
      k: "you set the precedent",
      v: "The first cohort's companies become the examples every future cohort is shown. Being early is the whole reason your work gets pointed at.",
    },
  ];

  return (
    <section id="founding-cohort" className="border-t border-line py-14 md:py-20">
      <p className="section-intro">why going first is the advantage.</p>

      <h2 className="t-head mt-4 max-w-[20ch] text-ink">
        cohort <ZeroThread>{cohortCode}</ZeroThread> is the first one.
      </h2>

      <div className="mt-6 grid grid-cols-12 gap-x-6 gap-y-8">
        <div className="col-span-12 md:col-span-5">
          <p className="t-body max-w-[46ch] text-ink-soft">
            There are no glossy alumni stats to show you yet, and we
            won&apos;t invent any. No testimonials, no &ldquo;$2M raised by
            our graduates,&rdquo; no logo wall. Anyone showing you those
            numbers in their first year is making them up.
          </p>
          <p className="t-body mt-3 max-w-[46ch] text-ink-soft">
            What we can tell you is what being first actually buys you.
          </p>
        </div>

        <ol className="col-span-12 md:col-span-7">
          {reasons.map((r, i) => (
            <li
              key={r.k}
              className="grid grid-cols-[6ch_1fr] border-t border-line py-3.5 last:border-b last:border-line"
            >
              <span aria-hidden className="t-small font-mono text-ink-faint">
                0{i + 1}
              </span>
              <div>
                <h3 className="t-body font-semibold text-ink">{r.k}</h3>
                <p className="t-small mt-1 max-w-[58ch] text-ink-soft">
                  {r.v}
                </p>
              </div>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
