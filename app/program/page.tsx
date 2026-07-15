import { headers } from "next/headers";
import Navbar from "@/components/navbar";
import Footer from "@/components/footer";
import { StatusBar } from "@/components/status-bar";
import { PixelField } from "@/components/pixel-field";
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

/**
 * The program page — the broadsheet system's marketing grammar applied to
 * the syllabus. Standard section anatomy throughout (command head on the
 * rail, hairline separators, the shared 12-column grid), the curriculum as
 * the page's quiet/dense movement, and the one-ask rule: "apply" appears
 * only in the closing section and the nav chrome.
 */
export default async function ProgramPage() {
  const countryCode = getCountryFromHeaders(headers());
  const [config, profile] = await Promise.all([
    getSiteConfig({ countryCode }),
    getProfile(),
  ]);
  const authedHome = profile ? roleHome(profile.role) : null;
  const { derived } = config;
  const cohortLabel = derived.cohortLabel || "the next cohort";
  const cohortCode = String(config.cohort?.cohortNumber ?? 1).padStart(3, "0");

  return (
    <main className="min-h-screen bg-paper">
      <StatusBar config={config} />
      <Navbar
        authedHome={authedHome}
        cohortLabel={derived.cohortLabel || "the next cohort"}
      />

      {/* ONE OBJECT: the single shared container — every section starts on
          the same left margin and shares the 12-column grid. */}
      <div className="mx-auto max-w-[1100px] px-5 sm:px-6">
        {/* the page head — sentence left, cohort ledger right */}
        <section className="py-14 md:py-20">
          <p className="cmdline font-mono">
            <b>cat program.txt</b>{" "}
            <span className="mtime">· modified 2026-07-14</span>
          </p>
          <div className="mt-6 grid grid-cols-12 gap-x-6 gap-y-10">
            <div className="col-span-12 md:col-span-7">
              <h1 className="t-head max-w-[22ch] text-ink">
                build sessions. one company.{" "}
                <span className="text-phosphor">yours.</span>
              </h1>
              <p className="t-body mt-6 max-w-[58ch] text-ink-soft">
                This page is the whole program, no mystery: exactly the steps we take to help you take your company from
                idea to demo day.
                {/* TODO(RISH): exact weekly live-session schedule + expected
                    hours/week — logged in NEEDED_FACTS.md. */}
              </p>
            </div>
            <div className="col-span-12 md:col-span-5 md:pl-6 md:pt-2">
              <Ledger config={config} className="border-t border-line pt-6 md:border-t-0 md:pt-0" />
            </div>
          </div>
        </section>

        {/* the curriculum — the page's dense movement */}
        <section className="border-t border-phosphor/25 py-14 md:py-20">
          <p className="cmdline font-mono">
            <b>cat curriculum.txt</b>{" "}
            <span className="mtime">· modified 2026-07-14</span>
          </p>
          <h2 className="t-head mt-4 text-ink">step by step</h2>
          <ol className="mt-6">
            {WEEKS.map((w) => (
              <li
                key={w.week}
                className="grid grid-cols-12 gap-x-6 gap-y-4 border-t border-line py-6 last:border-b last:border-line"
              >
                <div className="col-span-12 md:col-span-4">
                  {/* step numbers are NOT deal-zeroes — they stay faint */}
                  <p className="t-small font-mono lowercase text-ink-faint">
                    {w.week}
                  </p>
                  <h3 className="t-body mt-1 font-semibold lowercase text-ink">
                    {w.title}
                  </h3>
                  <p className="t-small mt-2 font-mono lowercase text-ink">
                    <span className="text-phosphor/60">ships:</span>{" "}
                    {w.deliverable}
                  </p>
                </div>
                <div className="col-span-12 md:col-span-8">
                  <p className="t-body max-w-[64ch] text-ink-soft">{w.body}</p>
                  <ul className="mt-4 max-w-[64ch] space-y-2">
                    {(DETAIL[w.title] ?? []).map((d) => (
                      <li key={d} className="t-body flex gap-3 text-ink-soft">
                        <span
                          aria-hidden
                          className="mt-[0.72em] h-[3px] w-[14px] shrink-0 bg-phosphor"
                        />
                        {d}
                      </li>
                    ))}
                  </ul>
                </div>
              </li>
            ))}
          </ol>
        </section>

        {/* demo day */}
        <section className="border-t border-phosphor/25 py-14 md:py-20">
          <p className="cmdline font-mono">
            <b>cat demo-day.txt</b>{" "}
            <span className="mtime">· modified 2026-07-14</span>
          </p>
          <h2 className="t-head mt-4 text-ink">demo day</h2>
          <div className="mt-6 grid grid-cols-12 gap-x-6">
            <div className="col-span-12 md:col-span-8">
              <p className="t-body max-w-[64ch] text-ink-soft">
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

        {/* the closing ask — the page's one apply CTA (plus nav chrome) */}
        <section className="border-t border-phosphor/25 py-14 md:py-20">
          <p className="cmdline font-mono">
            <b>apply --cohort {cohortCode}</b>
          </p>
          <h2 className="t-head mt-4 max-w-[26ch] text-ink">
            if you read this far, you&apos;re the kind of person who
            finishes things.
          </h2>
          <div className="mt-7 flex flex-wrap items-center gap-4">
            <ApplyCta
              label={`apply for ${cohortLabel.toLowerCase()}`}
              location="program-page"
            />
            <span className="aside-note lowercase">
              free to apply · {derived.priceLabel} charged only if accepted
            </span>
          </div>
        </section>
      </div>

      <Footer config={config} />
      <PixelField />
    </main>
  );
}
