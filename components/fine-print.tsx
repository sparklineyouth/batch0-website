import React from "react";
import type { SiteConfig } from "@/lib/site-config";
import { FoundersIcon, BubbleIcon } from "@/components/icons/pixel-icon";

/**
 * The fine print, up front — the page's second QUIET movement and its
 * trust engine. One job: "who runs this, can I trust it". Two columns of
 * the shared grid: the founders and the parent FAQ, each led by its glyph
 * (data-adjacent, one size). One action: hello@. FAQ JSON-LD rides along
 * so structured answers keep matching visible ones.
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
    <section id="faq" className="border-t border-phosphor/25 py-14 md:py-20">
      <p className="cmdline font-mono">
        <b>cat fine-print.txt</b>{" "}
        <span className="mtime">· modified 2026-07-14</span>
      </p>
      <h2 className="t-head mt-4 text-ink">the fine print, up front</h2>

      <div className="mt-6 grid grid-cols-12 gap-x-6 gap-y-10">
        {/* who runs this */}
        <div id="who-runs-this" className="col-span-12 md:col-span-6">
          <div className="flex items-center gap-3.5">
            <FoundersIcon size={5} />
            <h3 className="t-body font-semibold text-ink">who runs this</h3>
          </div>
          <div className="t-body mt-4 max-w-[58ch] text-ink-soft">
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
              stats to show you yet, and we won&apos;t invent any. What we can
              promise: Rishabh and Taran runs every live session themselves,
              read every application, and answer every parent question
              personally within a couple of days.
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
        </div>

        {/* questions parents ask */}
        <div className="col-span-12 md:col-span-6">
          <div className="flex items-center gap-3.5">
            <BubbleIcon size={5} />
            <h3 className="t-body font-semibold text-ink">
              questions parents ask{" "}
              <span className="font-mono font-normal text-ink-faint">
                · {faqs.length}
              </span>
            </h3>
          </div>
          <div className="mt-4">
            {faqs.map((f, i) => (
              <details key={f.q} className="group">
                <summary className="t-body flex cursor-pointer list-none items-baseline gap-3 py-2.5 font-medium text-ink hover:bg-phosphor/[0.07] [&::-webkit-details-marker]:hidden">
                  <span
                    aria-hidden
                    className="font-mono text-phosphor/40 group-open:text-phosphor"
                  >
                    {i === faqs.length - 1 ? "└─" : "├─"}
                  </span>
                  {f.q}
                </summary>
                <p className="t-small ml-[0.5ch] max-w-[58ch] border-l border-phosphor/25 pb-3.5 pl-[3ch] pt-0.5 text-ink-soft">
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
