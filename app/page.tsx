import { headers } from "next/headers";
import Navbar from "@/components/navbar";
import Hero from "@/components/hero";
import VideoPlate from "@/components/video-plate";
import Thesis from "@/components/thesis";
import TheDeal from "@/components/the-deal";
import HowItWorks from "@/components/how-it-works";
import Manifest from "@/components/manifest";
import WhoRunsThis from "@/components/who-runs-this";
import FoundingCohort from "@/components/founding-cohort";
import Faq from "@/components/faq";
import CTA from "@/components/cta";
import Footer from "@/components/footer";
import StickyMobileCta from "@/components/sticky-mobile-cta";
import { StatusBar } from "@/components/status-bar";
import { OverHeroChrome } from "@/components/over-hero-chrome";
import { PixelField } from "@/components/pixel-field";
import { getSiteConfig } from "@/lib/site-config";
import { getActiveChallenge } from "@/lib/challenges";
import { ChallengePennant } from "@/components/challenge-pennant";
import { getCountryFromHeaders } from "@/lib/pricing";
import { getProfile, roleHome } from "@/lib/auth";

// Title/description inherit from the root layout; the canonical is set
// here (not in the layout) so child routes don't inherit "/".
export const metadata = { alternates: { canonical: "/" } };

/**
 * The homepage — the broadsheet system. Volume rhythm loud–quiet–loud with
 * exactly three poster moments (hero cascade, front page, closing poster),
 * and the one-ask rule: "apply" appears in the hero, the closing poster,
 * and the nav chrome — nowhere else. PixelField mounts the marketing
 * interaction layer (never on /apply or any form page).
 */
export default async function Home() {
  const countryCode = getCountryFromHeaders(headers());
  const [config, profile, challenge] = await Promise.all([
    getSiteConfig({ countryCode }),
    getProfile(),
    getActiveChallenge(),
  ]);
  const authedHome = profile ? roleHome(profile.role) : null;
  return (
    <main className="min-h-screen bg-paper">
      {/* The chrome floats over the hero image rather than sitting on a
          black band above it; it takes its opaque background back as soon
          as the visitor scrolls. Fixed, so the hero starts at y=0. */}
      <OverHeroChrome>
        <StatusBar config={config} overHero />
        <Navbar
          authedHome={authedHome}
          cohortLabel={config.derived.cohortLabel || "the next cohort"}
          overHero
        />
        <ChallengePennant
          title={challenge?.title}
          prizeLabel={challenge?.prizeLabel}
          closesAt={challenge?.closesAt}
        />
      </OverHeroChrome>

      {/* Full-bleed: the hero is the one section outside the shared
          container, because its image runs edge to edge. */}
      <Hero config={config} authedHome={authedHome} />

      {/* ONE OBJECT: a single container — every movement starts on the
          same (invisible) left margin and shares the 12-column grid.
          Alignment is felt through consistency, never drawn as a line. */}
      <div className="mx-auto max-w-[1100px] px-5 sm:px-6">
        <VideoPlate />
        <Thesis />
        <TheDeal config={config} />
        <HowItWorks config={config} />
        <Manifest />
        <WhoRunsThis config={config} />
        <FoundingCohort config={config} />
        <Faq config={config} />
        <CTA config={config} />
      </div>
      <Footer config={config} />
      <StickyMobileCta config={config} authedHome={authedHome} />
      <PixelField />
    </main>
  );
}
