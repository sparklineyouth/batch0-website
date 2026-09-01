// ---------------------------------------------------------------------------
// Post-build guard for static rendering.
//
// The failure this exists to catch is completely silent. Add a cookies() read
// or a createAdminClient() call anywhere in a marketing page's module graph and
// Next 14 throws a DynamicServerError during prerendering, swallows it as a
// digest, and downgrades the route to per-request rendering. The build still
// exits 0 with no warning. Worse, the build table keeps printing "●" for
// /blog/[slug], because that marker is set from the presence of
// generateStaticParams, not from anything actually being emitted — which is
// how 135 blog posts spent their life as cold serverless renders while looking
// prerendered.
//
// So: never trust the build table. Assert on the artifacts.
// ---------------------------------------------------------------------------
import { readFile, readdir } from "node:fs/promises";

const manifest = JSON.parse(
  await readFile(".next/prerender-manifest.json", "utf8"),
);
const routes = Object.keys(manifest.routes);

const posts = routes.filter((r) => /^\/blog\/[^/.]+$/.test(r));
if (posts.length < 100) {
  throw new Error(
    `Static rendering regressed: ${posts.length} /blog/<slug> routes prerendered, expected 130+.\n` +
      `Something in that route's module graph now reads cookies()/headers() or issues a\n` +
      `no-store fetch. The usual suspects are getProfile() (lib/auth.ts) and\n` +
      `createAdminClient() (lib/supabase/admin.ts) — public reads must use\n` +
      `createPublicReadClient / getPublicSiteConfig instead.`,
  );
}

const MUST_BE_STATIC = [
  // "/" and "/program" prerender only because regional tuition is a
  // client-side label swap (components/regional-price.tsx) — reintroducing
  // a headers()/cookies() read there silently regresses the two
  // highest-traffic pages back to per-request rendering.
  "/",
  "/program",
  "/blog",
  "/sponsors",
  "/challenges",
  "/privacy",
  "/terms",
  "/refund-policy",
  // The auth funnel prerenders because ?next/?error moved to client-side
  // reads — adding a searchParams prop or server session read back to either
  // page flips it to per-request rendering.
  "/login",
  "/signup",
];
for (const route of MUST_BE_STATIC) {
  if (!manifest.routes[route]) {
    throw new Error(
      `Expected ${route} to be prerendered; it is rendering per-request. Same causes as above.`,
    );
  }
}

// A second, independent silent failure: if the site-config read fails during
// prerendering, postgrest swallows the error and getPublicSiteConfig returns
// FALLBACK_COHORT. That produces a green build serving hardcoded prices with
// the "N spots left" and application-countdown signals quietly missing. The
// only tell is in the emitted HTML.
const files = await readdir(".next/server/app/blog");
const html = files.find((f) => f.endsWith(".html"));
if (!html) throw new Error("No prerendered blog HTML on disk.");
const body = await readFile(`.next/server/app/blog/${html}`, "utf8");
if (!/Cohort \d/.test(body) || !body.includes("$")) {
  throw new Error(
    `${html} prerendered without real cohort data — getPublicSiteConfig fell back to\n` +
      `FALLBACK_COHORT during static generation. Check that lib/site-config.ts is not\n` +
      `reading through a no-store client inside unstable_cache.`,
  );
}

console.log(
  `verify-static: ok — ${posts.length} blog posts + ${MUST_BE_STATIC.length} marketing routes prerendered with live cohort data`,
);
