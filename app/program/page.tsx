import type { Metadata } from "next";
import Navbar from "@/components/navbar";
import Footer from "@/components/footer";
import { Ledger } from "@/components/ledger";
import { ApplyCta } from "@/components/apply-cta";
import { WEEKS } from "@/components/curriculum";
import { getPublicSiteConfig, FALLBACK_COHORT } from "@/lib/site-config";
import { RegionalPrice } from "@/components/regional-price";
import {
  SITE,
  ORG_ID,
  FOUNDERS,
  STUDENT_AUDIENCE,
  JsonLd,
  breadcrumbJsonLd,
} from "@/lib/schema";

const PROGRAM_TITLE = "Program: Four Sprints to Demo Day — batch0";

// Generated per request for the same reason as the homepage: this page's whole
// job is answering "when does it run and what happens", and the answer lives
// in a database row that moves without a deploy.
//
// The old static string was also 163 characters, so Google was truncating it
// mid-clause before it ever reached "demo day". Leading with the dates keeps
// the useful half inside the ~155-character budget.
export async function generateMetadata(): Promise<Metadata> {
  const { derived } = await getPublicSiteConfig({ countryCode: null });
  const when = derived.dateRangeSentence
    ? ` ${derived.cohortLabel || "Next cohort"}: ${derived.dateRangeSentence}.`
    : "";
  const description = `Inside batch0 week by week: kickoff, four build sprints, live sessions on Zoom, and a live demo day.${when}`;

  return {
    title: PROGRAM_TITLE,
    description,
    alternates: { canonical: "/program" },
    openGraph: {
      title: PROGRAM_TITLE,
      description,
      url: `${SITE}/program`,
      siteName: "batch0",
      type: "website",
    },
    twitter: {
      card: "summary_large_image" as const,
      title: PROGRAM_TITLE,
      description,
    },
  };
}

// Sprint-by-sprint detail — the founder-authored syllabus expanded with
// the session mechanics each week actually involves.
const DETAIL: Record<string, string[]> = {
  Validate: [
    "Write a Lean Canvas for your idea (or use the discovery exercises to find one)",
    "Run structured customer interviews with strangers",
    "Kill or confirm your riskiest assumption before you build anything",
  ],
  Build: [
    "Ship a v1: landing page, no-code MVP, or working prototype",
    "Set pricing and draft unit economics that survive a sharp question",
    "Get live feedback on what you shipped, then fix the top issue",
  ],
  Market: [
    "Map the competitive landscape and pick your positioning",
    "Design one distribution wedge you can actually execute this month",
    "Plan the concrete path to your first hundred users",
  ],
  Pitch: [
    "Write the deck: problem, product, traction, model, ask",
    "Rehearse with the batch0 team until the delivery holds",
    "Pitch live at demo day",
  ],
};

// Prerendered with ISR, same shape as the homepage: the server renders the
// base price and <RegionalPrice> swaps the label client-side for visitors
// whose clock says India — the geo header this page used to read served
// exactly that one override. Admin edits revalidate SITE_CONFIG_TAG and
// this path directly; 300s is only the fallback horizon.
export const revalidate = 300;

