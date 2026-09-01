import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import Navbar from "@/components/navbar";
import Footer from "@/components/footer";
import { ApplyCta } from "@/components/apply-cta";
import { getPublicSiteConfig } from "@/lib/site-config";
import {
  getPostBySlug,
  getPostSlugs,
  getRelatedPosts,
  formatPostDate,
} from "@/lib/blog";
import { SITE, ORG_ID } from "@/lib/schema";
import { blogTitleTag } from "@/lib/seo-meta";
import { categoryPath } from "@/lib/blog-shared";

// Every post is a file on disk, so the whole set can be pre-rendered at
// build time — static HTML is the fastest thing to serve and the cleanest
// thing for both search crawlers and AI retrieval bots to read.
//
// This was true in intent but not in fact: the build table printed "● SSG"
// for this route (which only means generateStaticParams exists) while the
// prerender manifest contained zero /blog/<slug> entries. Two dynamic APIs
// were aborting every prerender — cookies(), via a getProfile() call that
// existed to pick one navbar href, and a forced `no-store` fetch inside
// getSiteConfig(). Both are gone; these 135 articles are real static HTML
// again, which is what the two worst Core Web Vitals scores in production
// were waiting on.
export async function generateStaticParams() {
  return (await getPostSlugs()).map((slug) => ({ slug }));
}

// Posts are immutable prose; the only thing on the page that moves is the
// price in the end-of-post CTA. An hour is a generous ceiling on staleness,
// and admin edits publish immediately anyway — the settings and cohort
// actions call revalidateTag(SITE_CONFIG_TAG), and publishing a post
// revalidates /blog. `dynamicParams` stays default-true, so a post authored
// in the admin panel after the last build still renders on first request and
// is cached from then on.
export const revalidate = 3600;

export async function generateMetadata({
  params,
}: {
  params: { slug: string };
}): Promise<Metadata> {
  const post = await getPostBySlug(params.slug);
  if (!post) return {};
  const { meta } = post;
  const url = `${SITE}/blog/${meta.slug}`;
  return {
    // Conditional brand suffix — see `blogTitleTag`. Unconditionally appending
    // " — batch0" pushed 58 of 135 posts past Google's ~60-character render
    // budget, and the truncation ate the suffix it was there to add.
    title: blogTitleTag(meta.title, meta.seoTitle),
    description: meta.description,
    keywords: meta.tags,
    alternates: { canonical: `/blog/${meta.slug}` },
    authors: [{ name: meta.author.name }],
    openGraph: {
      type: "article",
      title: meta.title,
      description: meta.description,
      url,
      siteName: "batch0",
      publishedTime: meta.date,
      modifiedTime: meta.updated,
      authors: [meta.author.name],
      section: meta.category,
      tags: meta.tags,
    },
    twitter: {
      card: "summary_large_image",
      title: meta.title,
      description: meta.description,
    },
  };
}

