"use client";
import { useEffect, useRef } from "react";
import Link from "next/link";

/**
 * THE CHALLENGE PENNANT — a pixel banner under the navbar on marketing
 * pages announcing the live weekly challenge. Drawn as a medieval pennant
 * in the block language: the strip's right end tapers to a stepped
 * swallowtail fork (clip-path, same technique as the CTA), and the amber
 * field ripples in a slow TRAVELING STEPPED sine — each field column
 * snaps between three discrete 4px offsets at ~150ms frames. A pixel flag
 * in wind, not a CSS wave. The text layer stays still (legibility).
 *
 * Always renders, linking to /challenges. With a live challenge it shows
 * true data: title · prizeLabel · ends {closesAt}. Without one it shows
 * the standing fallback "new challenge every week · prizes up to $500"
 * (founder-confirmed true). Whole banner is one link; the wave is aria-hidden
 * decoration. Amber field + dark text in both themes (phosphor-fill).
 * Reduced motion: static pennant, content intact. Never on /apply, forms,
 * or the product app — mount on marketing pages only.
 */
export function ChallengePennant({
  title,
  prizeLabel,
  closesAt,
}: {
  title?: string | null;
  prizeLabel?: string | null;
  closesAt?: string | null;
}) {
  const fieldRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const field = fieldRef.current;
    if (!field) return;
    const cols = Array.from(field.children) as HTMLElement[];
    let phase = 0;
    const iv = setInterval(() => {
      if (document.hidden) return; // paused while hidden
      phase++;
      cols.forEach((c, i) => {
        // traveling stepped sine, snapped to -4 / 0 / +4 (1 block)
        const o = Math.round(Math.sin(phase * 0.45 + i * 0.55)) * 4;
        c.style.transform = `translateY(${o}px)`;
      });
    }, 150);
    return () => clearInterval(iv);
  }, []);

  const ends = closesAt
    ? new Date(closesAt)
        .toLocaleDateString("en-US", { month: "short", day: "numeric" })
        .toLowerCase()
    : null;
  // no live challenge → the standing (founder-confirmed) line
  const label = title
    ? `this week: ${title} · ${prizeLabel}${ends ? ` · ends ${ends}` : ""}`
    : "new challenge every week · prizes up to $500";

  // stepped swallowtail fork on the right end (pixel steps, no curves)
  const fork =
    "polygon(0 0, 100% 0, calc(100% - 8px) 0, calc(100% - 8px) 12%, calc(100% - 0px) 12%, 100% 0, 100% 0, 100% 0, 100% 12%, calc(100% - 10px) 30%, calc(100% - 20px) 50%, calc(100% - 10px) 70%, 100% 88%, 100% 100%, 0 100%)";

  return (
    <Link
      href="/challenges"
      aria-label={title ? `this week's challenge: ${label}` : `challenges: ${label}`}
      className="relative block overflow-hidden focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-phosphor"
      style={{ clipPath: fork }}
    >
      {/* the waving amber field: stepped columns behind the text */}
      <div ref={fieldRef} aria-hidden className="absolute -inset-y-2 inset-x-0 flex">
        {Array.from({ length: 48 }, (_, i) => (
          <div key={i} className="h-full min-w-[32px] flex-1 bg-phosphor-fill" />
        ))}
      </div>
      <span className="t-small relative block truncate px-5 py-2 font-mono font-medium lowercase text-on-phosphor sm:px-6">
        {label} <span aria-hidden>→</span>
      </span>
    </Link>
  );
}
