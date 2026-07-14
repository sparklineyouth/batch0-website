import { headers } from "next/headers";
import Navbar from "@/components/navbar";
import Footer from "@/components/footer";
import { Ledger } from "@/components/ledger";
import { ApplyCta } from "@/components/apply-cta";
import { WEEKS } from "@/components/curriculum";
import { getSiteConfig } from "@/lib/site-config";
import { getCountryFromHeaders } from "@/lib/pricing";
import { getProfile, roleHome } from "@/lib/auth";

export const metadata = {
  title: "Program: Four Sprints to Demo Day — batch0",
  description:
    "What actually happens inside batch0, week by week: four build sprints, live sessions on Zoom, one deliverable per week, and a live demo day at the end.",
  alternates: { canonical: "/program" },
};

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

export default async function ProgramPage() {
  const countryCode = getCountryFromHeaders(headers());
  const [config, profile] = await Promise.all([
    getSiteConfig({ countryCode }),
    getProfile(),
  ]);
  const authedHome = profile ? roleHome(profile.role) : null;
  const { derived } = config;
  const cohortLabel = derived.cohortLabel || "the next cohort";

  return (
    <main className="min-h-screen bg-paper">
      <Navbar
        authedHome={authedHome}
        cohortLabel={derived.cohortLabel || "the next cohort"}
      />

      <section className="px-5 pb-16 pt-14 sm:px-6 sm:pt-20 md:pb-20 md:pt-24">
        <div className="mx-auto grid max-w-[1100px] gap-12 md:grid-cols-12 md:gap-8">
          <div className="md:col-span-7">
            <h1 className="font-display text-[clamp(2.25rem,5.5vw,3.5rem)] font-bold leading-[1.03] tracking-[-0.025em] text-ink">
              Build sessions. One company. <span className="hl">Yours.</span>
            </h1>
            <p className="mt-6 max-w-[38rem] text-[1.0625rem] leading-[1.6] text-ink-soft">
              This page is the whole program, no mystery: exactly the steps we take to help you take your company from
              idea to demo day.
              {/* TODO(RISH): exact weekly live-session schedule + expected
                  hours/week — logged in NEEDED_FACTS.md. */}
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

      <Footer config={config} />
    </main>
  );
}
