import type { Metadata } from "next";
import Link from "next/link";
import Navbar from "@/components/navbar";
import Footer from "@/components/footer";
import { Ledger } from "@/components/ledger";
import { ApplyCta } from "@/components/apply-cta";
import { EnrollmentNotice } from "@/components/enrollment-notice";
import { PublicTimetable } from "@/components/public-timetable";
import { getPublicCohortConfig } from "@/lib/site-config";
import { getPublicCohortSchedule } from "@/lib/public-program";

export const metadata: Metadata = {
  title: "For Parents — Schedule, Tuition & Teaching · batch0",
  description: "See the live calendar, tuition, facilitators, sample lesson and enrollment steps before your student joins batch0.",
  alternates: { canonical: "/parents" },
};

export default async function ParentsPage({ searchParams }: { searchParams: Promise<{ cohort?: string }> }) {
  const { cohort } = await searchParams;
  const config = await getPublicCohortConfig(cohort);
  const sessions = await getPublicCohortSchedule(config.cohort);
  const { derived, settings } = config;
  return (
    <div className="min-h-screen bg-paper">
      <Navbar cohortLabel={derived.cohortLabel} applicationLabel={derived.applicationLabel} />
      <main id="main-content" tabIndex={-1}>
        <section className="px-5 py-16 sm:px-6 md:py-24">
          <div className="mx-auto grid max-w-[1100px] gap-10 md:grid-cols-12">
            <div className="md:col-span-7">
              <p className="text-xs uppercase tracking-wider text-ink-faint">For parents & guardians</p>
              <h1 className="mt-4 font-display text-5xl leading-[1.03] sm:text-6xl">Know what your student is <span className="hl">joining.</span></h1>
              <p className="mt-6 max-w-xl text-base leading-relaxed text-ink-soft">A small, live online program where high schoolers turn an idea into customer research, a first version and a final demonstration. This page gives you the practical details before your family decides.</p>
              <EnrollmentNotice config={config} />
              <div className="mt-6 flex flex-wrap gap-x-6 gap-y-3 text-sm">
                <a className="link-ink" href="#schedule">Check the calendar</a>
                <Link className="link-ink" href="/sample-lesson">Try a sample lesson</Link>
                <a className="link-ink" href={`mailto:${settings.contactEmail}`}>Ask the founders</a>
              </div>
            </div>
            <div className="md:col-span-5"><Ledger config={config} /></div>
          </div>
        </section>
        <section className="border-t border-line bg-wash px-5 py-16 sm:px-6">
          <div className="mx-auto grid max-w-[1100px] gap-8 md:grid-cols-12">
            <h2 className="font-display text-4xl leading-tight md:col-span-4">The work your student will do</h2>
            <div className="space-y-5 text-sm leading-relaxed text-ink-soft md:col-span-8">
              <p><strong className="text-ink">Validate:</strong> choose a specific problem, prepare customer questions and record evidence. <strong className="text-ink">Build:</strong> scope and test a first version. <strong className="text-ink">Market:</strong> try one way to reach real users. <strong className="text-ink">Pitch:</strong> explain the work, results and next steps.</p>
              <p>Students work toward a project brief, interview notes, a prototype, a simple business model and a demo or pitch deck. Progress depends on the work they put in. Enrollment does not guarantee revenue, investment or a college admission outcome.</p>
              <p>Demo Day is a staff-hosted showcase of submitted demos or decks with moderated written questions. Students do not need to appear on camera. A deck with written narration is an alternative to a video. Guest investors, grants and prizes are not part of the purchase.</p>
              <Link className="link-ink inline-block" href="/program">Read the week-by-week program →</Link>
            </div>
          </div>
        </section>
        <PublicTimetable sessions={sessions} contactEmail={settings.contactEmail} />
        <section className="border-t border-line px-5 py-16 sm:px-6">
          <div className="mx-auto grid max-w-[1100px] gap-8 md:grid-cols-12">
            <h2 className="font-display text-4xl leading-tight md:col-span-4">Who teaches, and how to get help</h2>
            <div className="space-y-5 text-sm leading-relaxed text-ink-soft md:col-span-8">
              <p>Rishabh Dagli and Shresht Chopra run the program and the live sessions. They are student founders, and Fall 2026 is the founding cohort. We do not claim an alumni track record or university accreditation.</p>
              <p>Live sessions are staff-led, with moderated written Q&A. Students use the course materials, check-ins and office hours to get help with their work. Batch0 is operated by Sparkline Youth LLC.</p>
              <p>Students under 18 need a parent or guardian’s permission. Please review the <Link className="link-ink" href="/terms">terms</Link> and <Link className="link-ink" href="/privacy">privacy policy</Link> together. Questions about the experience or a concern about the community go to <a className="link-ink" href={`mailto:${settings.contactEmail}`}>{settings.contactEmail}</a>.</p>
              <p>You can inspect the teaching before applying: our <Link className="link-ink" href="/sample-lesson">sample customer-interview lesson</Link> includes an exercise and an illustrative feedback example. It is not a student testimonial.</p>
            </div>
          </div>
        </section>
        <section className="border-t border-line bg-wash px-5 py-16 sm:px-6">
          <div className="mx-auto grid max-w-[1100px] gap-8 md:grid-cols-12">
            <div className="md:col-span-4"><h2 className="font-display text-4xl leading-tight">A clear path to enrollment</h2><p className="mt-4 text-sm text-ink-soft">{derived.priceLabel} standard tuition, once, for {derived.cohortName}. Regional pricing, an awarded scholarship or a valid pass can change the final amount.</p></div>
            <div className="md:col-span-8">
              <ol className="space-y-5 text-sm leading-relaxed text-ink-soft">
                <li><strong className="text-ink">1. Your student applies free.</strong> They create their own account and complete the application. No payment is collected to apply.</li>
                <li><strong className="text-ink">2. Review the acceptance together.</strong> Check the cohort dates, live calendar, time commitment and any catch-up work.</li>
                <li><strong className="text-ink">3. Pay from your own device.</strong> An accepted student can create a secure parent payment link from their acceptance page. It shows the amount and cohort, without exposing their application answers or sharing their password. Payment confirms enrollment after verification.</li>
              </ol>
              <p className="mt-6 text-sm leading-relaxed text-ink-soft">Before paying, read the <Link className="link-ink" href="/refund-policy">refund policy</Link>. Your receipt and checkout show the final amount in USD. No equity or ownership of the student’s work is taken.</p>
              <div className="mt-8 flex flex-wrap items-center gap-5"><ApplyCta label={derived.applicationLabel} location="parents" /><Link className="link-ink text-sm" href="/dashboard/accepted">Already accepted? Open your acceptance →</Link></div>
            </div>
          </div>
        </section>
      </main>
      <Footer config={config} />
    </div>
  );
}
