import type { Metadata } from "next";
import { connection } from "next/server";
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
import { FeaturedGuides } from "@/components/featured-guides";
import { getPublicSiteConfig, metaDescription } from "@/lib/site-config";
import { activePromo, promoTitle, promoMetaDescription } from "@/lib/promo";
import { getFeaturedPosts, getAllPostsMeta } from "@/lib/blog";
import { getActiveChallenge, getPublicWinners } from "@/lib/challenges";
import { RegionalPrice } from "@/components/regional-price";

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
  await connection();
  const config = await getPublicSiteConfig({
    // Deliberately region-agnostic: crawlers hit us from arbitrary IPs, and a
    // snippet quoting a regional discount to everyone would misprice the
    // program for most searchers. The page body still localises.
    countryCode: null,
  });
  // Resolve the promotion at request time, alongside the current admission
  // window, so expired prices and cohort dates do not linger in metadata.
  const promo = activePromo(new Date(), config.settings.promo);
  const description = promo
    ? promoMetaDescription(
        promo,
        config.derived.priceLabel,
        config.derived.listPriceLabel,
      )
    : metaDescription(config);
  return {
    ...(promo ? { title: promoTitle(promo) } : {}),
    description,
    alternates: { canonical: "/" },
    openGraph: { description },
    twitter: { description },
  };
}

// Admissions change at an exact Eastern deadline. Render on the request,
// while getPublicSiteConfig caches the underlying cohort/settings facts.
// Regional labels still use the same client-side localization as before.

export default async function Home() {
  await connection();
  const [config, regionalConfig, activeChallenge, winners, featured, allPosts] =
    await Promise.all([
      getPublicSiteConfig({ countryCode: null }),
      // The same cached data derived as an Indian visitor sees it — this is
      // where <RegionalPrice>'s swap target comes from, so the label always
      // matches what derive() would have produced server-side.
      getPublicSiteConfig({ countryCode: "IN" }),
      getActiveChallenge(),
      getPublicWinners(),
      getFeaturedPosts(6),
      getAllPostsMeta(),
    ]);
  return (
    // The outer element is a plain <div>, not <main>. A <main> that contains
    // the navbar and the footer swallows their `banner` and `contentinfo`
    // landmarks, and it makes the "Skip to content" link land above the very
    // nav it is supposed to skip. <main> now wraps only the content, and
    // carries no layout classes of its own so nothing moves.
    <div className="min-h-screen bg-paper">
      <Navbar cohortLabel={config.derived.cohortLabel || "the next cohort"} applicationLabel={config.derived.applicationLabel} />
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
      <main id="main-content" tabIndex={-1}>
        <Hero config={config} />
        <HowItWorks config={config} />
        <Deliverables />
        <Founder contactEmail={config.settings.contactEmail} />
        <ChallengeWinners winners={winners} />
        {/* Placed before pricing on purpose: someone weighing $130 should see
            proof the teaching is good before they see the number. It also gives
            the blog its only link from the site's strongest page. */}
        <FeaturedGuides posts={featured} total={allPosts.length} />
        <section className="border-y border-line bg-wash px-5 py-10 sm:px-6" aria-labelledby="starter-kit-title">
          <div className="mx-auto flex max-w-[1100px] flex-col gap-5 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h2 id="starter-kit-title" className="text-xl font-semibold">Try your first founder exercise.</h2>
              <p className="mt-2 max-w-xl text-sm text-ink-soft">Choose a problem, plan a customer interview, and decide what to test. Our free starter kit gives you a worksheet and a guided reading path.</p>
            </div>
            <a href="/start?utm_source=homepage&utm_medium=owned&utm_campaign=founder_starter_kit" className="inline-flex shrink-0 items-center justify-center rounded-lg bg-phosphor px-5 py-3 text-sm font-semibold text-black hover:opacity-90">Get the free starter kit →</a>
          </div>
        </section>
        <Pricing config={config} />
        <FAQ config={config} />
        <CTA config={config} />
      </main>
      <Footer config={config} />
      <StickyMobileCta config={config} />
      <RegionalPrice
        base={config.derived.priceLabel}
        regional={regionalConfig.derived.priceLabel}
      />
    </div>
  );
}
