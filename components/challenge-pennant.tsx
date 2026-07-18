"use client";
import { useEffect, useRef } from "react";
import Link from "next/link";

/**
 * THE CHALLENGE BUNTING — a festival string under the navbar on marketing
 * pages announcing the weekly challenge. The amber strip carries the text
 * (still, always readable); a row of small stepped-pixel triangle pennants
 * hangs off its bottom edge across the full width, point-down, like a
 * medieval bunting string. The pennants sway in a stepped TRAVELING wave —
 * each snaps between three tilt/offset states at ~170ms frames, staggered
 * along the row: wind moving down a string of flags, not a CSS wave.
 *
 * Palette is theme-reactive via --pennant-0/1/2 (globals.css): phosphor
 * gets the smolder ramp's dark end (deep ember / dim amber / burnt) —
 * torchlit castle banners on the black page; paper gets bright amber /
 * warm gold / parchment — festival day. Flat pixels only.
 *
 * Always renders, linking to /challenges. With a live challenge it shows
 * true data: title · prizeLabel · ends {closesAt}. Without one it shows
 * the standing fallback "new challenge every week · prizes up to $500"
 * (founder-confirmed true). Whole banner is one link; the fringe is
 * aria-hidden decoration. Reduced motion: static pennants, content
 * intact. Never on /apply, forms, or the product app — marketing only.
 */

// stepped-pixel triangle, point-down (edges stair like the CTA shape)
const TRI =
  "polygon(0 0, 100% 0, 100% 25%, 87.5% 25%, 87.5% 50%, 75% 50%, 75% 75%, 62.5% 75%, 62.5% 100%, 37.5% 100%, 37.5% 75%, 25% 75%, 25% 50%, 12.5% 50%, 12.5% 25%, 0 25%)";
const PENNANTS = 48;
// slight size variation, 26-38px wide, cycling irregularly
const penW = (i: number) => 26 + ((i * 7) % 13);
const penH = (i: number) => Math.round(penW(i) * 0.78);

export function ChallengePennant({
  title,
  prizeLabel,
  closesAt,
}: {
  title?: string | null;
  prizeLabel?: string | null;
  closesAt?: string | null;
}) {
  const fringeRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const fringe = fringeRef.current;
    if (!fringe) return;
    const pens = Array.from(fringe.children) as HTMLElement[];
    let phase = 0;
    const iv = setInterval(() => {
      if (document.hidden) return; // paused while hidden
      phase++;
      pens.forEach((el, i) => {
        // stepped traveling wave: snap to one of three states (-1/0/+1)
        const st = Math.round(Math.sin(phase * 0.5 + i * 0.45));
        el.style.transform = `rotate(${st * 7}deg) translateY(${st === 0 ? 0 : 2}px)`;
      });
    }, 170);
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

  return (
    <Link
      href="/challenges"
      aria-label={title ? `this week's challenge: ${label}` : `challenges: ${label}`}
      className="relative block focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-phosphor"
    >
      {/* the strip: still, readable */}
      <span className="t-small relative block truncate bg-phosphor-fill px-5 py-2 font-mono font-medium lowercase text-on-phosphor sm:px-6">
        {label} <span aria-hidden>→</span>
      </span>
      {/* the bunting fringe: stepped pennants hanging point-down */}
      <div
        ref={fringeRef}
        aria-hidden
        className="flex items-start justify-between overflow-hidden px-1"
        style={{ height: 34 }}
      >
        {Array.from({ length: PENNANTS }, (_, i) => (
          <div
            key={i}
            className="shrink-0"
            style={{
              width: penW(i),
              height: penH(i),
              marginRight: 6,
              background: `var(--pennant-${i % 3})`,
              clipPath: TRI,
              transformOrigin: "top center",
            }}
          />
        ))}
      </div>
    </Link>
  );
}
