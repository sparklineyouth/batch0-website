import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import Navbar from "@/components/navbar";
import Footer from "@/components/footer";
import { ApplyCta } from "@/components/apply-cta";
import { PostRow, CategoryNav } from "@/components/post-row";
import { getPublicSiteConfig } from "@/lib/site-config";
import { getPostsByCategory } from "@/lib/blog";
import {
  CATEGORIES,
  CATEGORY_COPY,
  categoryFromSlug,
  categoryPath,
  categorySlug,
} from "@/lib/blog-shared";
import { SITE, ORG_ID } from "@/lib/schema";
import { blogTitleTag } from "@/lib/seo-meta";

// Six hub pages, one per category.
//
// Why these exist: 135 posts in a single flat list gives Google one blog URL
// and 135 leaves, with nothing in between saying "these twenty-two pages are
// all about pitching". A hub per theme creates that middle layer — it
// consolidates a topic onto one strong URL, gives every post in the cluster
// something to link up to, and gives the index something to link down to.
//
// Statically generated: the category set is a compile-time constant, so
// there's no reason to resolve these per request.
// Prerendered like /blog and the articles themselves. This route arrived on
// the pre-refactor pattern — getProfile() for a navbar prop, plus the no-store
// getSiteConfig() — which is exactly the pair that was keeping every other
// marketing route on the per-request path. generateStaticParams alone doesn't
// make a route static; not reading cookies is what does.
export const revalidate = 3600;

export function generateStaticParams() {
  return CATEGORIES.map((c) => ({ category: categorySlug(c) }));
}

export const dynamicParams = false;

export async function generateMetadata({
  params,
}: {
  params: { category: string };
}): Promise<Metadata> {
  const category = categoryFromSlug(params.category);
  if (!category) return {};
  const copy = CATEGORY_COPY[category];
  const title = blogTitleTag(copy.heading);
  const url = `${SITE}${categoryPath(category)}`;

  return {
    title,
    description: copy.description,
    alternates: { canonical: categoryPath(category) },
    openGraph: {
      type: "website",
      title,
      description: copy.description,
      url,
      siteName: "batch0",
    },
    twitter: {
      card: "summary_large_image",
      title,
      description: copy.description,
    },
  };
}

export default async function BlogCategoryPage({
  params,
}: {
  params: { category: string };
}) {
  const category = categoryFromSlug(params.category);
  if (!category) notFound();

  const [config, posts] = await Promise.all([
    getPublicSiteConfig(),
    getPostsByCategory(category),
  ]);
  const cohortLabel = config.derived.cohortLabel || "the next cohort";
  const copy = CATEGORY_COPY[category];
  const url = `${SITE}${categoryPath(category)}`;

  const navItems = CATEGORIES.map((c) => ({
    label: c,
    href: categoryPath(c),
  }));

  // CollectionPage + ItemList. The ItemList lets a crawler enumerate the whole
  // cluster from this one URL without following 22 links first, and states the
  // ordering explicitly so position isn't inferred.
  const collectionJsonLd = {
    "@context": "https://schema.org",
    "@type": "CollectionPage",
    "@id": url,
    url,
    name: copy.heading,
    description: copy.description,
    isPartOf: { "@type": "Blog", "@id": `${SITE}/blog`, name: "batch0 Blog" },
    publisher: { "@id": ORG_ID },
    mainEntity: {
      "@type": "ItemList",
      itemListOrder: "https://schema.org/ItemListOrderDescending",
      numberOfItems: posts.length,
      itemListElement: posts.map((p, i) => ({
        "@type": "ListItem",
        position: i + 1,
        url: `${SITE}/blog/${p.slug}`,
        name: p.title,
      })),
    },
  };

  const breadcrumbJsonLd = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "Home", item: SITE },
      { "@type": "ListItem", position: 2, name: "Blog", item: `${SITE}/blog` },
      { "@type": "ListItem", position: 3, name: category, item: url },
    ],
  };

  return (
    <main className="min-h-screen bg-paper">
      <Navbar cohortLabel={cohortLabel} />

      <section className="px-5 pb-10 pt-14 sm:px-6 sm:pt-20">
        <div className="mx-auto max-w-[1100px]">
          <nav
            aria-label="Breadcrumb"
            className="font-mono text-[12px] text-ink-faint"
          >
            <Link href="/blog" className="hover:text-ink">
              Blog
            </Link>
            <span aria-hidden className="px-2">
              /
            </span>
            <span className="text-ink-soft">{category}</span>
          </nav>

          <h1 className="mt-6 max-w-[20ch] font-display text-[clamp(2.25rem,5.5vw,3.5rem)] font-bold leading-[1.03] tracking-[-0.025em] text-ink">
            {copy.heading}
          </h1>
          <p className="mt-6 max-w-[42rem] text-[1.0625rem] leading-[1.6] text-ink-soft">
            {copy.blurb}
          </p>
          <p className="mt-4 font-mono text-[13px] text-ink-faint">
            {posts.length} {posts.length === 1 ? "guide" : "guides"}
          </p>

          <div className="mt-10">
            <CategoryNav categories={navItems} active={category} />
          </div>
        </div>
      </section>

      <section className="px-5 pb-16 sm:px-6">
        <div className="mx-auto max-w-[1100px]">
          {posts.length === 0 ? (
            <p className="text-[15px] text-ink-soft">
              Nothing here yet — try{" "}
              <Link href="/blog" className="link-ink">
                every guide
              </Link>
              .
            </p>
          ) : (
            <ul className="border-t border-line">
              {posts.map((post) => (
                <PostRow key={post.slug} post={post} showCategory={false} />
              ))}
            </ul>
          )}
        </div>
      </section>

      <section className="border-t border-line bg-wash px-5 py-14 sm:px-6">
        <div className="mx-auto max-w-[1100px]">
          <p className="font-display text-[1.375rem] font-bold leading-[1.2] tracking-[-0.02em] text-ink">
            Reading about it is the easy part.
          </p>
          <p className="mt-3 max-w-[40rem] text-[15px] leading-[1.65] text-ink-soft">
            batch0 is a live, online accelerator for high schoolers. You&apos;ll
            build a real company across four sprints and pitch it at demo day.
            Free to apply, {config.derived.priceLabel} only if accepted, no
            equity taken.
          </p>
          <div className="mt-6 flex flex-col items-stretch gap-3 sm:flex-row sm:items-center">
            <ApplyCta
              label={`Apply for ${cohortLabel}`}
              location="blog-category"
            />
            <Link href="/program" className="link-ink text-[15px] font-medium">
              See the full program
            </Link>
          </div>
        </div>
      </section>

      <Footer config={config} />

      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(collectionJsonLd) }}
      />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(breadcrumbJsonLd) }}
      />
    </main>
  );
}
