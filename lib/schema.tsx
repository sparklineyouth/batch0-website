import React from "react";

/**
 * Shared structured-data (JSON-LD) primitives.
 *
 * One module so every page emits the *same* node for the same thing.
 * schema.org lets nodes cross-reference by `@id`, and search engines merge
 * them into a single knowledge-graph entity only when those ids match
 * exactly. Re-declaring the organization inline on each page instead lets
 * the copies drift, which is how a knowledge panel ends up with two
 * half-populated "batch0" entities instead of one complete one.
 *
 * Facts policy is the same as the rest of the site: nothing here is
 * invented. Every value is either verifiable on a public page or read from
 * the cohort record at request time. Unknowns are omitted rather than
 * guessed — see docs/audit/NEEDED_FACTS.md.
 */

// The site serves from the apex; batchzero.org and the legacy
// sparklineyouth.org both redirect here, so every `@id` and `url` below has
// to use this host or the graph fragments won't merge.
export const SITE = "https://batch0.org";

// Stable node ids. These are fragment URIs, not routes — they exist so that
// `{ "@id": ORG_ID }` anywhere on the site points at the one org node
// defined in the root layout.
export const ORG_ID = `${SITE}/#organization`;
export const WEBSITE_ID = `${SITE}/#website`;
export const RISHABH_ID = `${SITE}/#person-rishabh-dagli`;
export const SHRESHT_ID = `${SITE}/#person-shresht-chopra`;

/**
 * Renders one JSON-LD block.
 *
 * Every call site passes a literal built in this repo from repo-authored
 * copy or the cohort record — no user input is interpolated, which is what
 * makes `dangerouslySetInnerHTML` safe here. `<` is still escaped: a stray
 * `</script>` inside any string value would otherwise close the tag early
 * and dump the rest of the payload into the document as markup.
 */
export function JsonLd({ data }: { data: Record<string, unknown> }) {
  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{
        __html: JSON.stringify(data).replace(/</g, "\\u003c"),
      }}
    />
  );
}

/**
 * The two founders, as Person nodes.
 *
 * Names, roles, and the profile anchor are all on the public "Who runs
 * this" section, and the same names carry every blog byline via
 * lib/blog-shared.ts. Google weights named, connected people heavily for
 * E-E-A-T on an education site, so these are worth declaring even though
 * they're sparse.
 *
 * `sameAs` is deliberately absent. No official public profiles have been
 * supplied yet (NEEDED_FACTS.md #11, and the footer carries the matching
 * TODO), and `sameAs` is a factual assertion that a given account *is* this
 * person — a guessed handle either misattributes a stranger's account or
 * points nowhere, both of which are worse for the entity than saying
 * nothing. Add them here, in one place, once the real handles exist.
 */
export const FOUNDERS = [
  {
    "@type": "Person",
    "@id": RISHABH_ID,
    name: "Rishabh Dagli",
    jobTitle: "Co-Founder",
    url: `${SITE}/#who-runs-this`,
    worksFor: { "@id": ORG_ID },
  },
  {
    "@type": "Person",
    "@id": SHRESHT_ID,
    name: "Shresht Chopra",
    jobTitle: "Co-Founder",
    url: `${SITE}/#who-runs-this`,
    worksFor: { "@id": ORG_ID },
  },
];

/** The audience every public surface describes, per /terms. */
export const STUDENT_AUDIENCE = {
  "@type": "EducationalAudience",
  educationalRole: "student",
  audienceType: "U.S. high school students, ages 13–18",
};

/**
 * Breadcrumb trail builder. Home is prepended automatically, so a page
 * passes only its own segments.
 */
export function breadcrumbJsonLd(
  trail: { name: string; path: string }[],
): Record<string, unknown> {
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "Home", item: SITE },
      ...trail.map((t, i) => ({
        "@type": "ListItem",
        position: i + 2,
        name: t.name,
        item: `${SITE}${t.path}`,
      })),
    ],
  };
}

/**
 * A plain WebPage node, tied back to the site and org.
 *
 * Worth emitting on pages that have no richer type of their own (sponsors,
 * the legal set): it gives the URL a named entity in the graph and an
 * explicit publisher, rather than leaving crawlers to infer both.
 */
export function webPageJsonLd({
  path,
  name,
  description,
  type = "WebPage",
  dateModified,
}: {
  path: string;
  name: string;
  description: string;
  /** Narrower page type where one fits, e.g. "AboutPage" for the legal set. */
  type?: string;
  /** ISO date. Only pass it where the page states a "Last updated" line. */
  dateModified?: string;
}): Record<string, unknown> {
  return {
    "@context": "https://schema.org",
    "@type": type,
    "@id": `${SITE}${path}`,
    url: `${SITE}${path}`,
    name,
    description,
    isPartOf: { "@id": WEBSITE_ID },
    publisher: { "@id": ORG_ID },
    inLanguage: "en-US",
    ...(dateModified ? { dateModified } : {}),
  };
}
