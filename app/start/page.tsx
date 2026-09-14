import type { Metadata } from "next";
import Link from "next/link";
import Navbar from "@/components/navbar";
import Footer from "@/components/footer";
import { ApplyCta } from "@/components/apply-cta";
import { StarterKitShare } from "@/components/starter-kit-share";
import { getPublicSiteConfig } from "@/lib/site-config";
import { JsonLd, SITE, ORG_ID, breadcrumbJsonLd } from "@/lib/schema";

export const revalidate = 3600;

export const metadata: Metadata = {
  title: "Free Founder Starter Kit for High Schoolers — batch0",
  description: "Turn a startup idea into a test: five practical exercises, customer interview questions, an MVP plan, and a free founder worksheet. No signup needed.",
  alternates: { canonical: "/start" },
  openGraph: {
    title: "An idea is a start. Here’s your next move.",
    description: "Five practical startup exercises and a free founder worksheet. No signup needed.",
    url: `${SITE}/start`,
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Free founder starter kit · batch0",
    description: "Five exercises to turn an idea into a test. No signup needed.",
  },
};

const steps = [
  {
    id: "problem",
    title: "Pick a problem you can actually reach.",
    time: "10 minutes",
    task: "Name one type of person, one recurring problem, and what they do about it today. Start with someone you can talk to this week.",
    prompt: "[Specific person] struggles to [job] when [situation]. Today they [workaround], which costs [time, money, or missed outcome].",
    example: "A school club treasurer chases five separate payment screenshots before every event and spends an hour matching them to a spreadsheet.",
    check: "Can you name three people who might have this problem? If you cannot, narrow the audience before designing a solution.",
    links: [
      { slug: "how-to-find-a-startup-problem-worth-solving", label: "Find a problem worth solving" },
      { slug: "write-a-startup-one-liner", label: "Write a clear one-liner" },
    ],
  },
  {
    id: "evidence",
    title: "Prepare a conversation, not a sales pitch.",
    time: "15 minutes to prepare; conversations happen next",
    task: "List five potential interviewees. Ask about a recent real incident, the current workaround, and its cost. A compliment is not evidence of demand.",
    prompt: "Tell me about the last time this happened. What did you do? What was hardest? What did that cost you? What have you already tried?",
    example: "Instead of ‘Would you use my app?’, ask ‘Walk me through how you collected payments for the last club event.’",
    check: "Save what happened and what the person did, separately from your interpretation. Get permission before recording. Do not publish their names or private details.",
    links: [
      { slug: "customer-interviews-beginners-guide", label: "Use the customer interview guide" },
      { slug: "where-to-find-people-to-interview", label: "Find people to interview" },
    ],
  },
  {
    id: "experiment",
    title: "Design the smallest honest test.",
    time: "15 minutes",
    task: "Choose the riskiest assumption. Test it with a manual service, a simple prototype, or a clearly labeled early-access page before building a full app.",
    prompt: "We believe [audience] will [observable action]. By [date], we will test this with [small experiment]. We will continue if [threshold]; otherwise we will [change].",
    example: "With permission, manually organize the next event’s payment records for three club treasurers. See whether they use the result and ask to use it again.",
    check: "Set your decision rule before collecting results. Three users is an example for a small experiment, not proof of a market. Report the sample size and limitations.",
    links: [
      { slug: "what-is-an-mvp", label: "Understand what an MVP is" },
      { slug: "concierge-mvp-do-it-manually", label: "Test the service manually" },
      { slug: "how-to-build-mvp-no-code-student", label: "Build a small no-code prototype" },
    ],
  },
  {
    id: "distribution",
    title: "Choose one path to your first users.",
    time: "10 minutes",
    task: "Pick one place where the exact audience already spends time. Write a useful, specific invitation. Ask permission in moderated communities and make your connection to the project clear.",
    prompt: "I’m testing [specific solution] for [audience]. It currently does [real capability]. Would you try [small next step] and tell me where it breaks?",
    example: "Ask your club advisor to share a pilot invitation with two treasurers who have the problem. Track invitations, replies, trials, and repeat use.",
    check: "Choose a time limit and a cash limit. Start at $0. Replies and repeat use matter more than impressions; do not count friends saying ‘cool’ as customers.",
    links: [
      { slug: "how-to-get-first-10-customers-student-founder", label: "Find your first customers" },
      { slug: "how-to-price-your-first-product", label: "Form a price hypothesis" },
      { slug: "one-channel-vs-many-early-growth", label: "Focus on one channel" },
    ],
  },
  {
    id: "pitch",
    title: "Explain what you know and what you need next.",
    time: "10 minutes",
    task: "Write a one-minute explanation: who has the problem, how you help, what you have actually observed, and your next test. Label assumptions and examples clearly.",
    prompt: "We help [audience] do [job]. Today they [workaround]. We tested [experiment] and observed [evidence]. Next we need [specific help or next action].",
    example: "‘We interviewed three treasurers; two described this problem last month’ is useful. ‘Everyone needs this’ is not. Never invent users, revenue, or partnerships.",
    check: "Finish with one concrete ask. If you have no traction yet, say what you plan to test and when. An honest open question beats a made-up metric.",
    links: [
      { slug: "one-minute-elevator-pitch-for-students", label: "Build a one-minute pitch" },
      { slug: "how-to-write-pitch-deck-high-school-competition", label: "Turn the story into a deck" },
      { slug: "traction-slide-with-no-revenue", label: "Show evidence before revenue" },
    ],
  },
];

