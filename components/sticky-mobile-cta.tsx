"use client";
import { useEffect, useState } from "react";
import { track } from "@vercel/analytics";
import type { SiteConfig } from "@/lib/site-config";

/**
 * A pinned apply CTA at the bottom of the viewport on mobile once the
 * user has scrolled past the hero. Hidden when:
 *  - on desktop (md+)
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
    // Appear once the hero is behind the reader.
    const onScroll = () => setShow(window.scrollY > 480);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, [authedHome, settings.applicationsOpen]);

  if (authedHome || !settings.applicationsOpen) return null;

  const cohortLabel = derived.cohortLabel || "the next cohort";

  return (
    <div
      // `invisible` (visibility:hidden) removes the link from the tab
      // order while hidden — aria-hidden alone would leave a focusable
      // element inside a hidden region (axe: aria-hidden-focus).
      className={`pointer-events-none fixed inset-x-0 bottom-0 z-40 transition-[transform,opacity,visibility] duration-300 ease-out md:hidden ${
        show ? "visible translate-y-0 opacity-100" : "invisible translate-y-full opacity-0"
      }`}
    >
      <div className="pointer-events-auto border-t border-line bg-paper px-4 pb-safe pt-3">
        <a
          href="/apply"
          onClick={() => track("apply_click", { location: "sticky-mobile" })}
          className="press flex w-full items-center justify-between gap-3 rounded-md bg-spark px-4 py-3.5 text-[15px] font-semibold text-on-spark shadow-cta hover:bg-spark-200"
        >
          <span className="flex flex-col items-start leading-tight">
            <span>Apply for {cohortLabel}</span>
            <span className="text-[11px] font-normal text-ink/70">
              Free to apply · {derived.priceLabel} if accepted
            </span>
          </span>
          <span aria-hidden className="text-lg">→</span>
        </a>
      </div>
    </div>
  );
}
