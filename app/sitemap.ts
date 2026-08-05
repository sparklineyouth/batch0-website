import type { MetadataRoute } from "next";
import { getAllPostsMeta } from "@/lib/blog";
import { CATEGORIES, categoryPath } from "@/lib/blog-shared";

// Canonical host is www — the apex 307s there, so the sitemap must not
// hand crawlers redirecting URLs.
const BASE = "https://batch0.org";

// Static marketing routes. Auth/product routes (/dashboard, /apply, /admin,
// /mentor, /investor) are deliberately omitted — they're gated and shouldn't
// show up in search.
//
// `lastModified` is a real crawl signal (Google + AI crawlers use it to spot
// fresh content); `priority`/`changeFrequency` are ignored by Google, so blog
// entries carry only accurate lastmod dates from each post's frontmatter.
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
    { url: `${BASE}/blog`, lastModified: blogLastMod, changeFrequency: "weekly", priority: 0.8 },
    { url: `${BASE}/sponsors`, lastModified: now, changeFrequency: "monthly", priority: 0.7 },
    { url: `${BASE}/terms`, lastModified: now, changeFrequency: "yearly", priority: 0.3 },
    { url: `${BASE}/privacy`, lastModified: now, changeFrequency: "yearly", priority: 0.3 },
    { url: `${BASE}/refund-policy`, lastModified: now, changeFrequency: "yearly", priority: 0.3 },
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
