/**
 * The installed app's own hostname.
 *
 * The app lives on its own subdomain so it never competes with the marketing
 * site: app.batch0.org is the product, batch0.org is the front door. Concretely
 * that buys three things —
 *
 *   1. The service worker only ever registers on this host, so batch0.org has
 *      no service worker at all and cannot be affected by one.
 *   2. Marketing URLs typed or linked into the subdomain bounce back to the
 *      apex, so there is exactly one indexable copy of every public page.
 *   3. The manifest's start_url can differ per host, so installing from either
 *      place lands you in the app rather than on the homepage.
 *
 * A hardcoded constant rather than an env var, matching how next.config.js
 * hardcodes the canonical domains and app/layout.tsx hardcodes the GA id: these
 * are facts about the deployment, not secrets, and an env var that is missing in
 * one Vercel environment fails silently in exactly the way a routing rule must
 * not.
 *
 * IMPORTANT: this module must stay Edge-safe — middleware imports it. No
 * next/headers, no Supabase client, no Node built-ins.
 */
export const APP_HOST = "app.batch0.org";

/** The canonical marketing origin. Where the subdomain sends public pages. */
export const MAIN_ORIGIN = "https://batch0.org";

/**
 * Is this request for the app subdomain?
 *
 * The Host header carries a port in local development and can carry one behind
 * a proxy, so it is stripped before comparing. Case-insensitive because Host is.
 */
export function isAppHost(host: string | null | undefined): boolean {
  if (!host) return false;
  return host.split(":")[0].toLowerCase() === APP_HOST;
}

/**
 * Public pages that have no business being served from the app subdomain.
 *
 * Everything else — /app, the auth funnel, /dashboard, /admin, /api, /auth —
 * passes through, so a student can sign in on the subdomain and follow the
 * app's deep links without being thrown between hosts mid-session.
 *
 * Note "/" is deliberately absent: on this host the root is the app, and the
 * middleware redirects it to /app before this is consulted.
 */
const MARKETING_PREFIXES = [
  "/program",
  "/blog",
  "/sponsors",
  // "/challenges" is deliberately NOT here. It looks like marketing and it is
  // not: an enrolled student's open challenge is surfaced on the app's Home
  // screen as a live deadline, and the entry form needs their session. Bouncing
  // it to the apex threw them out of the installed app into a host where their
  // cookie does not exist — sessions here are per-host — so the one thing the
  // screen said was due became a signed-out page. Search engines are handled
  // instead by metadataBase (app/layout.tsx), which canonicalises every
  // /challenges URL to batch0.org whichever host served it.
  "/privacy",
  "/terms",
  "/refund-policy",
  "/pass",
  "/teams",
  "/verify",
];

export function isMarketingPath(path: string): boolean {
  return MARKETING_PREFIXES.some((p) => path === p || path.startsWith(p + "/"));
}
