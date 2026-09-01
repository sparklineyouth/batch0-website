import Link from "next/link";
import { CATEGORIES, categoryPath, type PostMeta } from "@/lib/blog-shared";

/**
 * Homepage section linking into the blog.
 *
 * This exists for two reasons, one for readers and one for crawlers.
 *
 * For readers: someone weighing a $130 program wants proof the teaching is
 * any good before they apply. Six real guides do that better than any claim
 * on the landing page.
 *
 * For crawlers: the homepage carries the site's authority and passed exactly
 * none of it to the blog — it linked to zero posts. Meanwhile an exact-phrase
 * search for a post title that exists nowhere else on the internet returns
 * nothing, i.e. most of the 135 guides aren't in Google's index at all. This
 * section plus the category links in the footer give every post a short path
 * from the strongest page on the site:
 *
 *     homepage → featured post           (2 hops to 6 posts)
 *     homepage → category hub → post     (3 hops to all 135)
 *
 * The headings are written as the questions people actually search, because
 * that is also what makes them useful section labels. That is the honest
 * version of "targeting keywords" — no stuffing, no hidden text, nothing a
 * reader wouldn't want on the page anyway.
 */
export function FeaturedGuides({
  posts,
  total,
}: {
  posts: PostMeta[];
  /** Total published posts, so the "all guides" link can be specific. */
  total: number;
}) {
  if (posts.length === 0) return null;

  return (
    <section className="border-t border-line px-5 py-16 sm:px-6 md:py-24">
      <div className="mx-auto max-w-[1100px]">
        <h2 className="font-display text-[clamp(1.75rem,3.5vw,2.5rem)] font-bold leading-[1.08] tracking-[-0.02em] text-ink">
          Start learning before you apply
        </h2>
        <p className="mt-4 max-w-[42rem] text-[1.0625rem] leading-[1.6] text-ink-soft">
          The same playbooks we run inside the cohort, free and in public.
          Nothing here is gated.
        </p>

        <ul className="mt-10 grid gap-x-8 gap-y-8 sm:grid-cols-2 lg:grid-cols-3">
          {posts.map((post) => (
            <li key={post.slug}>
              <Link href={`/blog/${post.slug}`} className="group block">
                <p className="font-mono text-[12px] uppercase tracking-[0.08em] text-ink-faint">
                  {post.category}
                </p>
                <h3 className="mt-2 font-display text-[1.25rem] font-bold leading-[1.15] tracking-[-0.02em] text-ink underline decoration-transparent decoration-2 underline-offset-4 group-hover:decoration-phosphor">
                  {post.title}
                </h3>
                <p className="mt-2 text-[15px] leading-[1.6] text-ink-soft">
                  {post.excerpt}
                </p>
                <p className="mt-2 font-mono text-[12px] text-ink-faint">
                  {post.readingTime} min read
                </p>
              </Link>
            </li>
          ))}
        </ul>

        <div className="mt-10 flex flex-wrap items-center gap-x-5 gap-y-2 font-mono text-[13px]">
          <Link href="/blog" className="link-ink font-medium">
            All {total} guides →
          </Link>
          {CATEGORIES.map((c) => (
            <Link
              key={c}
              href={categoryPath(c)}
              className="text-ink-faint hover:text-ink"
            >
              {c}
            </Link>
          ))}
        </div>
      </div>
    </section>
  );
}
