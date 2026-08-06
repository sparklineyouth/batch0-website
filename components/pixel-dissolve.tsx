import React from "react";

/**
 * PIXEL DISSOLVE — the reusable seam between a full-bleed image section
 * and the flat page below it.
 *
 * The page colour eats into the bottom of the artwork as a scatter of
 * square pixels: solid at the very edge, thinning upward until it is a
 * whisper. Reads as the painting dissolving into the page rather than
 * being cut off by a hard line.
 *
 * DETERMINISTIC BY CONSTRUCTION: the scatter comes from a seeded PRNG,
 * never Math.random(). The server and the client generate byte-identical
 * markup, so there is no hydration mismatch and no re-scatter on
 * navigation. Change `seed` to get a different (but equally stable)
 * arrangement — useful when two dissolves are visible at once.
 *
 * ONE DOM NODE: the scatter is a single inline <svg> of <rect>s with a
 * unitless viewBox stretched by preserveAspectRatio="none", so a hundred-
 * odd pixels cost one element and zero layout. shapeRendering keeps the
 * squares crisp at any scale. Purely decorative, so aria-hidden.
 *
 * THEME-AWARE FOR FREE: fill is currentColor and the wrapper is
 * text-paper, which is already a theme-reactive token — the dissolve is
 * whatever the page background is, in either theme.
 */

/** mulberry32 — small, fast, seeded. Same seed always yields the same run. */
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function PixelDissolve({
  /** Which edge of the parent the solid end sits on. */
  edge = "bottom",
  /** Rendered height of the band, in px. */
  height = 112,
  /** Scatter resolution. More columns = finer pixels. */
  cols = 116,
  rows = 18,
  /** Higher = the scatter stays sparse longer before going solid. */
  falloff = 3.4,
  seed = 7,
  className = "",
}: {
  edge?: "bottom" | "top";
  height?: number;
  cols?: number;
  rows?: number;
  falloff?: number;
  seed?: number;
  className?: string;
}) {
  const rand = mulberry32(seed);
  const rects: React.ReactNode[] = [];

  for (let r = 0; r < rows; r++) {
    // 0 at the feathered end → 1 at the solid end. The last row is always
    // fully filled, which is what seals the band against the page.
    const density = Math.pow((r + 1) / rows, falloff);
    for (let c = 0; c < cols; c++) {
      // Draw for every cell so the sequence is independent of `density` —
      // changing falloff re-weights the scatter instead of reshuffling it.
      if (rand() < density) {
        const y = edge === "bottom" ? r : rows - 1 - r;
        rects.push(<rect key={`${r}-${c}`} x={c} y={y} width="1" height="1" />);
      }
    }
  }

  return (
    <div
      aria-hidden
      className={`pointer-events-none absolute inset-x-0 z-[5] text-paper ${
        edge === "bottom" ? "bottom-0" : "top-0"
      } ${className}`}
      style={{ height }}
    >
      <svg
        viewBox={`0 0 ${cols} ${rows}`}
        preserveAspectRatio="none"
        className="h-full w-full"
        fill="currentColor"
        shapeRendering="crispEdges"
        focusable="false"
      >
        {rects}
      </svg>
    </div>
  );
}