export default async function ProgramPage() {
  const [config, regionalConfig] = await Promise.all([
    getPublicSiteConfig({ countryCode: null }),
    getPublicSiteConfig({ countryCode: "IN" }),
  ]);
  const { derived } = config;
  const cohortLabel = derived.cohortLabel || "the next cohort";

  // ---------- Course structured data ----------
  // The richest entity on the site, and the one Google can render as a
  // course result. Everything dynamic reads from the same cohort record the
  // Ledger above renders, so the markup can't disagree with the visible
  // page; the syllabus is built from the same WEEKS array as "Step by Step".
  // Same fallback `derived` uses: on a Supabase outage `config.cohort` is
  // null while the Ledger and FAQ still render FALLBACK_COHORT's dates, so
  // reading the raw field here would quietly strip dates and price out of
  // the markup on exactly the pages still showing them.
  const cohort = config.cohort ?? FALLBACK_COHORT;

  // Cohort length in whole weeks, derived rather than stated: the copy says
  // "nine weeks" today, but the cohort row has moved before (see
  // FALLBACK_COHORT) and hardcoding it here is how markup goes stale.
  const cohortWeeks =
    cohort.startsOn && cohort.endsOn
      ? Math.round(
          (Date.parse(`${cohort.endsOn}T00:00:00Z`) -
            Date.parse(`${cohort.startsOn}T00:00:00Z`)) /
            (7 * 24 * 60 * 60 * 1000),
        )
      : null;

  const courseInstance = {
    "@type": "CourseInstance",
    "@id": `${SITE}/program#cohort-${cohort.cohortNumber ?? 1}`,
    name: derived.cohortHeadline || cohortLabel,
    // Live sessions run on Zoom, so the instance is fully virtual and the
    // location is the platform itself.
    courseMode: "Online",
    location: {
      "@type": "VirtualLocation",
      name: "Zoom",
    },
    instructor: FOUNDERS,
    inLanguage: "en-US",
    ...(cohort.startsOn ? { startDate: cohort.startsOn } : {}),
    ...(cohort.endsOn ? { endDate: cohort.endsOn } : {}),
    // One live cohort session per week plus office hours. Google needs
    // either a schedule or a workload; the schedule is the one we can state
    // exactly, since the published commitment is a 5–10 hour range and no
    // single ISO duration says that honestly.
    ...(cohort.startsOn && cohort.endsOn && cohortWeeks
      ? {
          courseSchedule: {
            "@type": "Schedule",
            repeatFrequency: "Weekly",
            repeatCount: cohortWeeks,
            startDate: cohort.startsOn,
            endDate: cohort.endsOn,
            scheduleTimezone: "America/New_York",
          },
        }
      : {}),
    offers: {
      "@type": "Offer",
      // Base tuition, not the visitor's regional price: the markup is
      // cached and shared across regions, so it has to state the canonical
      // number. `derived.priceLabel` still drives what the page shows.
      price: (cohort.priceCents / 100).toFixed(2),
      priceCurrency: "USD",
      category: "Tuition",
      url: `${SITE}/apply`,
      availability:
        derived.spotsLeft > 0
          ? "https://schema.org/LimitedAvailability"
          : "https://schema.org/SoldOut",
      ...(cohort.applicationsCloseAt
        ? { validThrough: cohort.applicationsCloseAt }
        : {}),
      description:
        "Charged only if accepted; applying is free. Reduced regional pricing applies automatically in select countries.",
    },
  };

  const courseJsonLd = {
    "@context": "https://schema.org",
    "@type": "Course",
    "@id": `${SITE}/program#course`,
    name: "batch0 — Startup Accelerator for High Schoolers",
    description:
      "A live, online startup accelerator where high schoolers build a real company across four one-week build sprints — Validate, Build, Market, Pitch — each followed by a build week, and pitch it at a live demo day.",
    url: `${SITE}/program`,
    provider: { "@id": ORG_ID },
    audience: STUDENT_AUDIENCE,
    educationalLevel: "High School",
    inLanguage: "en-US",
    isAccessibleForFree: false,
    teaches: WEEKS.map((w) => w.deliverable),
    about: [
      "Startup idea validation",
      "Customer interviews",
      "MVP development",
      "Business model design",
      "Go-to-market strategy",
      "Pitch decks",
    ],
    syllabusSections: WEEKS.map((w, i) => ({
      "@type": "Syllabus",
      position: i + 1,
      name: w.title,
      description: w.body,
      // Each sprint is one taught week plus one build week.
      timeRequired: "P2W",
    })),
    hasCourseInstance: courseInstance,
  };

  return (
    // <div> outside, <main> around the content only — a <main> containing the
    // navbar and footer suppresses their banner/contentinfo landmarks and
    // makes "Skip to content" land above the nav. No layout classes on the
    // inner <main>, so nothing shifts.
    <div className="min-h-screen bg-paper">
      <Navbar cohortLabel={derived.cohortLabel || "the next cohort"} />
      <main id="main-content" tabIndex={-1}>

      <section className="px-5 pb-16 pt-14 sm:px-6 sm:pt-20 md:pb-20 md:pt-24">
        <div className="mx-auto grid max-w-[1100px] gap-12 md:grid-cols-12 md:gap-8">
          <div className="md:col-span-7">
            <h1 className="font-display text-[clamp(2.25rem,5.5vw,3.5rem)] font-bold leading-[1.03] tracking-[-0.025em] text-ink">
              Build sessions. One company. <span className="hl">Yours.</span>
            </h1>
            <p className="mt-6 max-w-[38rem] text-[1.0625rem] leading-[1.6] text-ink-soft">
              This page is the whole program, no mystery: exactly the steps we take to help you take your company from
              idea to demo day.
            </p>
            <p className="mt-4 max-w-[38rem] text-[15px] leading-[1.65] text-ink-soft">
              How the nine weeks map out: kickoff opens the cohort, then four
              sprints — Validate, Build, Market, Pitch. Each sprint is one
              taught week followed by a build week where you apply it to your
              own company with feedback, and the cohort closes with demo day.
              Plan for 5–10 focused hours a week; live sessions run on Zoom
              (U.S. Eastern time, recorded if you miss one), and the exact
              weekly calendar is published before kickoff.
            </p>
          </div>
          <div className="md:col-span-5 md:pl-6 md:pt-2">
            <Ledger config={config} className="border-t border-line pt-6 md:border-t-0 md:pt-0" />
          </div>
        </div>
      </section>

      <section className="border-t border-line px-5 py-16 sm:px-6 md:py-24">
        <div className="mx-auto max-w-[1100px]">
          <h2 className="font-display text-[clamp(1.75rem,3.5vw,2.5rem)] font-bold leading-[1.08] tracking-[-0.02em] text-ink">
            Step by Step
          </h2>
          <ol className="mt-10">
            {WEEKS.map((w) => (
              <li
                key={w.week}
                className="grid gap-4 border-b border-line py-8 first:pt-0 last:border-b-0 md:grid-cols-12 md:gap-8"
              >
                <div className="md:col-span-4">
                  <p className="font-mono text-[13px] text-ink-faint">{w.week}</p>
                  <h3 className="mt-1 font-display text-2xl font-bold tracking-tight text-ink">
                    {w.title}
                  </h3>
                  <p className="mt-2 font-mono text-[13px] font-medium text-ink">
                    ships: {w.deliverable}
                  </p>
                </div>
                <div className="md:col-span-8">
                  <p className="max-w-[40rem] text-[15px] leading-[1.65] text-ink-soft">
                    {w.body}
                  </p>
                  <ul className="mt-4 max-w-[40rem] space-y-2">
                    {(DETAIL[w.title] ?? []).map((d) => (
                      <li key={d} className="flex gap-3 text-[15px] leading-[1.6] text-ink-soft">
                        <span aria-hidden className="mt-[0.72em] h-[3px] w-[14px] shrink-0 bg-phosphor" />
                        {d}
                      </li>
                    ))}
                  </ul>
                </div>
              </li>
            ))}
          </ol>
        </div>
      </section>

      <section className="border-t border-line bg-wash px-5 py-16 sm:px-6 md:py-24">
        <div className="mx-auto grid max-w-[1100px] gap-10 md:grid-cols-12 md:gap-8">
          <div className="md:col-span-4">
            <h2 className="font-display text-[clamp(1.75rem,3.5vw,2.5rem)] font-bold leading-[1.08] tracking-[-0.02em] text-ink">
              Demo day
            </h2>
          </div>
          <div className="md:col-span-8">
            <p className="max-w-[40rem] text-[1.0625rem] leading-[1.65] text-ink-soft">
              The cohort ends with a live demo day: you pitch the
              company you built to the batch0 team and invited guests.
              Cohort standouts may be offered batch0 sponsorship: a
              non-dilutive grant funded by our organization, decided purely on
              merit. Funding is never guaranteed, tuition never buys a
              sponsorship, and every student keeps 100% of their company
              either way.
              {/* TODO(RISH): demo-day date (settings.demo_day_date is unset)
                  and the confirmed guest list once it exists — see
                  NEEDED_FACTS.md. */}
            </p>
            
          </div>
        </div>
      </section>

      <section className="border-t border-line px-5 py-16 sm:px-6 md:py-24">
        <div className="mx-auto max-w-[1100px]">
          <h2 className="max-w-[26ch] font-display text-[clamp(1.75rem,4vw,2.75rem)] font-bold leading-[1.06] tracking-[-0.02em] text-ink">
            If you read this far, you&apos;re the kind of person who
            finishes things.
          </h2>
          <div className="mt-8 flex flex-col items-stretch gap-3 sm:flex-row sm:items-center">
            <ApplyCta label={`Apply for ${cohortLabel}`} location="program-page" />
            <p className="text-[13px] text-ink-faint">
              Free to apply · {derived.priceLabel} charged only if accepted
            </p>
          </div>
        </div>
      </section>

      </main>
      <Footer config={config} />
      <RegionalPrice
        base={config.derived.priceLabel}
        regional={regionalConfig.derived.priceLabel}
      />
      <JsonLd data={courseJsonLd} />
      <JsonLd data={breadcrumbJsonLd([{ name: "Program", path: "/program" }])} />
    </div>
  );
}