export default async function FounderStarterKitPage() {
  const config = await getPublicSiteConfig();
  const cohortLabel = config.derived.cohortLabel || "the next cohort";

  return (
    <div className="min-h-screen bg-paper">
      <Navbar cohortLabel={cohortLabel} />
      <main id="main-content" tabIndex={-1}>
        <section className="border-b border-line px-5 pb-12 pt-14 sm:px-6 sm:pt-20">
          <div className="mx-auto max-w-[960px]">
            <p className="font-mono text-[13px] uppercase tracking-wider text-ink-faint">The free founder starter kit</p>
            <h1 className="mt-4 max-w-[18ch] font-display text-[clamp(2.5rem,6vw,4.5rem)] font-bold leading-[1.03] tracking-tight text-ink">
              An idea is a start. <span className="hl">Here’s your next move.</span>
            </h1>
            <p className="mt-6 max-w-[42rem] text-lg leading-relaxed text-ink-soft">
              Five exercises to turn a hunch into a testable plan. Written for high schoolers building their first project. Bring a notebook and about an hour; do the real-world tests afterward.
            </p>
            <p className="mt-4 font-mono text-sm text-ink-faint">Free to use · No signup · Works in any notes app</p>
            <div className="mt-7"><StarterKitShare /></div>
            <nav aria-label="Starter kit steps" className="mt-5 flex flex-wrap gap-x-5 gap-y-3 text-sm font-medium">
              {steps.map((step, i) => <a key={step.id} href={`#${step.id}`} className="link-ink">{i + 1}. {step.id === "experiment" ? "MVP test" : step.id.charAt(0).toUpperCase() + step.id.slice(1)}</a>)}
            </nav>
          </div>
        </section>

        <div className="mx-auto max-w-[1008px] px-5 sm:px-6">
          {steps.map((step, i) => (
            <section key={step.id} id={step.id} aria-labelledby={`${step.id}-title`} className="scroll-mt-24 border-b border-line py-12 sm:py-16">
              <div className="grid gap-5 sm:grid-cols-[64px_1fr]">
                <div aria-hidden="true" className="font-mono text-4xl text-phosphor-ink">0{i + 1}</div>
                <div>
                  <p className="font-mono text-xs uppercase tracking-wide text-ink-faint">{step.time}</p>
                  <h2 id={`${step.id}-title`} className="mt-2 font-display text-3xl font-bold leading-tight tracking-tight">{step.title}</h2>
                  <p className="mt-4 max-w-[44rem] text-base leading-relaxed text-ink-soft">{step.task}</p>
                  <div className="mt-6 rounded-xl border border-line bg-wash p-5 sm:p-6">
                    <p className="font-mono text-xs uppercase tracking-wide text-ink-faint">Put this in your worksheet</p>
                    <p className="mt-3 text-base font-medium leading-relaxed text-ink">{step.prompt}</p>
                  </div>
                  <p className="mt-5 text-sm leading-relaxed text-ink-soft"><strong className="text-ink">Example:</strong> {step.example}</p>
                  <p className="mt-3 text-sm leading-relaxed text-ink-soft"><strong className="text-ink">Reality check:</strong> {step.check}</p>
                  <ul className="mt-5 flex flex-col gap-3 text-sm">
                    {step.links.map((link) => <li key={link.slug}><Link href={`/blog/${link.slug}`} className="link-ink">{link.label} <span aria-hidden="true">↗</span></Link></li>)}
                  </ul>
                </div>
              </div>
            </section>
          ))}
        </div>

        <section className="bg-wash px-5 py-14 sm:px-6 sm:py-20">
          <div className="mx-auto max-w-[830px]">
            <p className="font-mono text-xs uppercase tracking-wide text-ink-faint">Turn the plan into a week of work</p>
            <h2 className="mt-3 font-display text-3xl font-bold tracking-tight">End with a date, a test, and one person to help.</h2>
            <p className="mt-4 max-w-[44rem] leading-relaxed text-ink-soft">Schedule your first conversation, choose a deadline for your smallest test, and ask a classmate or club advisor to review your reasoning. If the evidence disagrees with your idea, change the idea.</p>
            <div className="mt-7"><StarterKitShare /></div>
            <div className="mt-8 border-t border-line pt-8">
              <h3 className="text-xl font-semibold">Want a cohort to build alongside?</h3>
              <p className="mt-3 max-w-[44rem] text-sm leading-relaxed text-ink-soft">
                batch0 is a live, online accelerator for high schoolers, ages 13–18. Work through validation, building, marketing, and pitching with feedback. Applying is free; standard tuition is {config.derived.basePriceLabel}, charged only if accepted. Check the program page for current dates, regional pricing, and any active offer. No equity taken; funding is never guaranteed.
              </p>
              <div className="mt-6 flex flex-col items-start gap-4 sm:flex-row sm:flex-wrap sm:items-center">
                <ApplyCta label={`Apply for ${cohortLabel}`} location="starter-kit" />
                <Link href="/program" className="link-ink text-sm font-medium">See the program</Link>
                <Link href="/#faq" className="link-ink text-sm font-medium">Questions parents ask</Link>
              </div>
              <p className="mt-5 text-sm text-ink-soft">Already enrolled? <Link href="/dashboard/events" className="link-ink">Find your live sessions</Link> or <Link href="/dashboard/course" className="link-ink">open the course</Link>.</p>
            </div>
          </div>
        </section>
      </main>
      <Footer config={config} />
      <JsonLd data={{
        "@context": "https://schema.org",
        "@type": "LearningResource",
        name: "Free Founder Starter Kit for High Schoolers",
        description: "Five practical exercises, a downloadable founder worksheet, and curated guides for testing a startup idea.",
        url: `${SITE}/start`,
        isAccessibleForFree: true,
        learningResourceType: "Worksheet and guide",
        educationalLevel: "High school",
        inLanguage: "en",
        publisher: { "@id": ORG_ID },
      }} />
      <JsonLd data={breadcrumbJsonLd([{ name: "Founder starter kit", path: "/start" }])} />
    </div>
  );
}
