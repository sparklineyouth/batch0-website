// Client-safe blog constants, types, and helpers. This module has NO
// `server-only` guard and touches no Node APIs, so it can be imported from
// client components (e.g. the admin editor) AND from the server-only
// `lib/blog.ts`. Keep the canonical author roster + category list here so the
// admin form and the render pipeline can never drift.

// The canonical author roster. Posts reference an author by key; everything
// else (display name, role, profile URL) is derived here so bylines and the
// JSON-LD `author` node can never drift from each other.
export type AuthorKey = "rishabh" | "taran" | "team";

export const AUTHORS: Record<
  AuthorKey,
  { name: string; role: string; url: string }
> = {
  rishabh: {
    name: "Rishabh Dagli",
    role: "Co-founder, batch0",
    url: "https://batch0.org/#who-runs-this",
  },
  taran: {
    name: "Taran Bethi",
    role: "Co-founder, batch0",
    url: "https://batch0.org/#who-runs-this",
  },
  team: {
    name: "The batch0 Team",
    role: "batch0",
    url: "https://batch0.org/#who-runs-this",
  },
};

export const AUTHOR_KEYS = Object.keys(AUTHORS) as AuthorKey[];

// The four build sprints double as the blog's topical spine, plus two
// evergreen buckets. Keeping categories fixed (not free-form tags) gives the
// site clean hub pages and consistent internal linking — both ranking signals.
export const CATEGORIES = [
  "Validate",
  "Build",
  "Market",
  "Pitch",
  "Founders",
  "Playbook",
] as const;
export type Category = (typeof CATEGORIES)[number];

/** "Validate" → "validate". URL-safe, lowercase, stable. */
export function categorySlug(category: Category | string): string {
  return String(category).toLowerCase().replace(/[^a-z0-9]+/g, "-");
}

/** "Validate" → "/blog/category/validate". */
export function categoryPath(category: Category | string): string {
  return `/blog/category/${categorySlug(category)}`;
}

export function categoryFromSlug(slug: string): Category | null {
  return (
    CATEGORIES.find((c) => categorySlug(c) === slug.toLowerCase()) ?? null
  );
}

/**
 * Copy for each category hub. These pages exist so the 135 posts form six
 * explicit topic clusters instead of one flat list: a hub page gives Google a
 * single strong URL per theme, and gives every post in the cluster a link
 * back to it. Descriptions are kept inside the meta-description budget.
 */
export const CATEGORY_COPY: Record<
  Category,
  { heading: string; blurb: string; description: string }
> = {
  Validate: {
    heading: "Validating a startup idea",
    blurb:
      "Before you build anything, find out whether anyone actually wants it. Customer interviews, fake door tests, and the signals that tell you to keep going or stop.",
    description:
      "How to validate a startup idea as a high schooler: customer interviews, fake door tests, surveys that work, and telling a real signal from a polite one.",
  },
  Build: {
    heading: "Building your first product",
    blurb:
      "Ship something real. No-code tools, MVPs, pricing, and the decisions that matter when you're building your first product with no budget and no team.",
    description:
      "How to build your first product as a student founder: no-code MVPs, AI tools, pricing, payments under 18, and what to build next versus what to cut.",
  },
  Market: {
    heading: "Getting your first users",
    blurb:
      "Nobody finds you by accident. Distribution channels, cold outreach, launches, and how to get the first hundred people to care.",
    description:
      "How student founders get their first users: Reddit, Discord, TikTok, Product Hunt, cold email and DMs, waitlists, and picking one channel over ten.",
  },
  Pitch: {
    heading: "Pitching and demo day",
    blurb:
      "The deck, the story, and the delivery. How judges actually score you, and how to sound like you know what you're talking about.",
    description:
      "How to pitch as a high school founder: deck structure, slide order, market size, the traction slide with no revenue, and how judges actually score you.",
  },
  Founders: {
    heading: "Life as a teen founder",
    blurb:
      "School, parents, co-founders, money, and the parts nobody warns you about. The non-product problems that decide whether you keep going.",
    description:
      "The non-product side of being a teen founder: co-founders, parents, school balance, taxes and LLCs, burnout, and knowing when to quit or push.",
  },
  Playbook: {
    heading: "Programs, competitions and funding",
    blurb:
      "Accelerators, pitch competitions, grants and scholarships. What's worth your time, what's a waste of money, and how to actually get in.",
    description:
      "Startup programs, competitions, grants and scholarships for high schoolers: which are worth your time and money, and how to get accepted.",
  },
};

export type PostMeta = {
  slug: string;
  title: string;
  /**
   * Optional short title for the `<title>` tag only. Set this when `title`
   * is over ~50 characters, so the headline can stay long and specific while
   * the search result stays inside Google's ~60-character render budget.
   * Never shown on the page — the `<h1>` always uses `title`.
   */
  seoTitle?: string;
  description: string;
  date: string; // ISO datePublished (YYYY-MM-DD)
  updated: string; // ISO dateModified (defaults to date)
  category: Category;
  tags: string[];
  author: { key: AuthorKey } & (typeof AUTHORS)[AuthorKey];
  excerpt: string;
  featured: boolean;
  readingTime: number; // minutes
  /** Where the post lives. "file" = committed markdown (read-only in the
   *  admin UI); "db" = authored in the admin panel (editable). */
  source: "file" | "db";
};

export type Post = {
  meta: PostMeta;
  html: string;
};

// 225 wpm is the common reading-speed estimate for adult non-fiction.
export function readingTimeFor(body: string): number {
  const words = body.trim().split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.round(words / 225));
}

// URL-safe slug from a title. Mirrors the kebab-case slugs used by the
// file-based posts so admin-authored posts sit in the same namespace.
export function slugify(input: string): string {
  return input
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // strip accents
    .replace(/['"’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-")
    .slice(0, 80);
}

export function isCategory(value: string): value is Category {
  return (CATEGORIES as readonly string[]).includes(value);
}

export function isAuthorKey(value: string): value is AuthorKey {
  return value in AUTHORS;
}

export function formatPostDate(iso: string): string {
  // Parse as UTC noon to avoid TZ rollover shifting the displayed day.
  const d = new Date(`${iso}T12:00:00Z`);
  return d.toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });
}
