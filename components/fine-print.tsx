import React from "react";
import type { SiteConfig } from "@/lib/site-config";
import { FoundersIcon, BubbleIcon } from "@/components/icons/pixel-icon";

/**
 * The fine print, up front — the page's second QUIET section and its trust
 * engine. One job: "who runs this, can I trust it". Two newspaper columns:
 * the founders (real names, real entity, the honest no-alumni-stats line)
 * and the parent FAQ. Its one action is hello@ — per the one-ask rule
 * there is no apply CTA here.
 *
 * Absorbs the old Founder and FAQ sections; the FAQ JSON-LD rides along so
 * the structured answers keep matching the visible ones.
 */
export default function FinePrint({ config }: { config: SiteConfig }) {
  const { derived, settings } = config;
  const contactEmail = settings.contactEmail;
  const price = derived.priceLabel;
  const cohort = derived.cohortLabel || "the cohort";
  const dates = derived.dateRangeLabel.replace("→", "–");

  const faqs: { q: string; a: string }[] = [
    {
      q: "how much does it cost?",
      a: `${price}, once, and only if you're accepted; applying is free. There are no hidden fees, no upsells, and no materials costs. Comparable summer accelerators list tuition in the thousands. Reduced regional pricing applies automatically in select countries, and refund terms are published on the refund policy page.`,
    },
    {
      q: "who runs batch0?",
      a: `Rishabh Dagli and Taran Bethi, two serial founders building real companies that have changed the world. Rishabh and Taran personally review applications, run live sessions, and coordinate mentor and investor relationships for students.`,
    },
    {
      q: "who is it for?",
      a: "U.S. high schoolers, ages 13–18. Bring a real idea, a half-formed hunch, or nothing at all. The first sessions EXIST to help you refine your idea, just come with a desire to learn and build. No startup experience required.",
    },
    {
      q: "how much time does it take?",
      a: "Each sessions helps students set individual and personalized deliverables. The amount of time a student spends per week varies for everyone, so plan for it the way you would a serious extracurricular." /* TODO(RISH): exact hours/week + live-session schedule — logged in NEEDED_FACTS.md */,
    },
    {
      q: "is it really fully online?",
      a: `Yes. Sessions, feedback, and demo day all happen live on Zoom${dates ? `. ${cohort} runs ${dates}` : ""}. You can join from anywhere in the U.S.`,
    },
    {
      q: "what is demo day?",
      a: "The last day of the cohort: you pitch the company you built, live. Cohort standouts may be offered batch0 sponsorship: a non-dilutive grant funded by our organization, decided on merit. Sponsorship and any introductions are never guaranteed, and tuition never buys them.",
    },
    {
      q: "does batch0 take equity or own my idea?",
      a: "No. You own 100% of your idea, your work, and your company, before, during, and after the cohort. No equity, no IP claims, no royalties. Sponsorship, if offered, is a non-dilutive grant.",
    },
    {
      q: "how are applications judged?",
      a: `Our team reads every application. We admit students who show they'll actually do the work; clear thinking about a problem beats a long résumé. ${cohort} is capped at ${derived.capacityLabel} students, reviewed on a rolling basis${settings.applicationsOpen ? "" : " (applications are currently closed)"}.`,
    },
  ];

  const faqJsonLd = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: faqs.map((f) => ({
      "@type": "Question",
      name: f.q,
      acceptedAnswer: { "@type": "Answer", text: f.a },
    })),
  };

  return (
    <section
      id="faq"
      className="border-t border-phosphor/25 px-5 py-14 sm:px-6 md:py-20"
    >
      <div className="mx-auto max-w-[1100px]">
        <p className="cmdline font-mono">
          <b>cat fine-print.txt</b>{" "}
          <span className="mtime">· modified 2026-07-14</span>
        </p>
        <div className="mt-4 flex flex-wrap items-baseline justify-between gap-3 border-b border-phosphor/25 pb-2.5">
          <h2 className="font-display text-[clamp(1.375rem,2.6vw,1.875rem)] leading-[1.05] text-ink">
            the fine print, up front
          </h2>
          <span className="font-mono text-xs tracking-[0.05em] text-phosphor/60">
            no hype · read before applying
          </span>
        </div>

        <div className="mt-6 grid gap-11 md:grid-cols-2">
          {/* who runs this */}
          <div id="who-runs-this">
            <div className="flex items-center gap-3.5">
              <FoundersIcon size={5} />
              <h3 className="text-[14px] font-semibold text-ink">
                who runs this
              </h3>
            </div>
            <div className="mt-4 max-w-[58ch] text-[14px] leading-[1.65] text-ink-soft">
              <p>
                batch0 is built and run by{" "}
                <strong className="font-semibold text-ink">
                  Rishabh Dagli and Taran Bethi
                </strong>
                , two 17-year-old serial founders. We built batch0 to give high
                schoolers the same chance that we wish we had: to build a REAL
                company with mentorship and support, and even the chance of
                funding!
                {/* TODO(RISH): 2–3 public receipts (links) — shipped products,
                    hardware, repos, press. Logged in NEEDED_FACTS.md. */}
              </p>
              <p className="mt-3">
                Cohort 1 is deliberately the first. There are no glossy alumni
                stats to show you yet, and we won&apos;t invent any. What we
                can promise: Rishabh and Taran runs every live session
                themselves, read every application, and answer every parent
                question personally within a couple of days.
              </p>
              <p className="mt-3 text-[13px] text-ink-faint">
                the legal entity is Sparkline Youth LLC.
              </p>
              {/* this section's one action */}
              <p className="mt-4">
                <a
                  href={`mailto:${contactEmail}`}
                  className="link-ink text-[14px] font-medium"
                >
                  {contactEmail}
                </a>
              </p>
            </div>
          </div>

          {/* questions parents ask */}
          <div>
            <div className="flex items-center gap-3.5">
              <BubbleIcon size={5} />
              <h3 className="text-[14px] font-semibold text-ink">
                questions parents ask{" "}
                <span className="font-mono font-normal text-ink-faint">
                  · {faqs.length}
                </span>
              </h3>
            </div>
            <div className="mt-4">
              {faqs.map((f, i) => (
                <details key={f.q} className="group">
                  <summary className="flex cursor-pointer list-none items-baseline gap-3 py-2.5 text-[14px] font-medium text-ink hover:bg-phosphor/[0.07] [&::-webkit-details-marker]:hidden">
                    <span aria-hidden className="font-mono text-phosphor/40 group-open:text-phosphor">
                      {i === faqs.length - 1 ? "└─" : "├─"}
                    </span>
                    {f.q}
                  </summary>
                  <p className="ml-[0.5ch] max-w-[58ch] border-l border-phosphor/25 pb-3.5 pl-[3ch] pt-0.5 text-[13.5px] leading-[1.6] text-ink-soft">
                    {f.a}
                  </p>
                </details>
              ))}
            </div>
          </div>
        </div>
      </div>
      <script
        type="application/ld+json"
        // Fixed literal built from the FAQ copy above — no user input.
        dangerouslySetInnerHTML={{ __html: JSON.stringify(faqJsonLd) }}
      />
    </section>
  );
}
