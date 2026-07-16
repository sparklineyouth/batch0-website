/**
 * THE SMOLDER — the hero 0's dither ramp. Five FLAT amber shades, deep
 * ember to near-white; every block gets exactly one at a time (no CSS
 * gradients anywhere, no blur, no glow — flat color to flat color).
 *
 * Distribution reads like fire: blocks on the stroke's INNER edge (nearer
 * the glyph's center) run hotter, the outer edge cools toward ember, with
 * a small deterministic jitter so the ring never bands cleanly. The same
 * function drives the server-rendered static ramp (what reduced-motion
 * and no-JS see) and seeds the client's slow shade-swapping.
 *
 * The navbar wordmark 0 stays solid amber — the smolder is the hero's.
 */
// Runtime colors live in CSS vars --smolder-0..4 (globals.css) so the ramp
// flips with the theme (paper gets the darker ember set). This array is the
// phosphor reference.
export const SMOLDER_RAMP = [
  "#7A4A00", // deep ember
  "#B87A00",
  "#FFBB00", // brand amber
  "#FFD24D",
  "#FFF3D6", // near-white
] as const;

/** Shade index (0–4) for a block at row r, col c of a rows×cols glyph. */
export function smolderShade(
  r: number,
  c: number,
  rows: number,
  cols: number,
): number {
  const dy = (r - (rows - 1) / 2) / (rows / 2);
  const dx = (c - (cols - 1) / 2) / (cols / 2);
  const d = Math.min(1, Math.hypot(dx, dy)); // 0 center → 1 outer edge
  // The glyph is a ring, so d spans roughly 0.7–1: normalize that band so
  // inner-edge blocks glow (3–4) and outer-edge blocks ember (0–1).
  const heat = Math.max(0, Math.min(1, (1 - d) / 0.3));
  const jitter = ((r * 31 + c * 17) % 3) - 1; // -1 | 0 | +1, deterministic
  const idx = Math.round(heat * 4) + jitter;
  return Math.max(0, Math.min(4, idx));
}
