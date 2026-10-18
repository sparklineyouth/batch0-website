import type { MetadataRoute } from "next";
import { getAllPostsMeta } from "@/lib/blog";
import { CATEGORIES, categoryPath } from "@/lib/blog-shared";

// Canonical host is the APEX. Verified against production: www.batch0.org
// 308s to batch0.org, and the apex serves 200 with
// <link rel="canonical" href="https://batch0.org">.
//
// This comment used to say the reverse ("canonical host is www — the apex 307s
// there"), which was wrong in the most dangerous available direction: anyone
// trusting it would "fix" BASE to www and hand every crawler in the sitemap a
// redirecting URL, which is exactly the thing the comment warns against.
// The value was always right; only the note above it was wrong.
const BASE = "https://batch0.org";

// Static marketing routes. Auth/product routes (/dashboard, /apply, /admin,
// /mentor, /investor) are deliberately omitted — they're gated and shouldn't
// show up in search.
//
// `lastModified` is a real crawl signal (Google + AI crawlers use it to spot
// fresh content); `priority`/`changeFrequency` are ignored by Google, so blog
// entries carry only accurate lastmod dates from each post's frontmatter.
// Hourly, like /blog. Publishing regenerates it at once (revalidatePath in the
// admin blog actions); this is for a build that couldn't reach the database,
// which lists the committed posts only (lib/blog.ts, OnBlogDbFailure) and
// would otherwise keep that list until the next deploy.
export const revalidate = 3600;

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const now = new Date();
  const posts = await getAllPostsMeta();

  // Blog index freshness tracks the most recently updated post.
  const blogLastMod = posts.length
    ? new Date(`${posts[0].updated}T12:00:00Z`)
    : now;

  const marketing: MetadataRoute.Sitemap = [
    { url: `${BASE}/`, lastModified: now, changeFrequency: "weekly", priority: 1 },
    { url: `${BASE}/program`, lastModified: now, changeFrequency: "monthly", priority: 0.9 },
    { url: `${BASE}/parents`, lastModified: now, changeFrequency: "weekly", priority: 0.9 },
    { url: `${BASE}/sample-lesson`, lastModified: new Date("2026-09-20T12:00:00Z"), changeFrequency: "monthly", priority: 0.8 },
    { url: `${BASE}/start`, lastModified: new Date("2026-09-14T12:00:00Z"), changeFrequency: "monthly", priority: 0.8 },
    { url: `${BASE}/blog`, lastModified: blogLastMod, changeFrequency: "weekly", priority: 0.8 },
    { url: `${BASE}/sponsors`, lastModified: now, changeFrequency: "monthly", priority: 0.7 },
    { url: `${BASE}/terms`, lastModified: now, changeFrequency: "yearly", priority: 0.3 },
    { url: `${BASE}/privacy`, lastModified: now, changeFrequency: "yearly", priority: 0.3 },
    { url: `${BASE}/refund-policy`, lastModified: now, changeFrequency: "yearly", priority: 0.3 },
    { url: `${BASE}/community-guidelines`, lastModified: now, changeFrequency: "yearly", priority: 0.3 },
    { url: `${BASE}/texts`, lastModified: now, changeFrequency: "yearly", priority: 0.3 },
    // The support form. Listed because every policy above now points at it as
    // the way to exercise something the policy grants, so a crawler that has
    // the policy should be able to reach the remedy. The tokenized threads at
    // /support/t/* are deliberately absent and are disallowed in app/robots.ts.
    { url: `${BASE}/support`, lastModified: now, changeFrequency: "yearly", priority: 0.4 },
  ];

  const blogPosts: MetadataRoute.Sitemap = posts.map((p) => ({
    url: `${BASE}/blog/${p.slug}`,
    lastModified: new Date(`${p.updated}T12:00:00Z`),
    changeFrequency: "monthly",
    priority: 0.6,
  }));

  // Category hubs. Each one's freshness tracks the newest post inside it, so
  // a crawler recrawls a hub when its cluster actually changes rather than on
  // a fixed guess. Ranked above individual posts: a hub is the URL we want
  // competing for the broad head term ("startup pitch guide for students"),
  // with the posts under it competing for the long tail.
  const categories: MetadataRoute.Sitemap = CATEGORIES.map((category) => {
    const newest = posts.find((p) => p.category === category);
    return {
      url: `${BASE}${categoryPath(category)}`,
      lastModified: newest ? new Date(`${newest.updated}T12:00:00Z`) : now,
      changeFrequency: "weekly" as const,
      priority: 0.7,
    };
  });

  return [...marketing, ...categories, ...blogPosts];
}
