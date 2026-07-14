import type { MetadataRoute } from "next";

// Crawl policy (documented decision — see docs/audit/DECISIONS.md D9):
//
// 1. Search crawlers: allowed everywhere except gated app areas.
// 2. AI crawlers: ALLOWED — deliberately, and explicitly enumerated below.
//    Teens ask ChatGPT/Claude/Perplexity "best startup programs for high
//    schoolers"; being invisible there costs real applicants. The `*` rule
//    already covers every bot, but the explicit allow-list makes the intent
//    self-documenting AND signals it per-agent.
//
//    The ones that actually earn citations are the AI *retrieval / search*
//    bots (they build the indexes AI answers cite) and the user-triggered
//    fetchers — not the training crawlers:
//      · OpenAI:    OAI-SearchBot (ChatGPT Search index), ChatGPT-User (fetch)
//      · Anthropic: Claude-SearchBot (search index), Claude-User (fetch)
//      · Perplexity: PerplexityBot (index), Perplexity-User (fetch)
//      · Bing (Bingbot) is a hidden lever — ChatGPT Search retrieval rides
//        the Bing index, so allowing Bingbot directly helps ChatGPT citations.
//      · Apple / DuckDuckGo / Google-Extended round out AI-answer surfaces.
//    Training crawlers (GPTBot, ClaudeBot, CCBot, Google-Extended, …) are
//    allowed too — for a mission-driven program, max reach is the goal.
//
// 3. Gated areas (/dashboard, /admin, /apply, ...) are disallowed: they are
//    auth redirects with no crawlable content. The public story lives on /,
//    /program, /sponsors, and /blog — all crawlable.
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

  // Every agent gets the same policy: crawl the public site, skip the gated
  // app. Listing them explicitly is intentional documentation.
  const agents = [
    "*",
    // Search engines
    "Googlebot",
    "Bingbot",
    "Applebot",
    // AI search / retrieval (these drive AI-answer citations)
    "OAI-SearchBot",
    "Claude-SearchBot",
    "PerplexityBot",
    "DuckAssistBot",
    // AI user-triggered fetchers (on-demand when someone asks the assistant)
    "ChatGPT-User",
    "Claude-User",
    "Perplexity-User",
    "Meta-ExternalFetcher",
    // AI training crawlers + training opt-out tokens (allowed for reach)
    "GPTBot",
    "ClaudeBot",
    "anthropic-ai",
    "Google-Extended",
    "Applebot-Extended",
    "CCBot",
    "Amazonbot",
  ];

  return {
    rules: agents.map((userAgent) => ({ userAgent, allow: "/", disallow })),
    sitemap: "https://batch0.org/sitemap.xml",
    host: "https://batch0.org",
  };
}
