"use client";

import React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  PROMO_ENDS_AT,
  PROMO_PERCENT,
  PROMO_SCOPE,
  activePromo,
  formatPromoDeadlines,
  DEFAULT_PROMO_CONFIG,
} from "@/lib/promo";

// Shape of GET /api/promo — the live, admin-set promotion.
type LivePromo =
  | { active: true; percent: number; longDeadline: string; endsAt: string | null }
  | { active: false };

/**
 * The sale bar — the site-wide announcement of the tuition promotion.
 *
 * WHY THIS IS A CLIENT COMPONENT. The root layout is statically generated, so
 * an `activePromo()` check rendered there would be frozen at build time and
 * would keep announcing the sale after it ended until somebody redeployed.
 * Evaluating the deadline in the browser instead means the bar disappears at
 * the deadline for every visitor, on every route — including the 135
 * prerendered blog posts, which are exactly the pages nobody would think to
 * rebuild.
 *
 * WHY IT FETCHES. The promo is now admin-editable at /admin/pricing, and the
 * static layout can't be handed the current values as props without turning
 * every page dynamic. So the banner renders the SEED promo on the server (the
 * same 10%-off constants, true at build time) for a no-flash first paint, then
 * fetches GET /api/promo on mount and corrects the percent, deadline, and
 * countdown to whatever an admin has set — or removes itself if the promo was
 * turned off or has ended. The client pass only ever CORRECTS or REMOVES.
 *
 * The countdown is deliberately mount-gated: rendering a live "2d 14h" string
 * on the server would hydrate against a different value a second later. The
 * server renders the static deadline, and the ticking clock replaces it after
 * mount.
 */
/**
 * Signed-in work surfaces: a tuition sale with "Apply now" is noise to admins,
 * mentors and enrolled students, and at phone width it pushes every page's
 * heading down four lines. /chat is a fixed full-screen surface: the bar would
 * sit hidden under it with a focusable "Apply now" link.
 */
const SIGNED_IN_SURFACE = /^\/(admin|dashboard|app|mentor|investor|notifications|chat)(\/|$)/;

export function SaleBanner() {
  const pathname = usePathname() ?? "";
  const [expired, setExpired] = React.useState(false);
  const [remaining, setRemaining] = React.useState<string | null>(null);
  // Null until the fetch resolves: before then the seed promo governs
  // visibility (no-flash), after then the admin-set state does — which is what
  // lets an admin turn a promo ON past the seed's own expiry, or OFF while the
  // seed still says it's live.
  const [liveActive, setLiveActive] = React.useState<boolean | null>(null);
  // Seed with the build-time constants so the server render and first paint
  // match; the fetch below replaces them with the admin-set values.
  const [percent, setPercent] = React.useState<number>(PROMO_PERCENT);
  // Derived from PROMO_ENDS_AT, never typed out. This was the literal string
  // "September 9", which is a second copy of the deadline living in a file
  // nobody would think to grep when moving the date — a banner reading "Ends
  // September 9" above a countdown ticking toward October 21 is exactly the
  // failure that produces. It now cannot disagree with the constant.
  const [deadlineLabel, setDeadlineLabel] = React.useState<string>(
    DEFAULT_PROMO_CONFIG.enabled
      ? formatPromoDeadlines(PROMO_ENDS_AT).long
      : "",
  );
  const [endsAt, setEndsAt] = React.useState<string | null>(PROMO_ENDS_AT);

  // Pull the live, admin-set promo once on mount. A failure leaves the seed
  // values in place rather than blanking the banner.
  React.useEffect(() => {
    let cancelled = false;
    fetch("/api/promo", { cache: "no-store" })
      .then((r) => (r.ok ? (r.json() as Promise<LivePromo>) : null))
      .then((data) => {
        if (cancelled || !data) return;
        setLiveActive(data.active);
        if (!data.active) return;
        setPercent(data.percent);
        setDeadlineLabel(data.longDeadline);
        setEndsAt(data.endsAt);
      })
      .catch(() => {
        /* keep seed values */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  React.useEffect(() => {
    if (!endsAt) {
      // Open-ended promo: no deadline, so no countdown to run.
      setRemaining(null);
      return;
    }
    const endsAtMs = new Date(endsAt).getTime();

    const tick = () => {
      const ms = endsAtMs - Date.now();
      if (ms <= 0) {
        setExpired(true);
        setRemaining(null);
        return;
      }
      const totalMinutes = Math.floor(ms / 60000);
      const days = Math.floor(totalMinutes / (60 * 24));
      const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
      const minutes = totalMinutes % 60;
      // Days drop off the label in the last 24 hours so the number that is
      // actually moving is the one a reader sees.
      setRemaining(
        days > 0 ? `${days}d ${hours}h left` : `${hours}h ${minutes}m left`,
      );
    };

    tick();
    // A minute is the smallest unit displayed, so a minute is how often this
    // needs to run. A per-second timer would repaint 60x for nothing.
    const id = window.setInterval(tick, 60_000);
    return () => window.clearInterval(id);
  }, [endsAt]);

  // Build-time truth for the server pass and first paint (seed promo), the
  // admin-set state once the fetch has resolved.
  const showable = liveActive === null ? !!activePromo() : liveActive;
  if (SIGNED_IN_SURFACE.test(pathname) || expired || !showable) return null;

  return (
    <aside
      // aria-label rather than a heading: this is an announcement region, and
      // a real <h2> here would land above the page's own <h1> in the outline.
      aria-label="Tuition sale"
      className="border-b border-on-phosphor/15 bg-phosphor text-on-phosphor"
    >
      <div className="mx-auto flex max-w-[1100px] flex-wrap items-center justify-center gap-x-3 gap-y-1 px-5 py-2 text-center font-mono text-[12px] uppercase leading-tight tracking-[0.12em] sm:px-6">
        <span className="font-semibold">{percent}% off tuition</span>
        {/* The scope, on the one surface that appears on every page. The bar
            previously said only "10% off tuition", which leaves a reader
            guessing whether it means one cohort, one region or a code they
            don't have. It is a static string (not fetched), because the offer
            has always covered whichever cohort is being sold — so it stays
            true whatever percent or deadline an admin sets. */}
        <span aria-hidden className="opacity-40">
          ·
        </span>
        <span>{PROMO_SCOPE}</span>
        {deadlineLabel && (
          <>
            <span aria-hidden className="opacity-40">
              ·
            </span>
            <span>Ends {deadlineLabel}</span>
          </>
        )}
        {remaining && (
          <>
            <span aria-hidden className="opacity-40">
              ·
            </span>
            {/* aria-live is deliberately absent: a countdown that announces
                itself every minute is a screen-reader trap. The deadline above
                is the accessible fact; this is a visual urgency cue. */}
            <span aria-hidden className="tabular-nums font-semibold">
              {remaining}
            </span>
          </>
        )}
        <span aria-hidden className="opacity-40">
          ·
        </span>
        <Link
          href="/apply"
          className="underline decoration-on-phosphor/40 underline-offset-4 transition-colors hover:decoration-on-phosphor"
        >
          Apply now
        </Link>
      </div>
    </aside>
  );
}
