import React from "react";

/**
 * Who runs this — the parent-trust section. Real person, real legal
 * entity, real contact. Receipts get added when Rish supplies public
 * links (NEEDED_FACTS); no invented credentials in the meantime.
 */
export default function Founder({
  contactEmail = "hello@batch0.org",
}: {
  /** Admin-set contact from site_settings — the one real inbox. */
  contactEmail?: string;
}) {
  return (
    <section id="who-runs-this" className="border-t border-line bg-wash px-5 py-20 sm:px-6 md:py-28">
      <div className="mx-auto grid max-w-[1100px] gap-10 md:grid-cols-12 md:gap-8">
        <div className="md:col-span-4">
          <h2 className="font-display text-[clamp(1.75rem,3.5vw,2.5rem)] font-bold leading-[1.08] tracking-[-0.02em] text-ink">
            Who runs this
          </h2>
        </div>
        <div className="md:col-span-8">
          <p className="max-w-[40rem] text-[1.0625rem] leading-[1.65] text-ink-soft">
            batch0 is built and run by{" "}
            <strong className="font-semibold text-ink">Rishabh Dagli and Taran Bethi</strong>, two
            17-year-old serial founders. We built batch0 to give high schoolers the same chance
            that we wish we had: to build a REAL company with mentorship and support, and even the chance
            of funding!
            {/* TODO(RISH): 2–3 public receipts (links) — shipped products,
                hardware, repos, press — to add specifics here. Logged in
                NEEDED_FACTS.md. */}
          </p>
          <p className="mt-5 max-w-[40rem] text-[15px] leading-[1.65] text-ink-soft">
            Cohort 1 is deliberately the first. There are no glossy alumni
            stats to show you yet, and we won&apos;t invent any. What we can
            promise: Rishabh and Taran runs every live session themselves, read every
            application, and answer every parent question personally within
            a couple of days. 
          </p>
          <div className="mt-6 flex flex-wrap items-center gap-x-6 gap-y-2">
            <a href={`mailto:${contactEmail}`} className="link-ink text-[15px] font-medium">
              {contactEmail}
            </a>
          </div>
        </div>
      </div>
    </section>
  );
}
