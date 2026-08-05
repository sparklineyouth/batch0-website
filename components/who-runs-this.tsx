import React from "react";
import type { SiteConfig } from "@/lib/site-config";
import { FoundersIcon } from "@/components/icons/pixel-icon";

/**
 * Who runs this — pulled up out of the old fine-print so the trust beat
 * lands before the founding-cohort pitch instead of after the FAQ. One
 * job: "who are these two, and why did they build it". One action: hello@.
 *
 * The "cohort 1 is deliberately the first" paragraph that used to live
 * here now opens <FoundingCohort/> — it is that section's whole argument,
 * and saying it twice would blunt both.
 */
export default function WhoRunsThis({ config }: { config: SiteConfig }) {
  const contactEmail = config.settings.contactEmail;

  return (
    <section id="who-runs-this" className="border-t border-line py-14 md:py-20">
      <p className="section-intro">the two founders who run every session.</p>

      <div className="mt-6 flex items-center gap-3.5">
        <FoundersIcon size={5} />
        <h2 className="t-body font-semibold text-ink">who runs this</h2>
      </div>

      <div className="t-body mt-4 max-w-[58ch] text-ink-soft">
        <p>
          batch0 is built and run by{" "}
          <strong className="font-semibold text-ink">
            Rishabh Dagli and Taran Bethi
          </strong>
          , two 17-year-old serial founders. We built batch0 to give high
          schoolers the same chance we wish we had: to build a real company
          with mentorship and support, and even the chance of funding.
          {/* TODO(RISH): 2–3 public receipts (links) — shipped products,
              hardware, repos, press. Logged in NEEDED_FACTS.md. */}
        </p>
        <p className="t-small mt-3 text-ink-faint">
          the legal entity is Sparkline Youth LLC.
        </p>
        {/* this section's one action */}
        <p className="mt-4">
          <a
            href={`mailto:${contactEmail}`}
            className="link-ink t-body font-medium"
          >
            {contactEmail}
          </a>
        </p>
      </div>
    </section>
  );
}
