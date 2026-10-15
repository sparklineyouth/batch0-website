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
  // These routes read fonts from disk at runtime. Next 15 makes tracing
  // configuration stable at the top level; leaving it in experimental
  // would silently omit fonts from deployment bundles.
  outputFileTracingIncludes: {
    "/opengraph-image": ["./lib/og-fonts/**"],
    "/start/opengraph-image": ["./lib/og-fonts/**"],
    "/blog/[slug]/opengraph-image": ["./lib/og-fonts/**"],
    "/verify/[code]/og": ["./lib/og-fonts/**"],
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
      // Check-ins became assignments (migration 0093). Old links, emails and
      // installed-app shortcuts still point here.
      { source: "/dashboard/checkin", destination: "/dashboard/assignments", permanent: true },
      { source: "/mentor/checkins", destination: "/mentor/assignments", permanent: true },
      { source: "/app/checkin", destination: "/app/assignments", permanent: true },
      // The check-in monitors went with them; the completion matrix replaces them.
      { source: "/admin/pulse", destination: "/admin", permanent: true },
      { source: "/admin/interventions", destination: "/admin/assignments?filter=missing", permanent: true },
      { source: "/admin/cohorts/:id/health", destination: "/admin/assignments?cohort=:id", permanent: true },
      // A private question to the team (lessons and old emails link
      // /dashboard/discussions/new?to=team) is now a support request.
      {
        source: "/dashboard/discussions/new",
        destination: "/dashboard/support/new?topic=program",
        permanent: true,
      },
      // Retired features (October 2026): community features batch0 Chat covers,
      // and admin pages cut as bulk. Old notification links and bookmarks land
      // on the section they lived in instead of a 404. Open private questions
      // and DM reports moved into Support (0099), so the staff queues' links
      // go there too: an old "Reported conversation" bell (/admin/messages/<id>)
      // lands where its sensitive Support ticket is still open (0101 files the
      // carried report as already actioned in Chat).
      // Direct messages came back as batch0 Chat (0101) with the same ids, so
      // an old "messaged you" bell (/messages?c=<id>) opens the same
      // conversation; the query string passes through. Browsers that cached
      // the permanent /messages → /notifications this replaced never ask for
      // it, so /notifications forwards their ?c= to /chat as well.
      { source: "/messages/:path*", destination: "/chat", permanent: false },
      ...[
        ["/dashboard/discussions/:path*", "/dashboard/support"],
        ["/admin/discussions/:path*", "/admin/support"],
        ["/admin/messages/:path*", "/admin/support"],
        ["/admin/ai-usage/:path*", "/admin"],
        ["/admin/mentors/match/:path*", "/admin/mentors"],
        ["/admin/course/analytics/:path*", "/admin/course"],
        ["/admin/payments/acquisition/:path*", "/admin/payments"],
        ["/admin/email/phone-request/:path*", "/admin/email"],
        // The Discord integration's admin page; batch0 Chat replaced it.
        ["/admin/discord/:path*", "/admin/chat"],
        // Folded into the page that owns them.
        ["/admin/pass-requests", "/admin/passes"],
        ["/admin/moderation", "/admin/teams"],
      ].map(([source, destination]) => ({ source, destination, permanent: true })),
      // Office hours were retired; old links land on 1:1 calls.
      { source: "/dashboard/office-hours", destination: "/dashboard/calls", permanent: false },
      { source: "/mentor/office-hours", destination: "/mentor/calls", permanent: false },
      // Personal Files was replaced by the team's Google Drive (0094).
      {
        source: "/dashboard/files/:path*",
        destination: "/dashboard/team?tab=drive",
        permanent: false,
      },
    ];
  },
  // Nobody else may frame batch0 (clickjacking). This governs who frames us,
  // not what we frame: Google Drive, YouTube and Loom embeds are unaffected.
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Frame-Options", value: "SAMEORIGIN" },
          { key: "Content-Security-Policy", value: "frame-ancestors 'self'" },
        ],
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
      // Prod currently builds with no DSN, so zero Sentry JS ships. The day a
      // DSN is set, the default client build would add ~35-40 kB gz to every
      // page; this strips debug-only code paths ahead of that. Replay tree-
      // shaking flags are deliberately NOT set — replaysOnErrorSampleRate is
      // 1.0 in sentry.client.config.ts, so replay must stay in the bundle.
      bundleSizeOptimizations: {
        excludeDebugStatements: true,
      },
    })
  : nextConfig;
