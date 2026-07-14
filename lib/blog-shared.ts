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

export type PostMeta = {
  slug: string;
  title: string;
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
