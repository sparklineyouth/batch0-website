import type { MetadataRoute } from "next";

// Crawl policy (documented decision — see docs/audit/DECISIONS.md D9):
//
// 1. Search crawlers: allowed everywhere except gated app areas.
// 2. AI crawlers (GPTBot, ClaudeBot, PerplexityBot, etc.): ALLOWED —
//    deliberately. Teens ask ChatGPT/Claude/Perplexity "best startup
//    programs for high schoolers"; being invisible there costs real
//    applicants. The explicit rules below make the allowance
//    self-documenting even though `*` already covers them.
// 3. Gated areas (/dashboard, /admin, /apply, ...) are disallowed: they
//    are auth redirects with no crawlable content. The public Apply
//    story lives on / and /program.
export default function robots(): MetadataRoute.Robots {
  const disallow = [
    "/dashboard",
    "/admin",
    "/mentor",
    "/investor",
    "/apply",
    "/auth",
    "/api",
  ];
  return {
    rules: [
      { userAgent: "*", allow: "/", disallow },
      // Explicit, intentional AI-crawler allowance.
      { userAgent: "GPTBot", allow: "/", disallow },
      { userAgent: "ClaudeBot", allow: "/", disallow },
      { userAgent: "PerplexityBot", allow: "/", disallow },
      { userAgent: "Google-Extended", allow: "/", disallow },
    ],
    sitemap: "https://www.sparklineyouth.org/sitemap.xml",
  };
}
