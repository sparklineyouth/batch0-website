import Navbar from "@/components/navbar";
import Footer from "@/components/footer";
import { TIERS } from "./tiers";
import { SponsorContactForm } from "./sponsor-contact-form";
import { getSiteConfig } from "@/lib/site-config";
import { getProfile, roleHome } from "@/lib/auth";

export const metadata = {
  title: "Fund Grants for High-School Founders — batch0",
  description:
    "Fund non-dilutive grants for high-school founders in batch0's founding cohort. Three tiers, every dollar disclosed.",
  alternates: { canonical: "/sponsors" },
};

const WHY = [
  {
    title: "Grants, not swag",
    body: "Sponsorship funds the non-dilutive grant pool awarded to standout students at demo day. You can name the grant you fund.",
  },
  {
    title: "Early talent",
    body: "Cohort 1 seats up to 100 U.S. high schoolers, each building a real company. Meet them before recruiters do, as builders with work you can inspect.",
  },
  {
    title: "A straight ledger",
    body: "This is the founding cohort: no inflated alumni stats, no vanity metrics. You get exactly what each tier lists, and we report what your money funded.",
  },
];

export default async function SponsorsPage() {
  const [config, profile] = await Promise.all([getSiteConfig(), getProfile()]);
  const authedHome = profile ? roleHome(profile.role) : null;

  return (
    <main className="min-h-screen bg-paper">
      <Navbar
        authedHome={authedHome}
        cohortLabel={config.derived.cohortLabel || "the next cohort"}
      />

      {/* Hero */}
      <section className="px-5 pb-14 pt-14 sm:px-6 sm:pt-20 md:pb-20 md:pt-24">
        <div className="mx-auto max-w-[1100px]">
          <h1 className="max-w-[20ch] font-display text-[clamp(2.25rem,5.5vw,3.5rem)] font-bold leading-[1.03] tracking-[-0.025em] text-ink">
            Fund a high schooler&apos;s <span className="hl">first company</span>.
          </h1>
          <p className="mt-6 max-w-[38rem] text-[1.0625rem] leading-[1.6] text-ink-soft">
            batch0 is a live, online accelerator for U.S. high
            schoolers. Sponsorship pays for
            non-dilutive founder grants and keeps tuition at{" "}
            {config.derived.priceLabel} instead of the $3,000+ other programs
            charge. Cohort 1 runs{" "}
            {config.derived.dateRangeLabel.replace("→", "–")}.
          </p>
          <div className="mt-8 flex flex-col items-stretch gap-3 sm:flex-row sm:items-center">
            <a
              href="#tiers"
              className="press inline-flex items-center justify-center rounded-md bg-phosphor px-5 py-3.5 text-[15px] font-semibold text-on-phosphor shadow-cta hover:bg-phosphor-200"
            >
              See sponsor tiers
            </a>
            <a
              href={`mailto:${config.settings.contactEmail}`}
              className="press inline-flex items-center justify-center rounded-md border border-line px-5 py-3.5 text-[15px] font-medium text-ink hover:border-ink/30"
            >
              Email us directly
            </a>
          </div>
        </div>
      </section>

      {/* Why sponsor */}
      <section className="border-t border-line px-5 py-16 sm:px-6 md:py-24">
        <div className="mx-auto max-w-[1100px]">
          <h2 className="font-display text-[clamp(1.75rem,3.5vw,2.5rem)] font-bold leading-[1.08] tracking-[-0.02em] text-ink">
            What sponsorship buys
          </h2>
          <ul className="mt-10 grid gap-x-10 gap-y-8 md:grid-cols-3">
            {WHY.map((w) => (
              <li key={w.title} className="border-t-2 border-phosphor pt-4">
                <h3 className="text-[1.0625rem] font-semibold tracking-tight text-ink">
                  {w.title}
                </h3>
                <p className="mt-1.5 text-[15px] leading-[1.6] text-ink-soft">
                  {w.body}
                </p>
              </li>
            ))}
          </ul>
        </div>
      </section>

      {/* Tiers */}
      <section id="tiers" className="border-t border-line bg-wash px-5 py-16 sm:px-6 md:py-24">
        <div className="mx-auto max-w-[1100px]">
          <h2 className="font-display text-[clamp(1.75rem,3.5vw,2.5rem)] font-bold leading-[1.08] tracking-[-0.02em] text-ink">
            Tiers
          </h2>
          <p className="mt-4 max-w-[38rem] text-[15px] leading-[1.65] text-ink-soft">
            Every tier contributes to the founder grant pool. Custom
            packages: email us.
          </p>

          <div className="mt-10 grid gap-6 md:grid-cols-3 md:gap-0 md:divide-x md:divide-line md:border md:border-line md:bg-paper">
            {TIERS.map((t) => (
              <div key={t.name} className="border border-line bg-paper p-6 md:border-0 sm:p-7">
                <p className="font-mono text-[12px] uppercase tracking-[0.08em] text-ink-faint">
                  {t.name}
                </p>
                <p className="mt-2 font-display text-3xl font-bold tracking-[-0.02em] text-ink">
                  {t.price}
                </p>
                <p className="mt-2 text-sm text-ink-soft">{t.tagline}</p>
                <ul className="mt-5 space-y-2.5 text-[14px] leading-[1.55] text-ink-soft">
                  {t.perks.map((p) => (
                    <li key={p} className="flex items-start gap-2.5">
                      <span aria-hidden className="mt-[0.62em] h-[3px] w-[12px] shrink-0 bg-phosphor" />
                      <span>{p}</span>
                    </li>
                  ))}
                </ul>
                <a
                  href="#contact"
                  className="press mt-6 inline-flex w-full items-center justify-center rounded-md border border-ink/20 px-4 py-2.5 text-sm font-semibold text-ink hover:border-ink/40"
                >
                  Start with {t.name}
                </a>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Contact */}
      <section id="contact" className="border-t border-line px-5 py-16 sm:px-6 md:py-24">
        <div className="mx-auto max-w-[720px]">
          <h2 className="font-display text-[clamp(1.75rem,3.5vw,2.5rem)] font-bold leading-[1.08] tracking-[-0.02em] text-ink">
            Talk to the founder
          </h2>
          <p className="mt-4 max-w-[38rem] text-[15px] leading-[1.65] text-ink-soft">
            This opens an email to {config.settings.contactEmail} with your
            details. It lands with our team directly, and you&apos;ll hear back
            from a real person.
          </p>
          <div className="mt-8">
            <SponsorContactForm contactEmail={config.settings.contactEmail} />
          </div>
        </div>
      </section>

      <Footer config={config} />
    </main>
  );
}