export default async function BlogPostPage({
  params,
}: {
  params: { slug: string };
}) {
  const post = await getPostBySlug(params.slug);
  if (!post) notFound();
  const { meta, html } = post;

  // Both of these are cheap now and neither depends on the other: config is
  // a tagged cache read, related posts come off a process-level index of the
  // post frontmatter rather than re-reading 135 files from disk.
  const [config, related] = await Promise.all([
    getPublicSiteConfig(),
    getRelatedPosts(meta),
  ]);
  const cohortLabel = config.derived.cohortLabel || "the next cohort";
  const url = `${SITE}/blog/${meta.slug}`;
  const ogImage = `${SITE}/blog/${meta.slug}/opengraph-image`;

  // BlogPosting JSON-LD. Every field is real: dates from frontmatter, author
  // from the canonical roster, publisher = the org. `headline` is the title
  // (kept ≤110 chars in frontmatter so Google won't truncate it).
  const articleJsonLd = {
    "@context": "https://schema.org",
    "@type": "BlogPosting",
    "@id": url,
    mainEntityOfPage: { "@type": "WebPage", "@id": url },
    headline: meta.title,
    description: meta.description,
    image: [ogImage],
    datePublished: meta.date,
    dateModified: meta.updated,
    articleSection: meta.category,
    keywords: meta.tags.join(", "),
    author: {
      "@type": "Person",
      name: meta.author.name,
      url: meta.author.url,
    },
    // Reference, not a redeclaration — the full org node ships in the root
    // layout and matching `@id`s merge them into one entity.
    publisher: { "@id": ORG_ID },
    isPartOf: {
      "@type": "Blog",
      "@id": `${SITE}/blog`,
      name: "batch0 Blog",
    },
  };

  const breadcrumbJsonLd = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "Home", item: SITE },
      { "@type": "ListItem", position: 2, name: "Blog", item: `${SITE}/blog` },
      // The category hub sits between the blog and the post. This is the
      // structural half of the topic cluster: it tells a crawler which of the
      // six themes this post belongs to, and mirrors the visible breadcrumb.
      {
        "@type": "ListItem",
        position: 3,
        name: meta.category,
        item: `${SITE}${categoryPath(meta.category)}`,
      },
      {
        "@type": "ListItem",
        position: 4,
        name: meta.title,
        item: url,
      },
    ],
  };

  return (
    // <main> wraps the content only: containing the navbar and footer in it
    // suppresses their banner/contentinfo landmarks and sends "Skip to
    // content" above the nav. No layout classes on it, so nothing shifts.
    <div className="min-h-screen bg-paper">
      <Navbar cohortLabel={cohortLabel} />
      <main id="main-content" tabIndex={-1}>

      <article className="px-5 sm:px-6">
        <div className="mx-auto max-w-[720px] pt-10 sm:pt-14">
          {/* Breadcrumb (visible, mirrors the JSON-LD). */}
          <nav aria-label="Breadcrumb" className="font-mono text-[12px] text-ink-faint">
            <Link href="/blog" className="hover:text-ink">
              Blog
            </Link>
            <span aria-hidden className="px-2">
              /
            </span>
            {/* Links up to the category hub — every post in a cluster passes
                authority to its hub, and readers get a way sideways. */}
            <Link
              href={categoryPath(meta.category)}
              className="text-ink-soft hover:text-ink"
            >
              {meta.category}
            </Link>
          </nav>

          <header className="mt-6">
            <h1 className="font-display text-[clamp(2rem,5vw,3rem)] font-bold leading-[1.05] tracking-[-0.025em] text-ink">
              {meta.title}
            </h1>
            <div className="mt-5 flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-[13px] text-ink-faint">
              <span className="text-ink-soft">{meta.author.name}</span>
              <span aria-hidden>·</span>
              <time dateTime={meta.date}>{formatPostDate(meta.date)}</time>
              <span aria-hidden>·</span>
              <span>{meta.readingTime} min read</span>
            </div>
          </header>

          <div
            className="blog-prose mt-10"
            // The HTML is produced by our own trusted markdown pipeline from
            // repo-authored files — no user input is ever interpolated.
            dangerouslySetInnerHTML={{ __html: html }}
          />

          {/* End-of-post CTA — the whole blog exists to feed the accelerator. */}
          <aside className="mt-14 border-t border-line pt-10">
            <p className="font-display text-[1.375rem] font-bold leading-[1.2] tracking-[-0.02em] text-ink">
              Stop reading. Start building.
            </p>
            <p className="mt-3 max-w-[40rem] text-[15px] leading-[1.65] text-ink-soft">
              batch0 is a live, online accelerator for high schoolers.
              You&apos;ll build a real company across four sprints and pitch it
              at demo day. Free to apply, {config.derived.priceLabel}{" "}
              only if accepted, no equity taken.
            </p>
            <div className="mt-6 flex flex-col items-stretch gap-3 sm:flex-row sm:items-center">
              <ApplyCta label={`Apply for ${cohortLabel}`} location="blog-post" />
              <Link href="/program" className="link-ink text-[15px] font-medium">
                See the full program
              </Link>
            </div>
          </aside>
        </div>
      </article>

      {/* Related posts — the internal-link hub. */}
      {related.length > 0 && (
        <section className="mt-16 border-t border-line bg-wash px-5 py-14 sm:px-6">
          <div className="mx-auto max-w-[720px]">
            <h2 className="font-mono text-[12px] uppercase tracking-[0.08em] text-ink-faint">
              Keep reading
            </h2>
            <ul className="mt-6 space-y-6">
              {related.map((r) => (
                <li key={r.slug}>
                  <Link href={`/blog/${r.slug}`} className="group block">
                    <p className="font-mono text-[12px] text-ink-faint">
                      {r.category} · {r.readingTime} min
                    </p>
                    <p className="mt-1 font-display text-[1.125rem] font-bold leading-snug tracking-tight text-ink underline decoration-transparent decoration-2 underline-offset-4 group-hover:decoration-phosphor">
                      {r.title}
                    </p>
                    <p className="mt-1 max-w-[44rem] text-[14px] leading-[1.55] text-ink-soft">
                      {r.excerpt}
                    </p>
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        </section>
      )}

      </main>
      <Footer config={config} />

      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(articleJsonLd) }}
      />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(breadcrumbJsonLd) }}
      />
    </div>
  );
}
