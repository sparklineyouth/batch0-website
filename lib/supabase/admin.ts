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
