"use client";
import { useEffect, useRef } from "react";
import Link from "next/link";

/**
 * THE CHALLENGE BANNER — one dagged fabric under the navbar on marketing
 * pages. A medieval banner is a single continuous piece of cloth whose
 * bottom edge is CUT into triangles (a dagged edge) — not a strip with
 * flags strung under it. The whole silhouette is one pixel shape: solid
 * amber (#FFBB00, dark text, both themes), stepped edges everywhere —
 * stair-stepped top corners like the CTA, and every dag triangle cut in
 * 4px stair steps. Depth comes from ONE darker shade: a single-block
 * deep-amber underline tracing the dagged edge (--dag-shadow: ember on
 * phosphor, burnt on paper) — the cloth's shadow. No multi-tone cloth.
 *
 * MOTION, barely: the dags rest tucked one block under the strip; a slow
 * traveling wave lets each tip extend 1 block down and back (a few tips
 * at a time, ~450ms steps, crossing the full width in ~6-8s) — fabric
 * stirring. The text never moves. Reduced motion: static.
 *
 * Always renders, linking to /challenges. With a live challenge it shows
 * true data: title · prizeLabel · ends {closesAt}; without one, the
 * standing founder-confirmed line. The dagged fringe is aria-hidden.
 * Never on /apply, forms, or the product app — marketing pages only.
 */

const B = 4; // the pixel block
const DAG_W = 48; // 12 blocks — uniform, deliberate
const DAG_D = 24; // 6 rows deep
const DAGS = 40; // covers any viewport, overflow hidden

// stepped point-down triangle: each side steps in one block per row
const DAG_CLIP = (() => {
  const C = DAG_W / B, R = DAG_D / B; // 12 cols, 6 rows
  const cw = 100 / C, rh = 100 / R;
  const pts: string[] = ["0% 0%", "100% 0%"];
  for (let i = 1; i < R; i++)
    pts.push(`${100 - (i - 1) * cw}% ${i * rh}%`, `${100 - i * cw}% ${i * rh}%`);
  pts.push(`${100 - (R - 1) * cw}% 100%`, `${(R - 1) * cw}% 100%`);
  for (let i = R - 1; i >= 1; i--)
    pts.push(`${i * cw}% ${i * rh}%`, `${(i - 1) * cw}% ${i * rh}%`);
  return `polygon(${pts.join(", ")})`;
})();

// stair-stepped top corners (the CTA's grammar), straight elsewhere
const STRIP_CLIP =
  "polygon(0 12px, 4px 12px, 4px 8px, 8px 8px, 8px 4px, 12px 4px, 12px 0, calc(100% - 12px) 0, calc(100% - 12px) 4px, calc(100% - 8px) 4px, calc(100% - 8px) 8px, calc(100% - 4px) 8px, calc(100% - 4px) 12px, 100% 12px, 100% 100%, 0 100%)";

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
    const cols = Array.from(fringe.children) as HTMLElement[];
    let phase = 0;
    const iv = setInterval(() => {
      if (document.hidden) return; // paused while hidden
      phase++;
      // slow traveling wave: a short head of tips sits 1 block lower,
      // advancing a few dags per step — full crossing ~6-8s
      const head = (phase * 3) % (cols.length + 6);
      cols.forEach((c, i) => {
        const d = head - i;
        c.style.transform = d >= 0 && d < 3 ? `translateY(${B}px)` : "";
      });
    }, 450);
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
      {/* the strip: same cloth, still, readable — covers the dags' tuck */}
      <span
        className="t-small relative z-[1] block truncate bg-phosphor-fill px-5 py-2 font-mono font-medium lowercase text-on-phosphor sm:px-6"
        style={{ clipPath: STRIP_CLIP }}
      >
        {label} <span aria-hidden>→</span>
      </span>
      {/* the dagged edge: one continuous cut, ember shadow underlining it */}
      <div
        ref={fringeRef}
        aria-hidden
        className="flex overflow-hidden"
        style={{ height: DAG_D + B, marginTop: -B }}
      >
        {Array.from({ length: DAGS }, (_, i) => (
          <div
            key={i}
            className="relative shrink-0"
            style={{ width: DAG_W, height: DAG_D + 2 * B }}
          >
            <span
              className="absolute inset-x-0"
              style={{ top: B, height: DAG_D, background: "var(--dag-shadow)", clipPath: DAG_CLIP }}
            />
            <span
              className="absolute inset-x-0"
              style={{ top: 0, height: DAG_D, background: "#FFBB00", clipPath: DAG_CLIP }}
            />
          </div>
        ))}
      </div>
    </Link>
  );
}
