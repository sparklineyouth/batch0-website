"use client";
import { useEffect } from "react";
import { usePathname } from "next/navigation";

// The pricing override table (lib/pricing.ts) has exactly one country —
// India — and India uses exactly these IANA zones, so the visitor's clock
// answers the only question the geo header used to answer, without costing
// the marketing pages their prerender. If the override table ever grows,
// this display path needs a real geo source again.
const INDIA_TIME_ZONES = ["Asia/Kolkata", "Asia/Calcutta"];

/**
 * Regional tuition display for prerendered marketing pages.
 *
 * The server renders the base (US) price everywhere so / and /program can
 * be served as static HTML. After hydration, when the visitor's timezone
 * is Indian, every visible text occurrence of the base label is swapped
 * for the regional one. The label is plain text inside several server
 * components (hero, pricing, FAQ, ledger, CTAs) that never re-render in
 * the browser, so a one-time text-node swap holds — and both labels are
 * the same length ("$130" → "$115"), so nothing shifts. Script/style
 * contents are skipped: the FAQ's JSON-LD keeps the base price crawlers
 * were actually served. Checkout is unaffected — the charged amount is
 * resolved server-side from the real geo header at checkout time.
 *
 * Renders nothing. Mount once on each page that shows tuition.
 */
export function RegionalPrice({
  base,
  regional,
}: {
  base: string;
  regional: string;
}) {
  // Client-side navigation replaces the page's server-rendered text while
  // this component may stay mounted; re-keying the effect on the path
  // re-runs the swap over the fresh DOM.
  const pathname = usePathname();

  useEffect(() => {
    if (!base || base === regional) return;
    let timeZone: string | undefined;
    try {
      timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    } catch {
      return;
    }
    if (!timeZone || !INDIA_TIME_ZONES.includes(timeZone)) return;

    const walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode: (node) =>
          node.parentElement &&
          node.parentElement.tagName !== "SCRIPT" &&
          node.parentElement.tagName !== "STYLE" &&
          node.nodeValue?.includes(base)
            ? NodeFilter.FILTER_ACCEPT
            : NodeFilter.FILTER_SKIP,
      },
    );
    // Collect first, then mutate — editing nodes mid-walk unanchors the
    // TreeWalker.
    const matches: Text[] = [];
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      matches.push(n as Text);
    }
    for (const n of matches) {
      n.nodeValue = n.nodeValue!.split(base).join(regional);
    }
  }, [base, regional, pathname]);

  return null;
}
