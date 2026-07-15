import { headers } from "next/headers";
import Navbar from "@/components/navbar";
import Hero from "@/components/hero";
import HowItWorks from "@/components/how-it-works";
import FrontPage from "@/components/front-page";
import FinePrint from "@/components/fine-print";
import CTA from "@/components/cta";
import Footer from "@/components/footer";
import StickyMobileCta from "@/components/sticky-mobile-cta";
import { StatusBar } from "@/components/status-bar";
import { PixelField } from "@/components/pixel-field";
import { getSiteConfig } from "@/lib/site-config";
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
  const [config, profile] = await Promise.all([
    getSiteConfig({ countryCode }),
    getProfile(),
  ]);
  const authedHome = profile ? roleHome(profile.role) : null;
  return (
    <main className="min-h-screen bg-paper">
      <StatusBar config={config} />
      <Navbar
        authedHome={authedHome}
        cohortLabel={config.derived.cohortLabel || "the next cohort"}
      />
      {/* ONE OBJECT: a single container — every movement starts on the
          same (invisible) left margin and shares the 12-column grid.
          Alignment is felt through consistency, never drawn as a line. */}
      <div className="mx-auto max-w-[1100px] px-5 sm:px-6">
        <Hero config={config} authedHome={authedHome} />
        <HowItWorks config={config} />
        <FrontPage config={config} />
        <FinePrint config={config} />
        <CTA config={config} />
      </div>
      <Footer config={config} />
      <StickyMobileCta config={config} authedHome={authedHome} />
      <PixelField />
    </main>
  );
}
