import "server-only";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkSmartypants from "remark-smartypants";
import remarkRehype from "remark-rehype";
import rehypeSlug from "rehype-slug";
import rehypeAutolinkHeadings from "rehype-autolink-headings";
import rehypeExternalLinks from "rehype-external-links";
import rehypeStringify from "rehype-stringify";

/**
 * The markdown → semantic-HTML pipeline, on its own so callers can render a
 * string without dragging the blog in behind it.
 *
 * This used to live in lib/blog.ts, which also pulls node:fs, gray-matter and
 * @supabase/supabase-js to read 137 committed posts and the blog_posts table.
 * Anything that wanted to turn a markdown string into HTML — the flow pages
 * under /dashboard/resources, the admin editor's preview — imported all of
 * that too, so a student loading a resource flow paid for the blog's entire
 * dependency graph in that route's server bundle. Nothing outside the blog
 * needs the blog; it only ever needed these nine plugins.
 *
 * lib/blog.ts re-exports renderMarkdown, so the two stay the same pipeline and
 * a DB post, a file post and a flow body all render identically.
 *
 * Heading anchors (slug + self-link) give AI engines and readers stable deep
 * links; smartypants gives real typographic punctuation; external links get
 * rel safety.
 */
const processor = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkSmartypants)
  .use(remarkRehype)
  .use(rehypeSlug)
  .use(rehypeAutolinkHeadings, {
    behavior: "wrap",
    properties: { className: ["heading-anchor"] },
  })
  .use(rehypeExternalLinks, {
    target: "_blank",
    rel: ["noopener", "noreferrer"],
  })
  .use(rehypeStringify);

export async function renderMarkdown(body: string): Promise<string> {
  const file = await processor.process(body);
  return String(file);
}
