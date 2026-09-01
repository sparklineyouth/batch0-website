import type { Metadata } from "next";
import Navbar from "@/components/navbar";
import Hero from "@/components/hero";
import Thesis from "@/components/thesis";
import TheDeal from "@/components/the-deal";
import HowItWorks from "@/components/how-it-works";
import Manifest from "@/components/manifest";
import WhoRunsThis from "@/components/who-runs-this";
import Faq from "@/components/faq";
import CTA from "@/components/cta";
import Footer from "@/components/footer";
import StickyMobileCta from "@/components/sticky-mobile-cta";
import { OverHeroChrome } from "@/components/over-hero-chrome";
import { PixelField } from "@/components/pixel-field";
import { RegionalPrice } from "@/components/regional-price";
import { getPublicSiteConfig, metaDescription } from "@/lib/site-config";

// The homepage snippet is the single highest-leverage string on the site: it
// is what a student sees on Google before they ever reach us, and for most of
// them it is the only thing they will read. So it is generated per request
// from the live cohort record rather than hardcoded at build time.
//
// This costs nothing, and it must be the *public* read: `getSiteConfig` goes
// through the no-store admin client, which throws DynamicServerError during
// prerendering — postgrest swallows it, the snippet silently falls back to
// FALLBACK_COHORT, and the whole page drops off the static path. The cached
// read is shared with the page component below, so metadata and body come
// from one query and can never disagree.
//
// Title inherits from the root layout. The canonical is set here, not in the
// layout, so child routes don't all inherit "/".
export async function generateMetadata(): Promise<Metadata> {
  const config = await getPublicSiteConfig({
    // Deliberately region-agnostic: crawlers hit us from arbitrary IPs, and a
    // snippet quoting a regional discount to everyone would misprice the
    // program for most searchers. The page body still localises.
    countryCode: null,
  });
  const description = metaDescription(config);
  return {
    description,
    alternates: { canonical: "/" },
    openGraph: { description },
    twitter: { description },
  };
}

// Prerendered with ISR — nothing here is per-visitor. The auth-dependent CTA
// resolves in the browser (/home + AuthLabel), and regional tuition, the last
// per-request input, is a client-side text swap: the pricing override table
// has exactly one country, so the server renders the base price and
// <RegionalPrice> corrects the label for visitors whose clock says India.
// Admin edits revalidate SITE_CONFIG_TAG and this path directly, so the
// 300s window is only the fallback horizon.
export const revalidate = 300;

export default async function Home() {
  const [config, regionalConfig] = await Promise.all([
    getPublicSiteConfig({ countryCode: null }),
    // The same cached data derived as an Indian visitor sees it — this is
    // where <RegionalPrice>'s swap target comes from, so the label always
    // matches what derive() would have produced server-side.
    getPublicSiteConfig({ countryCode: "IN" }),
  ]);

  return (
    // The outer element is a plain <div>, not <main>. A <main> that contains
    // the navbar and the footer swallows their `banner` and `contentinfo`
    // landmarks, and it makes the "Skip to content" link land above the very
    // nav it is supposed to skip. <main> now wraps only the content, and
    // carries no layout classes of its own so nothing moves.
    <div className="min-h-screen bg-paper">
      {/* The chrome floats over the hero painting rather than sitting on a
          band above it, and takes its opaque background back as soon as the
          visitor scrolls. Fixed, so the hero starts at y=0. */}
      <OverHeroChrome>
        <Navbar
          cohortLabel={config.derived.cohortLabel || "the next cohort"}
          overHero
        />
      </OverHeroChrome>

      <main id="main-content" tabIndex={-1}>
        {/* Full-bleed: the hero is the one section outside the shared
            container, because its painting runs edge to edge. */}
        <Hero />

        {/* ONE OBJECT: a single container — every section starts on the same
            left margin and shares the 12-column grid. */}
        <div className="mx-auto max-w-[1100px] px-5 sm:px-6">
          <Thesis />
          <TheDeal config={config} />
          <HowItWorks config={config} />
          <Manifest />
          <WhoRunsThis config={config} />
          <Faq config={config} />
          <CTA config={config} />
        </div>
      </main>

      <Footer config={config} />
      <StickyMobileCta config={config} />
      <RegionalPrice
        base={config.derived.priceLabel}
        regional={regionalConfig.derived.priceLabel}
      />
      <PixelField />
    </div>
  );
}
