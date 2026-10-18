import test from "node:test";
import assert from "node:assert/strict";
import * as nodeModule from "node:module";
import { pathToFileURL, fileURLToPath } from "node:url";
import path from "node:path";

// Run with `npm test`. The real lib/blog.ts, with the blog_posts read doubled:
// what each kind of page gets when the database can't be read. The blog's
// pages are cached (ISR), and Next keeps the last good copy only when a
// regeneration THROWS — so a Supabase 504 must throw there, not return a
// blog without its admin-written posts (or a 404 for one of them) to be cached
// for an hour. The per-request homepage and `next build` still fall back to the
// committed posts. A missing table is "no DB posts", not a failure.

type Answer = { data: unknown; error: { code?: string; message: string } | null };
const state = {
  answer: { data: [], error: null } as Answer,
  reads: 0,
  logged: [] as unknown[][],
};
console.error = (...args: unknown[]) => void state.logged.push(args);

const DB_ROW = {
  slug: "db-only-post",
  title: "Written in the admin panel",
  description: "A post that lives only in blog_posts.",
  excerpt: null,
  body: "Hello from the database.",
  category: "Build",
  author_key: "team",
  tags: [],
  featured: false,
  status: "published",
  published_on: "2030-01-01",
  updated_on: null,
};
const FILE_SLUG = "balancing-school-and-startup";

const fakeSupabase = {
  createClient: () => ({
    from: () => {
      let single = false;
      const chain: any = {
        then: (ok: any, no: any) =>
          Promise.resolve()
            .then(() => {
              state.reads++;
              const a = state.answer;
              if (a.error) return { data: null, error: a.error };
              const rows = a.data as any[];
              return { data: single ? rows[0] ?? null : rows, error: null };
            })
            .then(ok, no),
      };
      chain.select = () => chain;
      chain.eq = () => chain;
      chain.maybeSingle = () => ((single = true), chain);
      return chain;
    },
  }),
};
(globalThis as any).__blogDbTest = { fakeSupabase };
const root = fileURLToPath(new URL("../", import.meta.url));
const fake = (source: string) => `data:text/javascript,${encodeURIComponent(source)}`;
(nodeModule as any).registerHooks({
  resolve(specifier: string, context: any, next: any) {
    const doubles: Record<string, string> = {
      "server-only": "export {};",
      // React's cache memoizes per render; outside one, every call runs.
      react: "export const cache=(fn)=>fn;",
      "@supabase/supabase-js": "export const createClient=(...a)=>globalThis.__blogDbTest.fakeSupabase.createClient(...a);",
      "@/lib/markdown": "export const renderMarkdown=async(md)=>`<p>${md}</p>`;",
    };
    if (doubles[specifier]) return { url: fake(doubles[specifier]), shortCircuit: true };
    if (specifier.startsWith("@/")) {
      return next(pathToFileURL(path.join(root, specifier.slice(2) + ".ts")).href, context);
    }
    return next(specifier, context);
  },
});
process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon";
delete process.env.NEXT_PHASE;
const blog = await import("./blog.ts");

const GATEWAY_TIMEOUT: Answer = { data: null, error: { message: "Gateway Timeout" } };
function reset(answer: Answer) {
  state.answer = answer;
  state.reads = 0;
  state.logged = [];
}

test("healthy: DB posts merge with the committed ones", async () => {
  reset({ data: [DB_ROW], error: null });
  const all = await blog.getAllPostsMeta();
  assert.equal(all[0].slug, "db-only-post", "newest first");
  assert.ok(all.some((p) => p.slug === FILE_SLUG));
  assert.equal((await blog.getPostBySlug("db-only-post"))?.meta.source, "db");
  assert.deepEqual(state.logged, []);
});

test("a cached blog page's regeneration throws on a 504, so the last good copy is kept", async () => {
  reset(GATEWAY_TIMEOUT);
  await assert.rejects(blog.getAllPostsMeta(), /\[blog\] failed to load DB posts: Gateway Timeout/);
  await assert.rejects(blog.getPostsByCategory("Build"), /Gateway Timeout/);
  // Not a cached 404 for a post that exists.
  await assert.rejects(blog.getPostBySlug("db-only-post"), /Gateway Timeout/);
  await assert.rejects(blog.getPostBySlug(FILE_SLUG), /Gateway Timeout/);
});

test("the per-request homepage renders the committed posts instead, and logs it", async () => {
  reset(GATEWAY_TIMEOUT);
  const featured = await blog.getFeaturedPosts(6, "files-only");
  assert.equal(featured.length, 6);
  const all = await blog.getAllPostsMeta("files-only");
  assert.ok(all.length > 100);
  assert.ok(all.every((p) => p.source === "file"));
  assert.ok(state.logged.some((a) => String(a[0]).includes("[blog] failed to load DB posts: Gateway Timeout")));
});

test("`next build` falls back to the committed posts rather than failing the deploy", async () => {
  reset(GATEWAY_TIMEOUT);
  process.env.NEXT_PHASE = "phase-production-build";
  try {
    const all = await blog.getAllPostsMeta();
    assert.ok(all.length > 100 && all.every((p) => p.source === "file"));
    assert.ok((await blog.getPostSlugs()).includes(FILE_SLUG));
    assert.equal((await blog.getPostBySlug(FILE_SLUG))?.meta.source, "file");
    assert.equal(await blog.getPostBySlug("db-only-post"), null);
    assert.ok(state.logged.length > 0, "and says so in the build log");
  } finally {
    delete process.env.NEXT_PHASE;
  }
});

test("no blog_posts table yet (or no database configured) is just no DB posts", async () => {
  reset({ data: null, error: { code: "PGRST205", message: "Could not find the table 'public.blog_posts' in the schema cache" } });
  const all = await blog.getAllPostsMeta();
  assert.ok(all.length > 100 && all.every((p) => p.source === "file"));
  assert.equal((await blog.getPostBySlug(FILE_SLUG))?.meta.source, "file");
  assert.equal(await blog.getPostBySlug("db-only-post"), null);
  assert.deepEqual(state.logged, []);

  reset(GATEWAY_TIMEOUT);
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  delete process.env.NEXT_PUBLIC_SUPABASE_URL;
  try {
    assert.ok((await blog.getAllPostsMeta()).length > 100);
    assert.equal(state.reads, 0);
  } finally {
    process.env.NEXT_PUBLIC_SUPABASE_URL = url;
  }
});
