"use client";

import Script from "next/script";
import { usePathname } from "next/navigation";
import { useEffect } from "react";

/**
 * Google Analytics 4.
 *
 * Mounted once in the root layout, which is how "every page" works in the App
 * Router — the layout wraps every route, so the tag is present everywhere
 * without pasting it into 30+ files. Pasting it per-page would inject the
 * library multiple times and double-count pageviews.
 *
 * Excluded from /admin. Two reasons, and both need handling separately:
 *
 *   1. Direct load of /admin — the scripts simply never render.
 *   2. Client-side navigation into /admin after GA has already loaded on
 *      another route. Unmounting <Script> does not unload gtag.js, so the
 *      library is still there and would keep reporting. Google's documented
 *      kill switch, `window['ga-disable-<ID>'] = true`, is checked by gtag.js
 *      at send time, so setting it on route change genuinely stops the hits.
 *
 * SPA pageviews: GA4's enhanced measurement tracks History API changes by
 * default, which covers Next's client-side navigation. That setting lives in
 * the GA4 property (Admin → Data streams → Enhanced measurement), not here —
 * if pageviews stop at the first one, that toggle is why. Deliberately not
 * sending them manually as well, which would double-count.
 */

const GA_ID = process.env.NEXT_PUBLIC_GA_ID ?? "G-C51DMRB6YE";
const DISABLE_KEY = `ga-disable-${GA_ID}`;

/** Route prefixes that must never report to Analytics. */
const EXCLUDED_PREFIXES = ["/admin"];

function isExcluded(pathname: string | null): boolean {
  if (!pathname) return false;
  return EXCLUDED_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

export function GoogleAnalytics() {
  const pathname = usePathname();
  const excluded = isExcluded(pathname);

  useEffect(() => {
    // Flip Google's kill switch on every route change, in both directions, so
    // navigating out of /admin re-enables reporting.
    (window as unknown as Record<string, boolean>)[DISABLE_KEY] = excluded;
  }, [excluded]);

  // Keep local development out of the production property. Preview deploys
  // still report; that's deliberate, it's the only way to verify the tag
  // works before it reaches production.
  if (process.env.NODE_ENV === "development") return null;
  if (excluded) return null;

  return (
    <>
      <Script
        src={`https://www.googletagmanager.com/gtag/js?id=${GA_ID}`}
        strategy="afterInteractive"
      />
      <Script id="ga4-init" strategy="afterInteractive">
        {`
          window['${DISABLE_KEY}'] = ${JSON.stringify(EXCLUDED_PREFIXES)}
            .some(function (p) {
              return location.pathname === p || location.pathname.indexOf(p + '/') === 0;
            });
          window.dataLayer = window.dataLayer || [];
          function gtag(){dataLayer.push(arguments);}
          gtag('js', new Date());
          gtag('config', '${GA_ID}');
        `}
      </Script>
    </>
  );
}
