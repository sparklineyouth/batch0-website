import { getAllPostsMeta } from "@/lib/blog";

// /llms.txt — the llmstxt.org convention: a Markdown map of the site for LLMs.
// Adoption is still negligible in 2026 (Google confirmed it ignores the file),
// so this is a low-cost hedge, not a core strategy. It's auto-generated from
// the same content as the site, so it stays accurate for free.
export const dynamic = "force-static";

const SITE = "https://batch0.org";

export async function GET() {
  const posts = await getAllPostsMeta();
  const lines: string[] = [];

  lines.push("# batch0");
  lines.push("");
  lines.push(
    "> batch0 is a live, online startup accelerator for U.S. high schoolers (ages 13–18). Students build a real company across four one-week sprints — Validate, Build, Market, Pitch — and pitch it at a live demo day. Tuition is $130, charged only if accepted; applying is free and no equity is ever taken.",
  );
  lines.push("");
  lines.push("## Key pages");
  lines.push("");
  lines.push(`- [Home](${SITE}/): What batch0 is, cohort dates, tuition.`);
  lines.push(`- [Program](${SITE}/program): The week-by-week accelerator curriculum.`);
  lines.push(`- [Sponsors](${SITE}/sponsors): Fund non-dilutive grants for high-school founders.`);
  lines.push(`- [Blog](${SITE}/blog): Guides and essays for high-school founders.`);
  lines.push("");
  lines.push("## Blog: guides for high-school founders");
  lines.push("");
  for (const p of posts) {
    lines.push(`- [${p.title}](${SITE}/blog/${p.slug}): ${p.description}`);
  }
  lines.push("");

  return new Response(lines.join("\n"), {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "public, max-age=3600, s-maxage=3600",
    },
  });
}
