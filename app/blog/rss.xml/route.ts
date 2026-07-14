import { getAllPostsMeta, formatPostDate } from "@/lib/blog";

// RSS 2.0 feed for the blog. Still worth publishing in 2026: it aids feed
// readers, content-discovery services, and AI ingestion pipelines, and the
// URL can be submitted as a secondary sitemap. Regenerated from the same
// frontmatter the pages use, so it can't drift.
export const dynamic = "force-static";

const SITE = "https://batch0.org";
const FEED_URL = `${SITE}/blog/rss.xml`;

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function rfc822(iso: string): string {
  return new Date(`${iso}T12:00:00Z`).toUTCString();
}

export async function GET() {
  const posts = await getAllPostsMeta();
  const lastBuild = posts.length ? rfc822(posts[0].updated) : new Date().toUTCString();

  const items = posts
    .map((p) => {
      const link = `${SITE}/blog/${p.slug}`;
      return `    <item>
      <title>${escapeXml(p.title)}</title>
      <link>${link}</link>
      <guid isPermaLink="true">${link}</guid>
      <pubDate>${rfc822(p.date)}</pubDate>
      <category>${escapeXml(p.category)}</category>
      <dc:creator>${escapeXml(p.author.name)}</dc:creator>
      <description>${escapeXml(p.description)}</description>
    </item>`;
    })
    .join("\n");

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel>
    <title>batch0 Blog</title>
    <link>${SITE}/blog</link>
    <description>Guides and essays on building a startup as a high schooler — from idea validation to demo day.</description>
    <language>en-us</language>
    <atom:link href="${FEED_URL}" rel="self" type="application/rss+xml" />
    <lastBuildDate>${lastBuild}</lastBuildDate>
${items}
  </channel>
</rss>`;

  return new Response(xml, {
    headers: {
      "Content-Type": "application/rss+xml; charset=utf-8",
      "Cache-Control": "public, max-age=3600, s-maxage=3600",
    },
  });
}
