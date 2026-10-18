import "server-only";
import { cache } from "react";
import fs from "node:fs";
import path from "node:path";
import matter from "gray-matter";
import { renderMarkdown } from "@/lib/markdown";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import {
  AUTHORS,
  CATEGORIES,
  LEGACY_AUTHOR_KEYS,
  type AuthorKey,
  type Category,
  type PostMeta,
  type Post,
  readingTimeFor,
  formatPostDate,
} from "@/lib/blog-shared";
import { pickRelated } from "@/lib/seo-meta";
import { isMissingSchemaError } from "@/lib/schema-ready";

// Hybrid blog. Posts come from two sources, merged into one namespace:
//
//   1. Committed markdown files in content/blog/<slug>.md (the original,
//      SEO-canonical set — statically rendered, no runtime dependency).
//   2. Rows in the Supabase `blog_posts` table, authored live from the admin
//      panel. Vercel's filesystem is read-only at runtime, so admin-created
//      posts can't be written as files — the DB is their home. On publish, the
//      admin action revalidates every blog surface so new posts appear without
//      a redeploy.
//
// Both sources render through the SAME markdown → semantic-HTML pipeline, so a
// DB post and a file post are indistinguishable to Google, AI answer engines,
// and readers. If a slug exists in both, the DB row wins (an admin edit is an
// intentional override).

export const BLOG_DIR = path.join(process.cwd(), "content", "blog");

// Re-export the client-safe constants/types/helpers so existing importers that
// pull them from "@/lib/blog" keep working unchanged.
export {
  AUTHORS,
  CATEGORIES,
  readingTimeFor,
  formatPostDate,
} from "@/lib/blog-shared";
export type {
  AuthorKey,
  Category,
  PostMeta,
  Post,
} from "@/lib/blog-shared";

function assertCategory(value: string, slug: string): Category {
  if ((CATEGORIES as readonly string[]).includes(value)) return value as Category;
  throw new Error(
    `Blog post "${slug}" has unknown category "${value}". Allowed: ${CATEGORIES.join(", ")}`,
  );
}

function assertAuthor(value: string, slug: string): AuthorKey {
  if (value in AUTHORS) return value as AuthorKey;
  // A key that was renamed rather than removed — resolve it instead of
  // throwing, so a post written under the old key keeps rendering.
  const aliased = LEGACY_AUTHOR_KEYS[value];
  if (aliased) return aliased;
  throw new Error(
    `Blog post "${slug}" has unknown author "${value}". Allowed: ${Object.keys(AUTHORS).join(", ")}`,
  );
}

// ---------------------------------------------------------------------------
// File-based posts
// ---------------------------------------------------------------------------

function getFileSlugs(): string[] {
  if (!fs.existsSync(BLOG_DIR)) return [];
  return fs
    .readdirSync(BLOG_DIR)
    .filter((f) => f.endsWith(".md") || f.endsWith(".mdx"))
    .map((f) => f.replace(/\.mdx?$/, ""));
}

// Slugs backed by a committed markdown file. The admin authoring flow blocks
// creating a DB post whose slug collides with one of these, so a file post is
// never silently shadowed.
export function listFileSlugs(): string[] {
  return getFileSlugs();
}

function parseMeta(slug: string, raw: string): { meta: PostMeta; body: string } {
  const { data, content } = matter(raw);
  const date = String(data.date ?? "");
  if (!/^\d{4}-\d{2}-\d{2}/.test(date)) {
    throw new Error(`Blog post "${slug}" is missing a valid ISO \`date\`.`);
  }
  const authorKey = assertAuthor(String(data.author ?? "team"), slug);
  const meta: PostMeta = {
    slug,
    title: String(data.title ?? "").trim(),
    seoTitle: data.seoTitle ? String(data.seoTitle).trim() : undefined,
    description: String(data.description ?? "").trim(),
    date,
    updated: String(data.updated ?? date),
    category: assertCategory(String(data.category ?? "Playbook"), slug),
    tags: Array.isArray(data.tags) ? data.tags.map(String) : [],
    author: { key: authorKey, ...AUTHORS[authorKey] },
    excerpt: String(data.excerpt ?? data.description ?? "").trim(),
    featured: Boolean(data.featured),
    readingTime: readingTimeFor(content),
    source: "file",
  };
  if (!meta.title) throw new Error(`Blog post "${slug}" is missing a title.`);
  if (!meta.description)
    throw new Error(`Blog post "${slug}" is missing a description.`);
  return { meta, body: content };
}

