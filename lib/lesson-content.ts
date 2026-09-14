import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkRehype from "remark-rehype";
import rehypeSanitize from "rehype-sanitize";
import rehypeExternalLinks from "rehype-external-links";
import rehypeStringify from "rehype-stringify";

// Lessons may be edited by staff or an MCP client. Render their teaching
// material as Markdown, while dropping raw HTML and unsafe link protocols.
const processor = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkRehype)
  .use(rehypeSanitize)
  .use(rehypeExternalLinks, { target: "_blank", rel: ["noopener", "noreferrer"] })
  .use(rehypeStringify);

export async function renderLessonMarkdown(body: string): Promise<string> {
  return String(await processor.process(body));
}
