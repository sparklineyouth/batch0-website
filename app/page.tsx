import { headers } from "next/headers";
import Navbar from "@/components/navbar";
import Hero from "@/components/hero";
import HowItWorks from "@/components/how-it-works";
import Deliverables from "@/components/deliverables";
import Curriculum from "@/components/curriculum";
import Founder from "@/components/founder";
import Pricing from "@/components/pricing";
import FAQ from "@/components/faq";
import CTA from "@/components/cta";
import Footer from "@/components/footer";
import StickyMobileCta from "@/components/sticky-mobile-cta";
import { ChallengeMarquee } from "@/components/challenge-marquee";
import { ChallengeWinners } from "@/components/challenge-winners";
import { getSiteConfig } from "@/lib/site-config";
import { getActiveChallenge, getPublicWinners } from "@/lib/challenges";
import { getCountryFromHeaders } from "@/lib/pricing";
import { getProfile, roleHome } from "@/lib/auth";

// Title/description inherit from the root layout; the canonical is set
// here (not in the layout) so child routes don't inherit "/".
export const metadata = { alternates: { canonical: "/" } };

export default async function Home() {
  const countryCode = getCountryFromHeaders(headers());
  const [config, profile, activeChallenge, winners] = await Promise.all([
    getSiteConfig({ countryCode }),
    getProfile(),
    getActiveChallenge(),
    getPublicWinners(),
  ]);
  const authedHome = profile ? roleHome(profile.role) : null;
  return (
    <main className="min-h-screen bg-paper">
      <Navbar
        authedHome={authedHome}
        cohortLabel={config.derived.cohortLabel || "the next cohort"}
      />
      {activeChallenge && (
        <ChallengeMarquee
          challenge={{
            slug: activeChallenge.slug,
            title: activeChallenge.title,
            marqueeText: activeChallenge.marqueeText,
            prizeLabel: activeChallenge.prizeLabel,
            ctaLabel: activeChallenge.ctaLabel,
            ctaHref: activeChallenge.ctaHref,
          }}
        />
      )}
      <Hero config={config} authedHome={authedHome} />
      <HowItWorks config={config} />
      <Deliverables />
      <Founder contactEmail={config.settings.contactEmail} />
      <ChallengeWinners winners={winners} />
      <Pricing config={config} />
      <FAQ config={config} />
      <CTA config={config} />
      <Footer config={config} />
      <StickyMobileCta config={config} authedHome={authedHome} />
    </main>
  );
}
