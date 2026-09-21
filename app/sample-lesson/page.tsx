import type { Metadata } from "next";
import Link from "next/link";
import Navbar from "@/components/navbar";
import Footer from "@/components/footer";
import { getPublicSiteConfig } from "@/lib/site-config";

export const metadata: Metadata = {
  title: "Sample Lesson: Test a Problem Before You Build · batch0",
  description: "Try a free customer-interview exercise with a worked example and sample feedback. No signup required.",
  alternates: { canonical: "/sample-lesson" },
};
export const revalidate = 300;

export default async function SampleLesson() {
  const config = await getPublicSiteConfig();
  return <div className="min-h-screen bg-paper">
    <Navbar cohortLabel={config.derived.cohortLabel} applicationLabel={config.derived.applicationLabel} />
    <main id="main-content" tabIndex={-1} className="mx-auto max-w-3xl px-5 py-16 sm:px-6">
      <p className="text-xs uppercase tracking-wider text-ink-faint">A sample lesson · Validate</p>
      <h1 className="mt-4 font-display text-5xl leading-tight">Test the problem before you build the solution.</h1>
      <p className="mt-6 text-base leading-relaxed text-ink-soft">Spend 20 minutes preparing, then have three short conversations with people who experience the problem. You will leave with a clearer question to test, even if your original idea changes.</p>
      <p className="mt-4 text-xs leading-relaxed text-ink-faint">Free to try. No account needed. The example below is fictional teaching material, not a student result or testimonial.</p>
      <section className="mt-10 border-t border-line pt-8">
        <h2 className="font-display text-3xl">01 · Make the problem specific</h2>
        <p className="mt-4 text-sm leading-relaxed text-ink-soft">“Students need a productivity app” is too broad to test. Choose one person and one recurring situation.</p>
        <blockquote className="mt-5 border-l-2 border-phosphor bg-wash p-4 text-sm leading-relaxed">School club treasurers spend time matching event payments to signups because the records are scattered across messages.</blockquote>
        <p className="mt-4 text-sm leading-relaxed text-ink-soft">Write your own: <strong className="text-ink">[Specific person] struggles with [specific task] when [situation]. Today they use [workaround].</strong> If you cannot name three people to talk to, narrow the audience first.</p>
      </section>
      <section className="mt-10 border-t border-line pt-8">
        <h2 className="font-display text-3xl">02 · Ask about the last time</h2>
        <p className="mt-4 text-sm leading-relaxed text-ink-soft">Ask permission for a short conversation. Do not record or publish anyone’s information without permission. You are learning what happened, not trying to collect compliments.</p>
        <ol className="mt-5 list-decimal space-y-3 pl-6 text-sm leading-relaxed text-ink-soft">
          <li>Tell me about the last time you did this task.</li>
          <li>What steps did you take? Where did you get stuck?</li>
          <li>What did the workaround cost in time or money?</li>
          <li>What have you tried to change? What happened?</li>
        </ol>
        <p className="mt-5 text-sm leading-relaxed text-ink-soft">Keep an evidence log: what the person said or did, what you think it means, and what you still do not know. Separate those three columns.</p>
      </section>
      <section className="mt-10 border-t border-line pt-8">
        <h2 className="font-display text-3xl">03 · A worked feedback example</h2>
        <div className="mt-5 space-y-5 text-sm leading-relaxed text-ink-soft">
          <p><strong className="text-ink">First draft:</strong> “Three friends liked my payment app idea, so I will build it.”</p>
          <p><strong className="text-ink">Sample feedback:</strong> Liking an idea does not tell you whether the problem matters. Were those friends the people responsible for collecting payments? Ask for a recent example. Find out how often the problem happens, how they solve it today, and whether they will try one small improvement.</p>
          <p><strong className="text-ink">Stronger next step:</strong> “Talk to three club treasurers about their most recent event. If a recurring mismatch is costing them time, offer to test a simple tracking sheet with one treasurer’s permission. Use sample records first; do not collect anyone’s card details.”</p>
          <p><strong className="text-ink">What would change your mind?</strong> If their current process works well, investigate a different problem. Three interviews guide the next test; they do not prove market demand.</p>
        </div>
      </section>
      <section className="mt-10 border-t border-line pt-8">
        <h2 className="font-display text-3xl">Your submission</h2>
        <p className="mt-4 text-sm leading-relaxed text-ink-soft">One problem statement, three sets of interview notes, one assumption you revised, and the next test you will run. In the cohort, bring that work to check-ins and office hours for feedback.</p>
        <div className="mt-6 flex flex-wrap gap-5 text-sm"><Link className="link-ink" href="/start">Get the full starter worksheet →</Link><Link className="link-ink" href="/parents">See tuition and the live calendar →</Link></div>
      </section>
    </main><Footer config={config} />
  </div>;
}
