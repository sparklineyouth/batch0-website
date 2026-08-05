import Link from "next/link";
import { formatPostDate, type PostMeta } from "@/lib/blog-shared";

/**
 * One row in a post listing. Shared by the blog index and the category hubs
 * so the two can't drift apart — they're the same object in two contexts.
 *
 * `showCategory` is off on category hubs, where every row would repeat the
 * same label for no benefit.
 */
export function PostRow({
  post,
  showCategory = true,
}: {
  post: PostMeta;
  showCategory?: boolean;
}) {
  return (
    <li className="group border-b border-line py-8 first:pt-0 last:border-b-0">
      <Link href={`/blog/${post.slug}`} className="block">
        <div className="grid gap-3 md:grid-cols-12 md:gap-8">
          <div className="md:col-span-3">
            {showCategory && (
              <p className="font-mono text-[12px] uppercase tracking-[0.08em] text-ink-faint">
                {post.category}
              </p>
            )}
            <p className="mt-1 font-mono text-[13px] text-ink-faint">
              {formatPostDate(post.date)}
            </p>
            <p className="mt-1 font-mono text-[12px] text-ink-faint">
              {post.readingTime} min read
            </p>
          </div>
          <div className="md:col-span-9">
            <h2 className="font-display text-[1.5rem] font-bold leading-[1.12] tracking-[-0.02em] text-ink underline decoration-transparent decoration-2 underline-offset-4 group-hover:decoration-phosphor">
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

/**
 * Horizontal links to every category hub.
 *
 * This is the spine of the cluster architecture: it appears on the blog index
 * and on every hub, so all six hubs are one click from each other and from the
 * index. Without it the hubs would be orphans that only the sitemap knows
 * about, which is exactly how a page fails to accumulate any authority.
 */
export function CategoryNav({
  categories,
  active,
}: {
  categories: readonly { label: string; href: string }[];
  active?: string;
}) {
  return (
    <nav
      aria-label="Blog categories"
      className="flex flex-wrap items-center gap-x-5 gap-y-2 font-mono text-[12px] uppercase tracking-[0.08em]"
    >
      <Link
        href="/blog"
        className={
          active ? "text-ink-faint hover:text-ink" : "text-ink underline underline-offset-4"
        }
      >
        All
      </Link>
      {categories.map((c) => (
        <Link
          key={c.href}
          href={c.href}
          className={
            active === c.label
              ? "text-ink underline decoration-phosphor decoration-2 underline-offset-4"
              : "text-ink-faint hover:text-ink"
          }
          aria-current={active === c.label ? "page" : undefined}
        >
          {c.label}
        </Link>
      ))}
    </nav>
  );
}
