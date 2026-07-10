import React from "react";
import type { SiteConfig } from "@/lib/site-config";

/**
 * Parent-facing FAQ. Direct answers: cost in the first sentence, real
 * names, a human contact. Server-rendered with native <details> — no JS,
 * keyboard-accessible by default. Emits FAQPage JSON-LD from the same
 * data so the structured answers can never drift from the visible ones.
 */
export default function FAQ({ config }: { config: SiteConfig }) {
  const { derived, settings } = config;
  const contactEmail = settings.contactEmail;
  const price = derived.priceLabel;
  const cohort = derived.cohortLabel || "the cohort";
  const dates = derived.dateRangeLabel.replace("→", "–");

  const faqs: { q: string; a: string }[] = [
    {
      q: "How much does it cost?",
      a: `${price}, once, and only if you're accepted; applying is free. There are no hidden fees, no upsells, and no materials costs. Comparable summer accelerators list tuition in the thousands. Reduced regional pricing applies automatically in select countries, and refund terms are published on the refund policy page.`,
    },
    {
      q: "Who runs SparkLine Youth?",
      a: `Rish Dagli, an 18-year-old founder, runs the program day to day. The legal entity behind it is Impetus AI LLC, registered in New Jersey. Parents: you can reach a human at ${contactEmail}. Questions get answers, not autoresponders.`,
    },
    {
      q: "Who is it for?",
      a: "U.S. high schoolers, ages 13–18. Bring a real idea, a half-formed hunch, or nothing at all. The first sprint week exists to find and validate an idea. No prior startup experience required.",
    },
    {
      q: "How much time does it take?",
      a: "Each of the four sprint weeks ends in a deliverable you build on your own schedule, plus live sessions on Zoom. Plan for it the way you would a serious extracurricular." /* TODO(RISH): exact hours/week + live-session schedule — logged in NEEDED_FACTS.md */,
    },
    {
      q: "Is it really fully online?",
      a: `Yes. Sessions, feedback, and demo day all happen live on Zoom${dates ? `. ${cohort} runs ${dates}` : ""}. You can join from anywhere in the U.S.`,
    },
    {
      q: "What is demo day?",
      a: "The last day of the cohort: you pitch the company you built, live. Cohort standouts may be offered SparkLine sponsorship: a non-dilutive grant funded by Impetus AI, decided on merit. Sponsorship and any introductions are never guaranteed, and tuition never buys them.",
    },
    {
      q: "Does SparkLine take equity or own my idea?",
      a: "No. You own 100% of your idea, your work, and your company — before, during, and after the cohort. No equity, no IP claims, no royalties. Sponsorship, if offered, is a non-dilutive grant.",
    },
    {
      q: "How are applications judged?",
      a: `Rish reads every application. We admit students who show they'll actually do the work; clear thinking about a problem beats a long résumé. ${cohort} is capped at ${derived.capacityLabel} students, reviewed on a rolling basis${settings.applicationsOpen ? "" : " (applications are currently closed)"}.`,
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
    <section id="faq" className="border-t border-line px-5 py-20 sm:px-6 md:py-28">
      <div className="mx-auto grid max-w-[1100px] gap-10 md:grid-cols-12 md:gap-8">
        <div className="md:col-span-4">
          <h2 className="font-display text-[clamp(1.75rem,3.5vw,2.5rem)] font-bold leading-[1.08] tracking-[-0.02em] text-ink">
            Questions parents ask
          </h2>
          <p className="mt-4 text-[15px] leading-[1.65] text-ink-soft">
            The short versions. Anything else:{" "}
            <a href={`mailto:${contactEmail}`} className="link-ink">
              email a human
            </a>
            .
          </p>
        </div>
        <div className="md:col-span-8">
          <div className="border-t border-line">
            {faqs.map((f) => (
              <details key={f.q} className="group border-b border-line">
                <summary className="flex cursor-pointer list-none items-baseline justify-between gap-6 py-5 text-[1.0625rem] font-medium text-ink [&::-webkit-details-marker]:hidden">
                  {f.q}
                  <span
                    aria-hidden
                    className="font-mono text-ink-faint group-open:hidden"
                  >
                    +
                  </span>
                  <span
                    aria-hidden
                    className="hidden font-mono text-ink-faint group-open:inline"
                  >
                    −
                  </span>
                </summary>
                <p className="max-w-[38rem] pb-6 text-[15px] leading-[1.65] text-ink-soft">
                  {f.a}
                </p>
              </details>
            ))}
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
