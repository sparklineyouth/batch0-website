import { createClient } from "@supabase/supabase-js";

// Supabase queries run through the global fetch, which Next.js silently
// caches for GETs. That Data Cache makes reads appear stale after the row
// has changed in the DB — e.g. an admin flips `referrals_enabled` on but
// getSiteConfig() keeps returning the old value across the dashboard,
// /admin/referrals, and the ?ref gate. Force every service-role fetch to
// bypass the cache, mirroring lib/supabase/server.ts and middleware.ts
// (which already do this for the anon client). All admin-client reads are
// per-request/admin data that must be fresh anyway.
const noStoreFetch: typeof fetch = (input, init) =>
  fetch(input, { ...init, cache: "no-store" });

// Service-role client. NEVER import this into client components.
// Bypasses RLS — use only in route handlers, server actions, or webhooks.
export function createAdminClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { fetch: noStoreFetch },
    },
  );
}

/**
 * Service-role client for PUBLIC, cacheable reads. Same key and the same
 * RLS bypass — the only difference is that it does NOT force `no-store`.
 *
 * That difference decides how the whole marketing site renders. In the App
 * Router a `fetch(..., { cache: "no-store" })` inside a page throws a
 * DynamicServerError during prerendering, which aborts static generation for
 * the entire route. The forced no-store above is therefore not just a cache
 * setting: it was single-handedly keeping every marketing page — including
 * all 135 blog posts, which have generateStaticParams and looked static in
 * the build table — on the per-request serverless path.
 *
 * Use this ONLY for data that is the same for every visitor and safe to serve
 * a few minutes stale (the marketing cohort/settings read in lib/site-config).
 * Anything per-user, or anything gating access, stays on createAdminClient —
 * see the note above about `referrals_enabled` reading stale.
 *
 * The same trick is already used, for the same reason, by `blogReadClient()`
 * in lib/blog.ts.
 */
export function createPublicReadClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
}
