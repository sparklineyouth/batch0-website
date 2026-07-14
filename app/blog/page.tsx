import Link from "next/link";
import Navbar from "@/components/navbar";
import Footer from "@/components/footer";
import { getSiteConfig } from "@/lib/site-config";
import { getProfile, roleHome } from "@/lib/auth";
import { getAllPostsMeta, formatPostDate, type PostMeta } from "@/lib/blog";

const SITE = "https://www.sparklineyouth.org";

export const metadata = {
  title: "Startup Guides for High Schoolers — Sparkline Youth Blog",
  description:
    "Practical, no-fluff guides and essays for high-school founders: how to validate an idea, run customer interviews, build an MVP with no code, price your first product, and pitch at demo day.",
  alternates: { canonical: "/blog" },
  openGraph: {
    title: "Startup Guides for High Schoolers — Sparkline Youth Blog",
    description:
      "Practical guides and essays for high-school founders: validate an idea, run customer interviews, build an MVP, price it, and pitch it.",
    url: `${SITE}/blog`,
    type: "website",
  },
};

function PostRow({ post }: { post: PostMeta }) {
  return (
    <li className="group border-b border-line py-8 first:pt-0 last:border-b-0">
      <Link href={`/blog/${post.slug}`} className="block">
        <div className="grid gap-3 md:grid-cols-12 md:gap-8">
          <div className="md:col-span-3">
            <p className="font-mono text-[12px] uppercase tracking-[0.08em] text-ink-faint">
              {post.category}
            </p>
            <p className="mt-1 font-mono text-[13px] text-ink-faint">
              {formatPostDate(post.date)}
            </p>
            <p className="mt-1 font-mono text-[12px] text-ink-faint">
              {post.readingTime} min read
            </p>
          </div>
          <div className="md:col-span-9">
            <h2 className="font-display text-[1.5rem] font-bold leading-[1.12] tracking-[-0.02em] text-ink underline decoration-transparent decoration-2 underline-offset-4 group-hover:decoration-spark">
              {post.title}
            </h2>
            <p className="mt-2 max-w-[46rem] text-[15px] leading-[1.6] text-ink-soft">
              {post.excerpt}
            </p>
            <p className="mt-3 font-mono text-[12px] text-ink-faint">
              {post.author.name}
            </p>
          </div>
        </div>
      </Link>
    </li>
  );
}

export default async function BlogIndexPage() {
  const [config, profile, posts] = await Promise.all([
    getSiteConfig(),
    getProfile(),
    getAllPostsMeta(),
  ]);
  const authedHome = profile ? roleHome(profile.role) : null;
  const cohortLabel = config.derived.cohortLabel || "the next cohort";

  // Blog collection JSON-LD — lets search + AI engines understand this is a
  // structured content hub and enumerate the articles from one place.
  const blogJsonLd = {
    "@context": "https://schema.org",
    "@type": "Blog",
    "@id": `${SITE}/blog`,
    name: "Sparkline Youth Blog",
    description:
      "Guides and essays on building a startup as a high schooler — from idea validation to demo day.",
    url: `${SITE}/blog`,
    publisher: {
      "@type": "Organization",
      name: "Sparkline Youth",
      url: SITE,
      logo: `${SITE}/logo.svg`,
    },
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
          <p className="font-mono text-[13px] text-ink-faint">The Sparkline Blog</p>
          <h1 className="mt-3 max-w-[20ch] font-display text-[clamp(2.25rem,5.5vw,3.5rem)] font-bold leading-[1.03] tracking-[-0.025em] text-ink">
            How to actually <span className="hl">build a company</span> in high school.
          </h1>
          <p className="mt-6 max-w-[42rem] text-[1.0625rem] leading-[1.6] text-ink-soft">
            No theory-for-theory&apos;s-sake. These are the same playbooks we
            run inside the Sparkline cohort — validating an idea, interviewing
            strangers, shipping an MVP with no code, pricing it, and pitching it
            live. Written for people who plan to finish.
          </p>
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
