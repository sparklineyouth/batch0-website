import React from "react";
import Image from "next/image";

/**
 * A night/day image pair that follows the active theme.
 *
 * WHY CSS AND NOT JS: the inline script in app/layout.tsx stamps `paper`
 * or `dark` onto <html> before first paint. Both frames are rendered into
 * the markup and the non-matching one is `display:none`d by a rule keyed
 * off that class, so the browser resolves the choice synchronously during
 * the very first style pass — the correct image is the first thing ever
 * painted. A useEffect/useState swap cannot do this: the server has no
 * idea which theme is active, so it would paint one frame of the wrong
 * image (or nothing) before hydration corrected it. Toggling is likewise
 * a pure class change with no request, no decode, and no JS in the path.
 *
 * SSR-safe: no hooks, no client boundary — usable inside Server
 * Components exactly like next/image.
 *
 * NO LAYOUT SHIFT: in `fill` mode both frames are absolutely positioned
 * inside the caller's box, so neither contributes to layout. In intrinsic
 * mode both are given the SAME width/height, so whichever one is showing
 * occupies an identical box and the swap cannot move anything.
 *
 * COST: both frames are fetched. That is the price of honouring the
 * manual toggle — a <picture media="(prefers-color-scheme:dark)"> would
 * fetch only one but would ignore the user's explicit choice. next/image
 * serves resized AVIF/WebP rather than the multi-MB PNG sources, so the
 * second frame is tens of KB, not megabytes.
 */

type Common = {
  /** Shown in the dark (phosphor) theme. */
  night: string;
  /** Shown in the light (paper) theme. */
  day: string;
  /** Use "" for decorative art; both frames share it, and only the
   *  visible frame reaches the a11y tree (display:none is excluded). */
  alt: string;
  priority?: boolean;
  sizes?: string;
  /** Applied to BOTH frames — object-fit, rounding, etc. */
  className?: string;
};

type Props = Common &
  (
    | { fill: true; width?: never; height?: never }
    | { fill?: false; width: number; height: number }
  );

export function ThemedImage({
  night,
  day,
  alt,
  priority,
  sizes,
  className = "",
  fill,
  width,
  height,
}: Props) {
  const shared = {
    alt,
    priority,
    sizes,
    ...(fill ? { fill: true as const } : { width: width!, height: height! }),
  };

  return (
    <>
      <Image {...shared} src={night} className={`themed-night ${className}`} />
      <Image {...shared} src={day} className={`themed-day ${className}`} />
    </>
  );
}
