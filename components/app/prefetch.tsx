"use client";
import { useEffect } from "react";
import { useRouter } from "next/navigation";

/**
 * Warms every other tab the moment the app opens, so tapping one is instant.
 *
 * Why this is imperative rather than just leaving it to <Link>: a Link only
 * prefetches when it scrolls into view, and only the static shell for a dynamic
 * route. That is enough to paint a skeleton but not enough to have the DATA
 * ready. Calling router.prefetch() outright fetches the full RSC payload for
 * each route, which means the server actually renders it — running its queries
 * and populating the request-level and data caches — before the user has
 * decided to go there.
 *
 * The second half of the trick is that this survives `staleTimes.dynamic = 0`
 * (next.config.js). That setting throws away the CLIENT-side copy of a
 * prefetched dynamic route, which is why prefetching alone never helped here.
 * But the server-side work is not thrown away: the reads behind these screens
 * are wrapped in unstable_cache (lib/app-cache.ts), so the prefetch leaves a
 * warm cache entry and the eventual tap renders from it instead of from
 * Postgres. The client copy being discarded is fine — correctness is preserved
 * and the expensive half is already done.
 *
 * Re-warmed on foreground, not on an interval. A phone app spends most of its
 * life backgrounded; the moment worth spending a request on is when someone
 * picks the phone back up, because that is when the cache has most likely
 * expired and is about to be needed. A timer would burn the user's data on a
 * screen nobody is looking at.
 */
export function AppPrefetch({ routes }: { routes: string[] }) {
  const router = useRouter();

  useEffect(() => {
    // The current route is already rendered; prefetching it again would be a
    // duplicate render on the server for nothing.
    const warm = () => {
      for (const href of routes) {
        // Fire-and-forget by design. A failed prefetch is invisible and
        // harmless — the tap just pays the normal cost.
        try {
          router.prefetch(href);
        } catch {
          /* older browsers, aborted navigations */
        }
      }
    };

    // Yield first. Prefetching four routes competes with the render and the
    // data fetch of the screen the user is ACTUALLY looking at, and that screen
    // has to win — a preload that delays the current paint has made the app
    // slower, not faster.
    const id = window.setTimeout(warm, 400);

    const onVisible = () => {
      if (document.visibilityState === "visible") warm();
    };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      window.clearTimeout(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
    // `routes` is a literal defined in the layout module, so its identity is
    // stable across renders; joining it keeps the dep check honest anyway.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router, routes.join(",")]);

  return null;
}
