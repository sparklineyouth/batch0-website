const { withSentryConfig } = require("@sentry/nextjs");

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  experimental: {
    // Disable the client-side router cache so admin/dashboard list views
    // re-fetch on navigation. Without this, navigating back to a list
    // shows a stale prefetched RSC payload until the user hard-reloads.
    staleTimes: {
      dynamic: 0,
      static: 30,
    },
    // The OG routes read these .ttf files from disk at runtime (lib/og-fonts).
    // Tracing can't see a runtime readFile path, so the fonts would be left
    // out of the serverless bundle and every social card would 500 in prod
    // while working fine locally. Name them explicitly.
    outputFileTracingIncludes: {
      "/opengraph-image": ["./lib/og-fonts/**"],
      "/blog/[slug]/opengraph-image": ["./lib/og-fonts/**"],
      "/verify/[code]/og": ["./lib/og-fonts/**"],
    },
  },
  // Brand consolidation: batch0.org (apex) is canonical. Everything else the
  // project answers on folds into it, preserving the path so old deep links
  // (/apply, /blog/<slug>, a student's dashboard bookmark) land where they
  // used to rather than dumping everyone on the homepage.
  //
  // These are 308s (permanent: true) — deliberate, because that's what
  // transfers the old domain's search authority to the new one. It also means
  // browsers cache them hard, so sparklineyouth.org is effectively a one-way
  // door once this ships. That's the point of a rebrand, but it is the piece
  // that's genuinely painful to walk back.
  async redirects() {
    const to = "https://batch0.org/:path*";
    const host = (value) => [{ type: "host", value }];
    return [
      {
        source: "/:path*",
        has: host("(www\\.)?sparklineyouth\\.org"),
        destination: to,
        permanent: true,
      },
      {
        source: "/:path*",
        has: host("(www\\.)?batchzero\\.org"),
        destination: to,
        permanent: true,
      },
      {
        source: "/:path*",
        has: host("www\\.batch0\\.org"),
        destination: to,
        permanent: true,
      },
    ];
  },
  webpack: (config) => {
    // Silence the noisy "Critical dependency: the request of a dependency is
    // an expression" warning emitted by @prisma/instrumentation (pulled in
    // transitively via @sentry/node). It comes from a dynamic require webpack
    // can't statically resolve; it's harmless and not fixable in our code.
    config.ignoreWarnings = [
      ...(config.ignoreWarnings ?? []),
      { module: /@opentelemetry\/instrumentation/ },
      { module: /@prisma\/instrumentation/ },
    ];
    return config;
  },
};

const enableSentry =
  process.env.NEXT_PUBLIC_SENTRY_DSN || process.env.SENTRY_DSN;

module.exports = enableSentry
  ? withSentryConfig(nextConfig, {
      silent: true,
      hideSourceMaps: true,
      disableLogger: true,
      tunnelRoute: "/monitoring",
    })
  : nextConfig;