function getFilePostRaw(slug: string): string | null {
  // Guard against path traversal — slug must be a bare filename segment.
  if (!/^[a-z0-9-]+$/i.test(slug)) return null;
  const file = path.join(BLOG_DIR, `${slug}.md`);
  if (!fs.existsSync(file)) return null;
  return fs.readFileSync(file, "utf8");
}

/**
 * Frontmatter for every committed post, parsed once per process.
 *
 * This used to read and gray-matter-parse all 135 files (~1.6 MB) on every
 * call — and `getRelatedPosts` calls it on every single blog request, purely
 * to pick three "keep reading" links. That was the dominant cost on the two
 * worst-scoring pages in production.
 *
 * A module-level cache is safe here in a way it wouldn't be for DB rows: these
 * are files committed to the repo, and the filesystem is read-only at runtime
 * on Vercel. A new post means a new deploy, which means a new process. In dev
 * the cache is skipped so editing a post shows up without a restart.
 */
let fileMetaCache: PostMeta[] | null = null;

function getFilePostsMeta(): PostMeta[] {
  if (fileMetaCache && process.env.NODE_ENV === "production") {
    return fileMetaCache;
  }
  const metas = getFileSlugs().map((slug) => {
    const raw = fs.readFileSync(path.join(BLOG_DIR, `${slug}.md`), "utf8");
    return parseMeta(slug, raw).meta;
  });
  fileMetaCache = metas;
  return metas;
}

// File-post metadata for the admin list (these are read-only in the UI — they
// live in git, not the DB). Newest first.
export function listFilePostsMeta(): PostMeta[] {
  return getFilePostsMeta().sort((a, b) => (a.date < b.date ? 1 : -1));
}

// ---------------------------------------------------------------------------
// DB-based posts (admin-authored)
// ---------------------------------------------------------------------------

export type BlogRow = {
  slug: string;
  title: string;
  description: string;
  excerpt: string | null;
  body: string;
  category: string;
  author_key: string;
  tags: string[] | null;
  featured: boolean;
  status: string;
  published_on: string; // YYYY-MM-DD
  updated_on: string | null; // YYYY-MM-DD
};

function rowToMeta(row: BlogRow): PostMeta {
  const authorKey = assertAuthor(row.author_key, row.slug);
  const description = (row.description ?? "").trim();
  return {
    slug: row.slug,
    title: (row.title ?? "").trim(),
    description,
    date: row.published_on,
    updated: row.updated_on || row.published_on,
    category: assertCategory(row.category, row.slug),
    tags: Array.isArray(row.tags) ? row.tags.map(String) : [],
    author: { key: authorKey, ...AUTHORS[authorKey] },
    excerpt: (row.excerpt || description).trim(),
    featured: Boolean(row.featured),
    readingTime: readingTimeFor(row.body ?? ""),
    source: "db",
  };
}

const BLOG_COLS =
  "slug,title,description,excerpt,body,category,author_key,tags,featured,status,published_on,updated_on";

// Cacheable, cookie-free read client for PUBLIC blog rows. Uses the anon key
// and Next's DEFAULT (cacheable) fetch — not the service-role client, whose
// forced `no-store` would deopt the statically-generated blog routes (sitemap,
// rss.xml, llms.txt) and slow every page. RLS ("blog_posts public read")
// already scopes anon reads to published rows; we also filter by status. The
// admin publish action calls revalidatePath() to bust this cache on change.
function blogReadClient() {
  return createSupabaseClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
}

// ---------------------------------------------------------------------------
// When the DB posts can't be read
// ---------------------------------------------------------------------------

