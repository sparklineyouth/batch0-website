/**
 * Search-snippet copy, as pure functions.
 *
 * This module has ZERO imports on purpose. The strings it produces are the
 * highest-stakes copy on the site — a wrong meta description told Google for
 * weeks that Cohort 1 ran "Jul 30–Sep 13" while the page body said Sep 14,
 * i.e. it advertised a cohort that had already ended to every student who
 * searched for us. Keeping this logic free of Next.js, Supabase and module
 * aliases means it can be unit-tested directly with `node --test`, with no
 * build step and no mocking. See lib/seo-meta.test.ts.
 *
 * lib/site-config.ts is the only consumer; it adapts the live cohort record
 * onto these primitives.
 */

/**
 * Google truncates the description around 155–160 characters on desktop and
 * shorter on mobile. We budget to 155 so the closing clause — the part that
 * says "free to apply, no equity taken", which is the actual objection
 * handler — survives the cut.
 */
export const META_DESCRIPTION_MAX = 155;

/**
 * Google renders roughly 600px of title text, which works out to about 60
 * characters. Past that it truncates with an ellipsis.
 */
export const TITLE_TAG_MAX = 60;

/** Appended to blog titles when there's room for it. */
export const BRAND_SUFFIX = " — batch0";

/**
 * The `<title>` for a blog post.
 *
 * Blog titles were unconditionally suffixed with " — batch0", which pushed 58
 * of 135 posts past the 60-character limit. The irony: the truncation ate the
 * suffix, so the posts that "needed" the branding hardest were exactly the
 * ones where it never rendered — and several lost words from the headline too.
 *
 * So the suffix is now conditional. Dropping it costs nothing: the site ships
 * a `WebSite` node with `name: "batch0"` in the root layout, and Google
 * derives the site name for search results from that, not from the title tag.
 *
 * `seoTitle` is an optional frontmatter override for the handful of posts
 * whose headline is over budget on its own. It lets the on-page `<h1>` stay
 * long and specific while the title tag stays short — they serve different
 * readers and there's no reason to force them to match.
 */
export function blogTitleTag(title: string, seoTitle?: string | null): string {
  const base = (seoTitle?.trim() || title).trim();
  const branded = `${base}${BRAND_SUFFIX}`;
  return branded.length <= TITLE_TAG_MAX ? branded : base;
}

/**
 * Score how topically related two posts are, for internal linking.
 *
 * Internal links are the one ranking lever entirely inside our control: they
 * route authority between pages and tell Google which posts form a topic
 * cluster. The previous implementation — "same category, then most recent" —
 * threw that away. With 20–24 posts per category it linked the same three
 * recent posts from all ~23 siblings, so a handful of arbitrary posts absorbed
 * every internal link and genuinely related posts never connected. Nine posts
 * about pitch decks sat in the same category without one link between them.
 *
 * Signals, in descending weight:
 *   - shared tags       — the strongest explicit topical signal we have
 *   - shared title terms — catches clusters the tags missed. 45 of 135 posts
 *                          have no tag in common with any other post, so tags
 *                          alone would leave a third of the catalogue orphaned.
 *   - same category     — a weak tiebreaker, not a primary signal
 *
 * Deterministic: no dates, no randomness. The same inputs always produce the
 * same links, so a rebuild can't silently reshuffle the internal link graph.
 */
const TITLE_STOPWORDS = new Set([
  "a","an","the","and","or","but","if","then","than","that","this","these","those",
  "to","of","in","on","at","for","from","with","without","by","as","is","are","was",
  "were","be","been","being","do","does","did","doing","how","what","when","where",
  "why","who","which","your","you","yours","my","our","it","its","not","no","so",
  "can","will","should","would","could","actually","really","just","get","got",
  "make","makes","made","first","one","about","into","out","up","down","over",
  "more","most","some","any","every","all","own","same","too","very","s","t",
]);

export function titleTerms(title: string): Set<string> {
  return new Set(
    title
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, " ")
      .split(/[\s-]+/)
      .filter((w) => w.length > 2 && !TITLE_STOPWORDS.has(w)),
  );
}

export type RelatednessInput = {
  slug: string;
  title: string;
  category: string;
  tags: string[];
};

export function relatednessScore(
  a: RelatednessInput,
  b: RelatednessInput,
): number {
  if (a.slug === b.slug) return -1;

  const aTags = new Set(a.tags.map((t) => t.toLowerCase().trim()));
  const sharedTags = b.tags.filter((t) => aTags.has(t.toLowerCase().trim())).length;

  const aTerms = titleTerms(a.title);
  const sharedTerms = [...titleTerms(b.title)].filter((t) => aTerms.has(t)).length;

  const sameCategory = a.category === b.category ? 1 : 0;

  return sharedTags * 10 + sharedTerms * 3 + sameCategory;
}

/**
 * Pick the `limit` most related posts.
 *
 * Ties break on slug rather than date so the link graph is stable across
 * builds — a post that publishes today shouldn't quietly rewire the internal
 * links of fifty older posts.
 */
export function pickRelated<T extends RelatednessInput>(
  current: RelatednessInput,
  candidates: readonly T[],
  limit = 3,
): T[] {
  return candidates
    .filter((c) => c.slug !== current.slug)
    .map((c) => ({ post: c, score: relatednessScore(current, c) }))
    .sort((x, y) =>
      y.score !== x.score
        ? y.score - x.score
        : x.post.slug.localeCompare(y.post.slug),
    )
    .slice(0, limit)
    .map((x) => x.post);
}

