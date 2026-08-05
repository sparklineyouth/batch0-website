import React from "react";
import type { SiteConfig } from "@/lib/site-config";
import { BubbleIcon } from "@/components/icons/pixel-icon";

/**
 * Questions parents ask — what remains of the old fine-print once "who
 * runs this" moved up to its own section and the founding-cohort argument
 * moved into <FoundingCohort/>. FAQ JSON-LD rides along so the structured
 * answers keep matching the visible ones exactly.
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
    <section id="faq" className="border-t border-line py-14 md:py-20">
      <p className="section-intro">the questions parents ask first.</p>

      <div className="mt-6 flex items-center gap-3.5">
        <BubbleIcon size={5} />
        <h2 className="t-body font-semibold text-ink">questions parents ask</h2>
      </div>

      <div className="mt-4 grid grid-cols-12 gap-x-6">
        <div className="col-span-12 md:col-span-8">
          {faqs.map((f) => (
            <details key={f.q} className="group">
              <summary className="t-body flex cursor-pointer list-none items-baseline gap-3 py-2.5 font-medium text-ink hover:bg-ink/[0.05] [&::-webkit-details-marker]:hidden">
                {f.q}
              </summary>
              <p className="t-small ml-[0.5ch] max-w-[58ch] border-l border-line pb-3.5 pl-[3ch] pt-0.5 text-ink-soft">
                {f.a}
              </p>
            </details>
          ))}
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