/**
 * What a caller wants when the published DB posts can't be read, for any
 * reason but the table not existing yet (migration not applied — that is
 * simply "no DB posts", silently):
 *
 *   "throw"       The blog's own pages, llms.txt, rss.xml and the sitemap —
 *                 the default. They're cached (ISR, or regenerated on
 *                 revalidatePath), and when a regeneration throws Next keeps
 *                 serving the last good copy and tries again on the next
 *                 request. Returning without the DB posts instead CACHED the
 *                 degraded copy: one Supabase 504 on 2026-10-15 meant /blog
 *                 and its category pages without the admin-written posts, and
 *                 a cached 404 for each of those posts, for up to an hour.
 *   "files-only"  The homepage, which renders per request: a failed read
 *                 costs that one request the DB posts, so it renders the
 *                 committed ones rather than failing the whole page.
 *
 * During `next build` both fall back to the committed posts. A deploy
 * shouldn't fail on a Supabase blip, CI builds with no database at all, and
 * every route that reads DB posts revalidates hourly, so a degraded build
 * heals within the hour.
 */
export type OnBlogDbFailure = "throw" | "files-only";

function isBuildPhase(): boolean {
  // Set by `next build` before it spawns the static-generation workers.
  return process.env.NEXT_PHASE === "phase-production-build";
}

/** A failed read: thrown, or logged and survived — see OnBlogDbFailure. */
function blogDbFailed(why: string, onFailure: OnBlogDbFailure): void {
  const message = `[blog] failed to load DB posts: ${why}`;
  if (onFailure === "files-only" || isBuildPhase()) {
    console.error(message);
    return;
  }
  throw new Error(message);
}

/** No database configured (a CI build): nothing to read, not a failure. */
function blogDbConfigured(): boolean {
  return !!process.env.NEXT_PUBLIC_SUPABASE_URL && !!process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
}

type RowsRead = { rows: BlogRow[]; failure: string | null };

function failureOf(error: { message?: string; code?: string } | null | undefined): string | null {
  if (!error) return null;
  // blog_posts not there yet: no DB posts, the file posts carry the blog.
  if (isMissingSchemaError(error)) return null;
  return error.message || error.code || "unknown error";
}

// Fetch published DB posts, once per render. The outcome is cached, not
// thrown, so the callers sharing it can each decide what a failure means.
const readPublishedRows = cache(async function readPublishedRows(): Promise<RowsRead> {
  if (!blogDbConfigured()) return { rows: [], failure: null };
  try {
    const sb = blogReadClient();
    const { data, error } = await sb
      .from("blog_posts")
      .select(BLOG_COLS)
      .eq("status", "published");
    if (error) return { rows: [], failure: failureOf(error) };
    return { rows: (data ?? []) as BlogRow[], failure: null };
  } catch (e) {
    return { rows: [], failure: (e as Error).message || "unknown error" };
  }
});

async function getPublishedRows(onFailure: OnBlogDbFailure): Promise<BlogRow[]> {
  const read = await readPublishedRows();
  if (read.failure) blogDbFailed(read.failure, onFailure);
  return read.rows;
}

async function getPublishedRowBySlug(slug: string): Promise<BlogRow | null> {
  if (!blogDbConfigured()) return null;
  let failure: string | null;
  try {
    const sb = blogReadClient();
    const { data, error } = await sb
      .from("blog_posts")
      .select(BLOG_COLS)
      .eq("slug", slug)
      .eq("status", "published")
      .maybeSingle();
    if (!error) return (data as BlogRow) ?? null;
    failure = failureOf(error);
  } catch (e) {
    failure = (e as Error).message || "unknown error";
  }
  // Only ever read for a post page, which is ISR: a failure must not become
  // a cached notFound() for a post that exists.
  if (failure) blogDbFailed(failure, "throw");
  return null;
}

// ---------------------------------------------------------------------------
// Merged public API
// ---------------------------------------------------------------------------

