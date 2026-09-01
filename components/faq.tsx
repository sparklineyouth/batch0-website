import React from "react";
import type { SiteConfig } from "@/lib/site-config";
import { Section, Eyebrow } from "@/components/section-kit";

/**
 * Questions parents ask. No anchor here on purpose — this is the one
 * section whose content IS a list of answers, and a drawn diagram beside
 * it would be decoration with nothing to illustrate. It earns its place
 * in the system through type and rhythm instead: the statement carries
 * the section, the answers sit in a single readable column.
 *
 * The FAQ JSON-LD rides along so the structured answers keep matching
 * the visible ones exactly.
 */
export default function Faq({ config }: { config: SiteConfig }) {
  const { derived, settings } = config;
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
      a: "U.S. high schoolers, ages 13–18. Bring a real idea, a half-formed hunch, or nothing at all. The first sessions exist to help you refine your idea — just come with a desire to learn and build. No startup experience required.",
    },
    {
      q: "how much time does it take?",
      a: "Each session helps students set individual and personalized deliverables. The amount of time a student spends per week varies for everyone, so plan for it the way you would a serious extracurricular." /* TODO(RISH): exact hours/week + live-session schedule — logged in NEEDED_FACTS.md */,
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
    <Section id="faq">
      <div className="max-w-[46rem]">
        <Eyebrow>questions parents ask</Eyebrow>
        <h2 className="sec-display mt-6 max-w-[13ch]">
          the <span className="text-phosphor">fine print,</span> up front.
        </h2>
      </div>

      <div className="mt-14 grid grid-cols-12 gap-x-6">
        <div className="col-span-12 md:col-span-9 lg:col-span-8">
          {faqs.map((f) => (
            <details key={f.q} className="group border-t border-line last:border-b">
              <summary className="flex cursor-pointer list-none items-baseline justify-between gap-6 py-5 text-[17px] font-medium leading-[1.4] text-ink [&::-webkit-details-marker]:hidden">
                {f.q}
                <span
                  aria-hidden
                  className="mt-1 flex-none text-[13px] text-ink-faint transition-transform group-open:rotate-45 motion-reduce:transition-none"
                >
                  +
                </span>
              </summary>
              <p className="sec-body max-w-[62ch] pb-6 pr-8">{f.a}</p>
            </details>
          ))}
        </div>
      </div>

      <script
        type="application/ld+json"
        // Fixed literal built from the FAQ copy above — no user input.
        dangerouslySetInnerHTML={{ __html: JSON.stringify(faqJsonLd) }}
      />
    </Section>
  );
}
