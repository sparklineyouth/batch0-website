import Link from "next/link";
import Navbar from "@/components/navbar";
import Footer from "@/components/footer";
import { getSiteConfig } from "@/lib/site-config";
import { getProfile, roleHome } from "@/lib/auth";
import { PostRow, CategoryNav } from "@/components/post-row";
import { getAllPostsMeta } from "@/lib/blog";
import { CATEGORIES, categoryPath } from "@/lib/blog-shared";
import { SITE, ORG_ID } from "@/lib/schema";

export const metadata = {
  title: "Startup Guides for High Schoolers — batch0",
  // Was 186 characters, so Google cut it at "price your first pro…". Now 152.
  description:
    "Practical guides for high-school founders: validate an idea, interview customers, build an MVP with no code, price it, get users, and pitch at demo day.",
  alternates: { canonical: "/blog" },
  openGraph: {
    title: "Startup Guides for High Schoolers — batch0 Blog",
    description:
      "Practical guides and essays for high-school founders: validate an idea, run customer interviews, build an MVP, price it, and pitch it.",
    url: `${SITE}/blog`,
    type: "website",
  },
};

export default async function BlogIndexPage() {
  const [config, profile, posts] = await Promise.all([
    getSiteConfig(),
    getProfile(),
    getAllPostsMeta(),
  ]);
  const authedHome = profile ? await roleHome(profile.role) : null;
  const cohortLabel = config.derived.cohortLabel || "the next cohort";

  // Blog collection JSON-LD — lets search + AI engines understand this is a
  // structured content hub and enumerate the articles from one place.
  const blogJsonLd = {
    "@context": "https://schema.org",
    "@type": "Blog",
    "@id": `${SITE}/blog`,
    name: "batch0 Blog",
    description:
      "Guides and essays on building a startup as a high schooler — from idea validation to demo day.",
    url: `${SITE}/blog`,
    // Reference, not a redeclaration: the full org node ships in the root
    // layout, and matching `@id`s are what let crawlers merge the two into
    // one entity instead of two thin ones.
    publisher: { "@id": ORG_ID },
    blogPost: posts.map((p) => ({
      "@type": "BlogPosting",
      headline: p.title,
      description: p.description,
      url: `${SITE}/blog/${p.slug}`,
      datePublished: p.date,
      dateModified: p.updated,
      author: { "@type": "Person", name: p.author.name },
    })),
  };

  const breadcrumbJsonLd = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "Home", item: SITE },
      { "@type": "ListItem", position: 2, name: "Blog", item: `${SITE}/blog` },
    ],
  };

  return (
    <main className="min-h-screen bg-paper">
      <Navbar authedHome={authedHome} cohortLabel={cohortLabel} />

      <section className="px-5 pb-10 pt-14 sm:px-6 sm:pt-20">
        <div className="mx-auto max-w-[1100px]">
          <p className="font-mono text-[13px] text-ink-faint">The batch0 Blog</p>
          <h1 className="mt-3 max-w-[20ch] font-display text-[clamp(2.25rem,5.5vw,3.5rem)] font-bold leading-[1.03] tracking-[-0.025em] text-ink">
            How to actually <span className="hl">build a company</span> in high school.
          </h1>
          <p className="mt-6 max-w-[42rem] text-[1.0625rem] leading-[1.6] text-ink-soft">
            No theory-for-theory&apos;s-sake. These are the same playbooks we
            run inside the batch0 cohort — validating an idea, interviewing
            strangers, shipping an MVP with no code, pricing it, and pitching it
            live. Written for people who plan to finish.
          </p>

          {/* Links down into the six topic hubs. Without this the hubs would
              be orphans that only the sitemap knows about. */}
          <div className="mt-10">
            <CategoryNav
              categories={CATEGORIES.map((c) => ({
                label: c,
                href: categoryPath(c),
              }))}
            />
          </div>
        </div>
      </section>

      <section className="px-5 pb-20 sm:px-6 md:pb-28">
        <div className="mx-auto max-w-[1100px]">
          {posts.length === 0 ? (
            <p className="text-[15px] text-ink-soft">
              First posts are on the way.
            </p>
          ) : (
            <ul className="border-t border-line">
              {posts.map((post) => (
                <PostRow key={post.slug} post={post} />
              ))}
            </ul>
          )}
        </div>
      </section>

      <Footer config={config} />

      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(blogJsonLd) }}
      />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(breadcrumbJsonLd) }}
      />
    </main>
  );
}
