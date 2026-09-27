import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkSmartypants from "remark-smartypants";
import remarkRehype from "remark-rehype";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import rehypeSlug from "rehype-slug";
import rehypeAutolinkHeadings from "rehype-autolink-headings";
import rehypeExternalLinks from "rehype-external-links";
import rehypeStringify from "rehype-stringify";

// Kept apart from lib/markdown.ts (which is `server-only`, and whose output
// the blog depends on) so the sanitizing pipeline is unit-testable and can't
// change the blog's HTML. See lib/markdown-safe.test.ts.
/**
 * Markdown from people who aren't developers, rendered for the public.
 *
 * Challenge descriptions and rules are written in the admin editor by anyone
 * holding `challenges.manage` — which includes roles that are deliberately
 * NOT full admins — and shown to signed-out visitors, most of them minors, via
 * dangerouslySetInnerHTML. remark-rehype already drops raw HTML, but it passes
 * link URLs through untouched, so `[Claim](javascript:…)` would become a live
 * script link on batch0.org. rehype-sanitize's default schema allows only
 * http/https/mailto (and friends) in href/src, so that is removed here.
 *
 * Order matters: sanitize runs straight after remark-rehype and BEFORE the
 * slug / autolink / external-link plugins, so the ids, the heading-anchor
 * class and rel/target they add aren't stripped. `clobberPrefix: ""` because
 * with raw HTML dropped an author has no way to set an id themselves.
 *
 * Also turns single newlines into line breaks (what remark-breaks does):
 * descriptions written before markdown was supported are plain text, and
 * collapsing their line breaks turned lists of dates and prizes into one
 * run-on paragraph.
 */
const safeProcessor = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkSmartypants)
  .use(softBreaksToHardBreaks)
  .use(remarkRehype)
  .use(rehypeSanitize, { ...defaultSchema, clobberPrefix: "" })
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

export async function renderSafeMarkdown(body: string): Promise<string> {
  const file = await safeProcessor.process(body);
  return String(file);
}

/**
 * mdast plugin: every "\n" inside a text node (a soft line break) becomes a
 * `break` node, i.e. a <br>. Code blocks are `code` nodes, not text, so they
 * are untouched.
 */
function softBreaksToHardBreaks() {
  return (tree: any) => {
    const walk = (node: any) => {
      if (!node || !Array.isArray(node.children)) return;
      const next: any[] = [];
      for (const child of node.children) {
        if (child.type === "text" && typeof child.value === "string" && child.value.includes("\n")) {
          const parts = child.value.split("\n");
          parts.forEach((part: string, i: number) => {
            if (i > 0) next.push({ type: "break" });
            if (part) next.push({ type: "text", value: part });
          });
        } else {
          walk(child);
          next.push(child);
        }
      }
      node.children = next;
    };
    walk(tree);
  };
}
