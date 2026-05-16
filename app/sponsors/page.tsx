import Navbar from "@/components/navbar";
import Footer from "@/components/footer";
import { Users, Megaphone, HeartHandshake, Check } from "lucide-react";
import { TIERS } from "./tiers";
import { SponsorContactForm } from "./sponsor-contact-form";

export const metadata = {
  title: "Sponsor SparkLine Youth — Fund the next generation of founders",
  description:
    "Get your brand in front of 100 vetted teen builders per cohort. Fund the grant pool. Build pipeline.",
};

const WHY = [
  {
    icon: Users,
    title: "Pipeline",
    body:
      "100 vetted teen builders per cohort, many headed to top engineering programs in 12–24 months. Get early reads on talent before recruiters do.",
  },
  {
    icon: Megaphone,
    title: "Brand",
    body:
      "Logo on the cohort dashboard, workshop slot, presence at Demo Day. Be visible where teen builders actually spend their time.",
  },
  {
    icon: HeartHandshake,
    title: "Impact",
    body:
      "Direct cash grants to teen founders. Real outcomes, real reportable impact for ESG and community programs.",
  },
];

export default function SponsorsPage() {
  return (
    <main className="relative min-h-screen overflow-hidden bg-black text-white">
      <Navbar />

      {/* Hero */}
      <section className="relative overflow-hidden pt-28 pb-14 sm:pt-36 sm:pb-20 md:pt-44 md:pb-24">
        <div
          aria-hidden
          className="absolute inset-x-0 -top-16 h-64 bg-gradient-to-b from-spark/[0.08] to-transparent pointer-events-none"
        />
        <div className="relative mx-auto max-w-5xl px-5 sm:px-6">
          <div className="inline-flex items-center gap-2 rounded-full border border-spark/30 bg-spark/[0.06] px-3 py-1.5 text-[11px] font-medium uppercase tracking-[0.2em] text-spark">
            <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-spark" />
            Sponsorship
          </div>
          <h1 className="mt-5 sm:mt-6 text-[40px] sm:text-6xl md:text-[72px] font-bold tracking-[-0.04em] leading-[1] text-white">
            Sponsor the next generation
            <br />
            of <span className="shine">founders</span>.
          </h1>
          <p className="mt-5 sm:mt-7 max-w-2xl text-[15px] sm:text-lg md:text-xl text-white/80 leading-[1.55]">
            Get your brand in front of 100 vetted teen builders per cohort.
            Fund the grant pool. Build pipeline.
          </p>
          <div className="mt-7 sm:mt-9 flex flex-col sm:flex-row items-stretch sm:items-center gap-2.5 sm:gap-3">
            <a
              href="#tiers"
              className="press group inline-flex items-center justify-center gap-2 rounded-lg bg-spark px-5 py-4 sm:py-3 text-[15px] font-semibold text-black shadow-[0_8px_24px_-8px_rgba(250,204,21,0.5)] hover:bg-spark-200"
            >
              See tiers
              <span aria-hidden className="transition-transform group-hover:translate-x-0.5">→</span>
            </a>
            <a
              href="#contact"
              className="press inline-flex items-center justify-center gap-2 rounded-lg border border-white/15 px-5 py-4 sm:py-3 text-[15px] font-medium text-white/90 hover:border-white/30 hover:bg-white/[0.04]"
            >
              Get in touch
            </a>
          </div>
        </div>
      </section>

      {/* Why sponsor */}
      <section className="relative py-16 sm:py-20 md:py-28 px-5 sm:px-6">
        <div className="mx-auto max-w-6xl">
          <div className="max-w-2xl">
            <p className="text-[11px] sm:text-xs font-medium uppercase tracking-[0.22em] text-spark">
              Why sponsor SparkLine?
            </p>
            <h2 className="mt-3 text-[32px] sm:text-4xl md:text-5xl font-bold tracking-[-0.02em] text-white leading-[1.05]">
              Three things you get back.
            </h2>
          </div>
          <ul className="mt-10 sm:mt-12 grid gap-4 sm:gap-5 sm:grid-cols-3">
            {WHY.map((w) => {
              const Icon = w.icon;
              return (
                <li
                  key={w.title}
                  className="rounded-2xl border border-white/10 bg-white/[0.02] p-6"
                >
                  <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-spark/15 text-spark">
                    <Icon className="h-5 w-5" />
                  </span>
                  <h3 className="mt-4 text-lg sm:text-xl font-semibold tracking-tight text-white">
                    {w.title}
                  </h3>
                  <p className="mt-2 text-[14px] sm:text-[15px] text-white/75 leading-relaxed">
                    {w.body}
                  </p>
                </li>
              );
            })}
          </ul>
        </div>
      </section>

      {/* Tiers */}
      <section
        id="tiers"
        className="relative py-16 sm:py-20 md:py-28 px-5 sm:px-6 border-t border-white/10"
      >
        <div className="mx-auto max-w-6xl">
          <div className="max-w-2xl">
            <p className="text-[11px] sm:text-xs font-medium uppercase tracking-[0.22em] text-spark">
              Sponsor tiers
            </p>
            <h2 className="mt-3 text-[32px] sm:text-4xl md:text-5xl font-bold tracking-[-0.02em] text-white leading-[1.05]">
              Pick the level that fits.
            </h2>
            <p className="mt-4 text-base sm:text-[17px] text-white/75 leading-relaxed">
              Every tier contributes to the cohort grant pool. Custom packages
              available — just ask.
            </p>
          </div>

          <div className="mt-10 sm:mt-12 grid gap-4 sm:gap-5 md:grid-cols-3">
            {TIERS.map((t) => (
              <div
                key={t.name}
                className={`relative flex flex-col rounded-2xl border p-6 sm:p-7 ${
                  t.highlight
                    ? "border-spark/40 bg-gradient-to-br from-spark/[0.08] to-transparent"
                    : "border-white/10 bg-white/[0.02]"
                }`}
              >
                {t.highlight && (
                  <span className="absolute -top-3 left-6 rounded-full bg-spark px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-black">
                    Most popular
                  </span>
                )}
                <p className="text-[11px] font-medium uppercase tracking-[0.18em] text-white/55">
                  {t.name}
                </p>
                <div className="mt-2 flex items-baseline gap-2">
                  <span
                    className={`text-3xl sm:text-4xl font-bold tracking-[-0.02em] ${
                      t.highlight ? "text-spark" : "text-white"
                    }`}
                  >
                    {t.price}
                  </span>
                </div>
                <p className="mt-2 text-sm text-white/75">{t.tagline}</p>
                <ul className="mt-5 space-y-2.5 text-[14px] text-white/80">
                  {t.perks.map((p) => (
                    <li key={p} className="flex items-start gap-2.5">
                      <Check className="mt-0.5 h-4 w-4 shrink-0 text-spark" />
                      <span>{p}</span>
                    </li>
                  ))}
                </ul>
                <a
                  href="#contact"
                  className={`press mt-6 inline-flex w-full items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-sm font-semibold ${
                    t.highlight
                      ? "bg-spark text-black hover:bg-spark-200"
                      : "border border-white/15 text-white hover:border-white/30 hover:bg-white/5"
                  }`}
                >
                  Talk to us
                  <span aria-hidden>→</span>
                </a>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Contact */}
      <section
        id="contact"
        className="relative py-16 sm:py-20 md:py-28 px-5 sm:px-6 border-t border-white/10"
      >
        <div className="mx-auto max-w-3xl">
          <div className="max-w-2xl">
            <p className="text-[11px] sm:text-xs font-medium uppercase tracking-[0.22em] text-spark">
              Get in touch
            </p>
            <h2 className="mt-3 text-[32px] sm:text-4xl md:text-5xl font-bold tracking-[-0.02em] text-white leading-[1.05]">
              Let's build something together.
            </h2>
            <p className="mt-4 text-base sm:text-[17px] text-white/75 leading-relaxed">
              Tell us a bit about your company and which tier looks right —
              we'll come back with a tailored proposal.
            </p>
          </div>

          <div className="mt-10 sm:mt-12 rounded-2xl border border-white/10 bg-white/[0.02] p-6 sm:p-8">
            <SponsorContactForm />
          </div>
        </div>
      </section>

      <Footer />
    </main>
  );
}
