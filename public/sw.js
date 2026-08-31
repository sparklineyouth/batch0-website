/* eslint-disable no-undef */
/**
 * The smallest service worker that does its job, and nothing else.
 *
 * It exists for exactly two reasons:
 *   1. Chromium requires a registered service worker with a fetch handler
 *      before it will offer "Install app". No worker, no install banner —
 *      Android users would be stuck with a plain bookmark. (iOS needs only the
 *      manifest, and ignores this file entirely.)
 *   2. A navigation that fails offline should land on a real page instead of
 *      the browser's dinosaur.
 *
 * What it deliberately does NOT do is cache responses. This worker is
 * registered at root scope, so it sits in front of the marketing site, the
 * authenticated dashboard, and the admin panel alike. Any read-through cache
 * here is a way to serve one signed-in user's admin page to the next person on
 * the device, or to pin a stale build until someone clears site data — and a
 * service worker is the hardest thing in the stack to unship once it's wrong.
 *
 * So: navigations go to the network, always. The cache is consulted only when
 * the network throws, and it holds exactly one entry, which is a static page
 * with no user data in it.
 *
 * Bump CACHE when OFFLINE_URL's content changes; `activate` drops every older
 * cache this origin owns.
 */
const CACHE = "batch0-shell-v1";
const OFFLINE_URL = "/offline";

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.add(new Request(OFFLINE_URL, { cache: "reload" })))
      // Take over immediately rather than waiting for every tab to close.
      // Safe precisely because there is no cached content to go stale.
      .then(() => self.skipWaiting())
      .catch(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  // Only top-level navigations. Everything else — RSC payloads, API routes,
  // /_next/static, images — passes straight through untouched.
  if (event.request.mode !== "navigate") return;
  event.respondWith(
    fetch(event.request).catch(() =>
      caches.match(OFFLINE_URL).then(
        (cached) =>
          cached ??
          new Response("You're offline.", {
            status: 503,
            headers: { "Content-Type": "text/plain" },
          }),
      ),
    ),
  );
});

// Lets a future deploy retire this worker from the page without waiting for a
// tab close. Nothing calls it yet; it costs three lines and is the escape
// hatch you want to already have.
self.addEventListener("message", (event) => {
  if (event.data === "SKIP_WAITING") self.skipWaiting();
});