// Metadata for every published post, newest first. Merges file + DB posts;
// on slug collision the DB row wins.
export const getAllPostsMeta = cache(async function getAllPostsMeta(
  onDbFailure: OnBlogDbFailure = "throw",
): Promise<PostMeta[]> {
  const [rows, fileMetas] = await Promise.all([
    getPublishedRows(onDbFailure),
    Promise.resolve(getFilePostsMeta()),
  ]);
  const bySlug = new Map<string, PostMeta>();
  for (const m of fileMetas) bySlug.set(m.slug, m);
  for (const row of rows) bySlug.set(row.slug, rowToMeta(row)); // DB overrides
  return [...bySlug.values()].sort((a, b) => (a.date < b.date ? 1 : -1));
});

// Every renderable slug (file + published DB). Used by generateStaticParams.
export async function getPostSlugs(): Promise<string[]> {
  const rows = await getPublishedRows("throw");
  return [...new Set([...getFileSlugs(), ...rows.map((r) => r.slug)])];
}

// The markdown → semantic-HTML pipeline now lives in lib/markdown.ts so that
// callers who only need to render a string (resource flows, the admin editor
// preview) don't pull node:fs, gray-matter and supabase-js in with it.
// Re-exported here so existing blog importers are unaffected and both sources
// keep rendering through the same processor.
export { renderMarkdown };

/**
 * One post, rendered.
 *
 * React-cached because every post page resolves it twice — once in
 * `generateMetadata`, once in the page body — and each resolution ran the
 * whole unified markdown pipeline over the full article. The cache collapses
 * that to one parse per request (and one per page during the static build).
 */
export const getPostBySlug = cache(async function getPostBySlug(
  slug: string,
): Promise<Post | null> {
  // DB posts override file posts on the same slug.
  const row = await getPublishedRowBySlug(slug);
  if (row) {
    return { meta: rowToMeta(row), html: await renderMarkdown(row.body ?? "") };
  }
  const raw = getFilePostRaw(slug);
  if (!raw) return null;
  const { meta, body } = parseMeta(slug, raw);
  return { meta, html: await renderMarkdown(body) };
});

/**
 * Related posts, scored by actual topical overlap.
 *
 * This used to be "same category first, then most recent". With 20–24 posts
 * per category that meant every post in a category linked to the same three
 * recent siblings: a few arbitrary posts collected every internal link, and
 * genuinely related posts — nine separate pitch-deck guides, for instance —
 * never linked to each other at all.
 *
 * Scoring lives in lib/seo-meta.ts (pure and unit-tested); see `pickRelated`
 * for the weights and why ties break on slug rather than date.
 */
export async function getRelatedPosts(
  current: PostMeta,
  limit = 3,
): Promise<PostMeta[]> {
  return pickRelated(current, await getAllPostsMeta(), limit);
}

/** Every published post in a category, newest first. Powers the hub pages. */
export async function getPostsByCategory(
  category: Category,
): Promise<PostMeta[]> {
  return (await getAllPostsMeta()).filter((p) => p.category === category);
}

/**
 * Posts to surface on the homepage.
 *
 * The homepage is the strongest page on the site — the most external links
 * point at it, so it holds the most authority to pass on. Until now it linked
 * to zero blog posts, so none of that reached the 135 guides, and the only
 * route a crawler had into a given post was the flat index.
 *
 * That matters more than it sounds: an exact-phrase search for a post title
 * that exists nowhere else on the internet currently returns nothing, which
 * means Google hasn't indexed most of the blog. Links from the homepage are
 * one of the strongest discovery signals available for fixing that.
 *
 * Uses the `featured` frontmatter flag, which had existed unused since the
 * blog was built. Falls back to newest-first so the section is never empty
 * if every flag is cleared.
 */
export async function getFeaturedPosts(
  limit = 6,
  onDbFailure: OnBlogDbFailure = "throw",
): Promise<PostMeta[]> {
  const all = await getAllPostsMeta(onDbFailure);
  const featured = all.filter((p) => p.featured);
  return (featured.length ? featured : all).slice(0, limit);
}