/**
 * "Sep 14 – Nov 13, 2026".
 *
 * Distinct from the "→" range used in the on-page stat block: an arrow glyph
 * in a search result reads as an encoding error, and a snippet has no visual
 * context to make it obvious it's a date range. Ranges that cross a year
 * boundary carry the year on both ends.
 *
 * Dates are parsed as UTC midnight so a "2026-09-14" string can't slide a day
 * backwards when the server happens to run west of Greenwich.
 */
export function formatDateSentence(
  startsOn: string | null,
  endsOn: string | null,
  opts: { year?: boolean } = {},
): string {
  if (!startsOn || !endsOn) return "";
  const start = new Date(`${startsOn}T00:00:00Z`);
  const end = new Date(`${endsOn}T00:00:00Z`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return "";

  const fmt = (d: Date, withYear: boolean) =>
    d.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      ...(withYear ? { year: "numeric" as const } : {}),
      timeZone: "UTC",
    });

  const sameYear = start.getUTCFullYear() === end.getUTCFullYear();
  // A range that straddles New Year is ambiguous without both years, so the
  // `year: false` request is only honoured when the span sits inside one year.
  if (!sameYear) return `${fmt(start, true)} – ${fmt(end, true)}`;
  const withYear = opts.year ?? true;
  return `${fmt(start, false)} – ${fmt(end, withYear)}`;
}

/** "Sep 10" — the application deadline, short form. "" when unset/invalid. */
export function formatApplyBy(applicationsCloseAt: string | null): string {
  if (!applicationsCloseAt) return "";
  const d = new Date(applicationsCloseAt);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

export type MetaDescriptionInput = {
  /** "Cohort 1", or "" when the cohort has no number. */
  cohortLabel: string;
  /** ISO date the cohort starts, e.g. "2026-09-14". */
  startsOn: string | null;
  /** ISO date the cohort ends, e.g. "2026-11-13". */
  endsOn: string | null;
  /** ISO timestamp the application window closes, or null. */
  applicationsCloseAt: string | null;
  /** "$130" — the base, non-regional price. */
  basePriceLabel: string;
  /** Injectable for tests. */
  now?: Date;
};

/**
 * Build the marketing meta description from live cohort facts.
 *
 * Three rules, each of which exists because of a real failure mode:
 *
 *  1. Never advertise a deadline that has passed. Once `applicationsCloseAt`
 *     is behind us the "apply by" clause is dropped rather than shown — a
 *     snippet reading "apply by Sep 10" on Sep 11 costs us the click AND the
 *     credibility.
 *  2. Stay under META_DESCRIPTION_MAX, degrading in a deliberate order (see
 *     the candidate ladder below) rather than letting Google cut mid-word.
 *  3. Say "high schoolers", not "U.S. high schoolers". The FAQ tells students
 *     they can join from anywhere and lib/pricing.ts ships regional tuition,
 *     so the old wording disqualified international applicants in the exact
 *     sentence where they decide whether the program is for them.
 */
export function buildMetaDescription(input: MetaDescriptionInput): string {
  const {
    cohortLabel,
    startsOn,
    endsOn,
    applicationsCloseAt,
    basePriceLabel,
    now = new Date(),
  } = input;

  const base =
    "batch0 is a live, online startup accelerator for high schoolers.";
  const tail = `${basePriceLabel} tuition, free to apply, no equity taken.`;
  const label = cohortLabel || "Next cohort";

  const withYear = formatDateSentence(startsOn, endsOn);
  const noYear = formatDateSentence(startsOn, endsOn, { year: false });

  // Rule 1: a missing close date is treated as closed, not as open-forever.
  // Fail in the direction that understates rather than overpromises.
  const deadlinePassed = applicationsCloseAt
    ? new Date(applicationsCloseAt).getTime() <= now.getTime()
    : true;
  const applyBy = formatApplyBy(applicationsCloseAt);
  const applyClause = !deadlinePassed && applyBy ? `, apply by ${applyBy}` : "";

  // Rule 2: the degradation ladder, richest first.
  //
  // The ordering encodes a judgement call. At the real Cohort 1 values the
  // fully-specified string is 158 characters — three over budget — so
  // something has to go, and the two candidates are the year and the
  // deadline. The deadline wins: "apply by Sep 10" is the clause that makes
  // a student act today, while "2026" is inferable from a result Google is
  // already showing as current. So the year is dropped first.
  const candidates = withYear
    ? [
        `${base} ${label}: ${withYear}${applyClause}. ${tail}`,
        `${base} ${label}: ${noYear}${applyClause}. ${tail}`,
        `${base} ${label}: ${withYear}. ${tail}`,
        `${base} ${label}: ${noYear}. ${tail}`,
        `${base} ${tail}`,
      ]
    : [`${base} ${tail}`];

  for (const candidate of candidates) {
    if (candidate.length <= META_DESCRIPTION_MAX) return candidate;
  }

  // Every candidate blew the budget — only reachable if `basePriceLabel` is
  // pathological. Return the shortest rather than throwing: a long
  // description is a bad snippet, but a throw here would 500 the homepage.
  return candidates[candidates.length - 1];
}
