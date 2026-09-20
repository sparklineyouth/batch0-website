import type { Metadata } from "next";
import Navbar from "@/components/navbar";
import Footer from "@/components/footer";
import { EnrollmentNotice } from "@/components/enrollment-notice";
import { PublicTimetable } from "@/components/public-timetable";
import { getPublicCohortSchedule } from "@/lib/public-program";
import { Ledger } from "@/components/ledger";
import { ApplyCta } from "@/components/apply-cta";
import { WEEKS } from "@/components/curriculum";
import { getPublicSiteConfig, FALLBACK_COHORT } from "@/lib/site-config";
import { RegionalPrice } from "@/components/regional-price";
import { listPriceCents } from "@/lib/promo";
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
  const description = `Inside batch0 week by week: kickoff, four build sprints, live online sessions, and a live demo day.${when}`;

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
    "Submit a demo or narrated deck for the staff-hosted showcase",
  ],
};

const WEEKLY_OUTCOMES = [
  ["Kickoff", "A project brief, a customer problem, and a realistic weekly work plan."],
  ["Validate · learn", "Customer interview questions, observation notes, and a clear problem hypothesis."],
  ["Validate · test", "A small demand experiment, an evidence log, and a revised Lean Canvas."],
  ["Build · scope", "One essential user journey, an MVP plan, and a testable prototype."],
  ["Build · ship", "A usable first version, user-test findings, and a pricing and cost model."],
  ["Market · position", "A specific audience, a competitive comparison, and a clear product message."],
  ["Market · distribute", "A small distribution experiment, a measured funnel, and a plan for the next users."],
  ["Pitch · prepare", "An evidence-based deck, a concise pitch, and a reliable demo."],
  ["Pitch · demonstrate", "A prepared demo or narrated deck, an honest retrospective, and a 30-day plan."],
];

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
  const sessions = await getPublicCohortSchedule(config.cohort);
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
    // Live sessions run online, so the instance is fully virtual and the
    // location is the platform itself.
    courseMode: "Online",
    location: {
      "@type": "VirtualLocation",
      name: "Batch0 live sessions",
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
      price: (listPriceCents(cohort.priceCents) / 100).toFixed(2),
      priceCurrency: "USD",
      category: "Tuition",
      url: `${SITE}/apply`,
      availability:
        derived.applicationsAvailable && derived.spotsLeft > 0
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
      "A live, online startup accelerator where high schoolers build a real company across four one-week build sprints — Validate, Build, Market, Pitch — each followed by a build week, and prepare a demo for a staff-hosted showcase.",
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
      <Navbar cohortLabel={derived.cohortLabel || "the next cohort"} applicationLabel={derived.applicationLabel} />
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
              Plan for 5–10 focused hours a week. Live sessions run inside
              Batch0 on U.S. Eastern time. Enrolled students find session
              links and calendar downloads in Events, and lessons and
              workbooks in Course.
            </p>
            <EnrollmentNotice config={config} />
            <p className="mt-5 text-sm"><a href="/sample-lesson" className="link-ink">Try a sample lesson before applying →</a></p>
          </div>
          <div className="md:col-span-5 md:pl-6 md:pt-2">
            <Ledger config={config} className="border-t border-line pt-6 md:border-t-0 md:pt-0" />
          </div>
        </div>
      </section>

      <PublicTimetable sessions={sessions} contactEmail={config.settings.contactEmail} />
      <section className="border-t border-line bg-wash px-5 py-16 sm:px-6" aria-labelledby="weekly-plan">
        <div className="mx-auto max-w-[1100px]">
          <h2 id="weekly-plan" className="font-display text-3xl font-bold">Your nine-week path</h2>
          <p className="mt-4 max-w-2xl text-[15px] leading-relaxed text-ink-soft">Each week includes readings, exercises, a workbook, and a concrete outcome. Work on one project throughout; the goal is useful evidence and progress, not finishing a pile of links.</p>
          <ol className="mt-8 grid gap-4 md:grid-cols-3">
            {WEEKLY_OUTCOMES.map(([title, outcome], index) => (
              <li key={title} className="rounded-xl border border-line bg-paper p-5">
                <p className="font-mono text-xs uppercase text-ink-faint">Week {index + 1}</p>
                <h3 className="mt-2 font-semibold">{title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-ink-soft">{outcome}</p>
              </li>
            ))}
          </ol>
          <a href="/start" className="link-ink mt-7 inline-block text-sm font-medium">Try the free founder starter kit →</a>
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
              The cohort closes with a staff-hosted showcase. Students submit
              a short demo recording or a pitch deck with written narration;
              staff presents the work and moderates written questions.
              Students do not use a live microphone or share their screens,
              and appearing on camera is optional. No outside guests, funding
              or prizes are promised. Every student keeps ownership of their work.
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
            <ApplyCta label={derived.applicationLabel} location="program-page" />
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
