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
      a: `${price}, once, and only if you're accepted; applying is free. There are no hidden fees, no upsells, and no materials costs. Comparable accelerators list tuition in the thousands. Reduced regional pricing applies automatically in select countries, and refund terms are published on the refund policy page.`,
    },
    {
      q: "Who runs batch0?",
      a: `Rishabh Dagli and Taran Bethi — two 17-year-old founders who build and ship their own projects, including batch0 itself. They personally review every application, run every live session, and coordinate mentor and investor relationships for students. This is the founding cohort: no borrowed credentials, no invented track record.`,
    },
    {
      q: "Who is it for?",
      a: "High schoolers, ages 13–18. It's fully online, so you can join from anywhere you can make the live sessions (they're scheduled on U.S. Eastern time). Bring a real idea, a half-formed hunch, or nothing at all — the first sessions exist to help you find and refine your idea. No startup experience required.",
    },
    {
      q: "How much time does it take?",
      a: "Plan for 5–10 focused hours a week, the way you would a serious extracurricular. Each week has one live cohort session plus mentor office hours — scheduled on U.S. Eastern time and recorded if you have to miss one — and the rest is you building toward that week's deliverable. The exact weekly calendar is published before kickoff.",
    },
    {
      q: "Is it really fully online?",
      a: `Yes. Sessions, feedback, and demo day all happen live on Zoom${dates ? `. ${cohort} runs ${dates}` : ""}. You can join from anywhere; sessions are scheduled on U.S. Eastern time.`,
    },
    {
      q: "Who are the mentors?",
      a: `Cohort 1 is taught end-to-end by Rishabh and Taran — every person involved is named on this site before you pay, and we won't pad the roster. Guest mentors and investors join around demo day; admitted students get their names before the cohort starts, and nobody interacts with students outside moderated program spaces.`,
    },
    {
      q: "How is the community moderated?",
      a: `Every program space — community feed, Discord, session chat — is staff-moderated with published community guidelines. Students are 13–18, so there are no unmonitored private channels between students and adults, sessions may be recorded, and anything concerning goes straight to ${contactEmail}, where a human (a parent can be that human) gets a reply within a couple of days.`,
    },
    {
      q: "What is demo day?",
      a: "The last day of the cohort: you pitch the company you built, live. Cohort standouts may be offered batch0 sponsorship: a non-dilutive grant funded by our organization, decided on merit. Sponsorship and any introductions are never guaranteed, and tuition never buys them.",
    },
    {
      q: "Does batch0 take equity or own my idea?",
      a: "No. You own 100% of your idea, your work, and your company, before, during, and after the cohort. No equity, no IP claims, no royalties. Sponsorship, if offered, is a non-dilutive grant.",
    },
    {
      q: "How are applications judged?",
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
