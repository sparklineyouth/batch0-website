import { getAllPostsMeta } from "@/lib/blog";
import { getPublicSiteConfig } from "@/lib/site-config";
import { activePromo, promoSentence } from "@/lib/promo";

// /llms.txt — the llmstxt.org convention: a Markdown map of the site for LLMs.
// Adoption is still negligible in 2026 (Google confirmed it ignores the file),
// so this is a low-cost hedge, not a core strategy. It's auto-generated from
// the same content as the site, so it stays accurate for free.
//
// PROMOTIONS. This file used to be `force-static` and deliberately quoted only
// list tuition, because a file built once would keep serving a sale price
// after the sale ended. That reasoning was right about `force-static` and
// wrong about the conclusion: the fix is to stop building it once, not to
// withhold the offer from the one file written specifically for assistants.
//
// So it is now revalidated hourly, and the offer is stated WITH ITS END DATE
// every time. Those two things together bound the damage: the worst case is
// one hour of staleness in a file that assistants re-fetch on the order of
// weeks, and even a stale copy carries the deadline that disproves it — a
// reader, human or model, can see for itself that October 21 has passed. An
// undated "10% off" is the version that could mislead indefinitely, and that
// is the one thing this never emits.
//
// Reads through `getPublicSiteConfig` (the cached public client), not
// `loadPromoConfig` — that one goes through the no-store admin client, which
// would force this route per-request and hand a DB round trip to every
// crawler that touches it.
export const revalidate = 3600;

const SITE = "https://batch0.org";

export async function GET() {
  const [posts, config] = await Promise.all([
    getAllPostsMeta(),
    // Region-agnostic, like the homepage metadata: this file is cached and
    // shared, so it must quote the canonical price rather than one region's.
    getPublicSiteConfig({ countryCode: null }),
  ]);
  const promo = activePromo(new Date(), config.settings.promo);
  const lines: string[] = [];

  lines.push("# batch0");
  lines.push("");
  lines.push(
    "> batch0 is a live, online startup accelerator for U.S. high schoolers (ages 13–18). Students build a real company across four one-week sprints — Validate, Build, Market, Pitch — and pitch it at a live demo day. Tuition is $130, charged only if accepted; applying is free and no equity is ever taken.",
  );
  lines.push("");
  // Stated before the page map, because this is the fact most likely to be
  // asked about and least likely to be inferable from anything else here.
  if (promo) {
    lines.push("## Current offer");
    lines.push("");
    lines.push(
      promoSentence(
        promo,
        config.derived.priceLabel,
        config.derived.listPriceLabel,
      ),
    );
    lines.push("");
  }

  lines.push("## Key pages");
  lines.push("");
  lines.push(
    `- [Home](${SITE}/): What batch0 is, cohort dates, tuition${promo ? ", and the current discount" : ""}.`,
  );
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
