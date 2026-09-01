"use client";
import { useEffect, useState } from "react";
import { track } from "@vercel/analytics";
import type { SiteConfig } from "@/lib/site-config";
import { useIsAuthed } from "@/components/auth-label";

/**
 * A pinned apply CTA at the bottom of the viewport on mobile once the
 * user has scrolled past the hero. Hidden when:
 *  - on desktop (md+)
 *  - visitor is already signed in (they have a dashboard CTA)
 *  - applications are closed
 *
 * The signed-in check used to arrive as a server-resolved prop, which is
 * what kept the homepage from prerendering. It resolves in the browser now —
 * free of charge here, because this bar only appears after a scroll, long
 * after hydration, so there is nothing to flash and nothing to shift.
 */
export default function StickyMobileCta({ config }: { config: SiteConfig }) {
  const { derived, settings } = config;
  const [show, setShow] = useState(false);
  const isAuthed = useIsAuthed();

  useEffect(() => {
    if (isAuthed) return;
    if (!settings.applicationsOpen) return;
    // Appear once the hero is behind the reader.
    const onScroll = () => setShow(window.scrollY > 480);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, [isAuthed, settings.applicationsOpen]);

  if (isAuthed || !settings.applicationsOpen) return null;

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
          className="press flex w-full items-center justify-between gap-3 rounded-md bg-phosphor px-4 py-3.5 text-[15px] font-semibold text-on-phosphor shadow-cta hover:bg-phosphor-200"
        >
          <span className="flex flex-col items-start leading-tight">
            <span>Apply for {cohortLabel}</span>
            {/* `text-on-phosphor`, never `text-ink`. The phosphor fill is a
                constant yellow in both themes, but --ink flips to near-white
                in dark mode — so text-ink/70 here rendered at ~1.35:1 and the
                risk-reversal line effectively vanished on the highest-intent
                element on mobile. See the token note in tailwind.config.ts. */}
            <span className="text-[11px] font-normal text-on-phosphor/70">
              Free to apply · {derived.priceLabel} if accepted
            </span>
          </span>
          <span aria-hidden className="text-lg">→</span>
        </a>
      </div>
    </div>
  );
}
