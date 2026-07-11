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
