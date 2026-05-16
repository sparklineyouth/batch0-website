"use client";
import { useEffect, useState } from "react";
import type { SiteConfig } from "@/lib/site-config";

/**
 * A floating apply CTA that pins to the bottom of the viewport on mobile
 * once the user has scrolled past the hero. Hidden when:
 *  - on desktop (md+)
 *  - on prerendered SSR (avoids hydration jank)
 *  - visitor is already signed in (they have a dashboard CTA)
 *  - applications are closed
 */
export default function StickyMobileCta({
  config,
  authedHome,
}: {
  config: SiteConfig;
  authedHome?: string | null;
}) {
  const { derived, settings } = config;
  const [show, setShow] = useState(false);

  useEffect(() => {
    if (authedHome) return;
    if (!settings.applicationsOpen) return;
    // Show only after the user has scrolled past the hero — roughly the
    // first viewport height. We use scrollY > 480 as a heuristic so the
    // bar appears slightly before the user has fully left the hero.
    const onScroll = () => setShow(window.scrollY > 480);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, [authedHome, settings.applicationsOpen]);

  if (authedHome || !settings.applicationsOpen) return null;

  return (
    <div
      aria-hidden={!show}
      className={`md:hidden fixed inset-x-0 bottom-0 z-40 pointer-events-none transition-[transform,opacity] duration-300 ease-out ${
        show
          ? "translate-y-0 opacity-100"
          : "translate-y-full opacity-0"
      }`}
    >
      <div className="pointer-events-auto border-t border-white/10 bg-black/95 backdrop-blur supports-[backdrop-filter]:bg-black/80 px-4 pt-3 pb-safe">
        <a
          href="/apply"
          className="press flex w-full items-center justify-between gap-3 rounded-lg bg-spark px-4 py-3.5 text-[15px] font-semibold text-black shadow-[0_8px_24px_-8px_rgba(250,204,21,0.6)] hover:bg-spark-200"
        >
          <span className="flex flex-col items-start leading-tight">
            <span>Apply to SparkLine Youth</span>
            <span className="text-[11px] font-normal text-black/70">
              Free · {derived.priceLabel} if accepted
            </span>
          </span>
          <span aria-hidden className="text-lg">→</span>
        </a>
      </div>
    </div>
  );
}
