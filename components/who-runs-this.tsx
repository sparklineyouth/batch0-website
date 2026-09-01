import React from "react";
import type { SiteConfig } from "@/lib/site-config";
import { Section, Eyebrow, Fig } from "@/components/section-kit";
import { CohortAnchor } from "@/components/anchors";
import { ZeroThread } from "@/components/zero-thread";

/**
 * Who runs this — trust, and the honest first-cohort argument, in one
 * section. <FoundingCohort/> used to carry the second half separately;
 * splitting them meant the page said "cohort 1 is the first" twice with
 * different framing, so it is folded in here where it belongs: the same
 * two people who read every application are the reason going first is
 * worth anything.
 *
 * NOTHING here may become a fabricated testimonial or invented metric.
 * The section names the missing track record before arguing around it.
 */

const REASONS: { k: string; v: string }[] = [
  {
    k: "the smallest room we will ever run",
    v: "Every later cohort is bigger. This is the highest founder-attention-per-student ratio batch0 will ever have.",
  },
  {
    k: "the founders are in the room",
    v: "Not TAs, not a recorded course. Rishabh and Shresht run every live session, read every application, and give feedback directly.",
  },
  {
    k: "you set the precedent",
    v: "The first cohort's companies become the examples every future cohort is shown. Being early is the whole reason your work gets pointed at.",
  },
];

export default function WhoRunsThis({ config }: { config: SiteConfig }) {
  const contactEmail = config.settings.contactEmail;
  const cohortCode = config.cohort?.cohortNumber
    ? String(config.cohort.cohortNumber).padStart(3, "0")
    : "001";

  return (
    <Section id="who-runs-this">
      <div className="grid grid-cols-12 items-start gap-x-6 gap-y-14">
        <div className="col-span-12 md:col-span-7">
          <Eyebrow>who runs this</Eyebrow>
          <h2 className="sec-display mt-6 max-w-[14ch]">
            cohort <ZeroThread>{cohortCode}</ZeroThread> is the first one.
          </h2>
          <p className="sec-lead mt-8 max-w-[46ch]">
            batch0 is built and run by{" "}
            <strong className="font-medium text-ink">
              Rishabh Dagli and Shresht Chopra
            </strong>
            , two 17-year-old founders. We built it to give high schoolers the
            chance we wish we had.
          </p>
          <p className="sec-body mt-5 max-w-[46ch]">
            There are no glossy alumni stats yet, and we won&apos;t invent any.
            No testimonials, no &ldquo;$2M raised by our graduates,&rdquo; no
            logo wall. Anyone showing you those numbers in their first year is
            making them up.
          </p>
        </div>

        <div className="col-span-12 md:col-span-4 md:col-start-9">
          <div className="mx-auto max-w-[20rem] md:mx-0">
            <CohortAnchor />
            <Fig n="04" className="mt-5">
              first cohort, capped small
            </Fig>
          </div>
        </div>
      </div>

      <dl className="mt-16 grid grid-cols-12 gap-x-6">
        {REASONS.map((r, i) => (
          <div
            key={r.k}
            className="col-span-12 border-t border-line py-6 md:col-span-4"
          >
            <span
              aria-hidden
              className="font-display text-[15px] leading-none text-ink-faint"
            >
              0{i + 1}
            </span>
            <dt className="mt-3 text-[16.5px] font-medium leading-[1.35] text-ink">
              {r.k}
            </dt>
            <dd className="sec-body mt-2 max-w-[38ch]">{r.v}</dd>
          </div>
        ))}
      </dl>

      <p className="sec-body mt-12">
        <a href={`mailto:${contactEmail}`} className="link-ink font-medium">
          {contactEmail}
        </a>
        <span className="text-ink-faint">
          {" "}
          — we answer every parent question personally, usually within a couple
          of days. The legal entity is Sparkline Youth LLC.
        </span>
      </p>
    </Section>
  );
}
