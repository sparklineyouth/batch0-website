import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { cookies } from "next/headers";

type CookiesToSet = {
  name: string;
  value: string;
  options: CookieOptions;
}[];

// Supabase queries from server components / middleware go through the
// global fetch, which Next.js silently caches for GETs. That cache makes
// per-user reads (like `profiles.role`) appear stale after the row has
// changed in the DB. Force every Supabase fetch to opt out so reads
// always see the current row.
const noStoreFetch: typeof fetch = (input, init) =>
  fetch(input, { ...init, cache: "no-store" });

export async function createClient() {
  const cookieStore = await cookies();
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet: CookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options),
            );
          } catch {
            // RSC: cookies are read-only here; the middleware refreshes
            // sessions, so this is safe to swallow.
          }
        },
      },
      global: { fetch: noStoreFetch },
    },
  );
}
