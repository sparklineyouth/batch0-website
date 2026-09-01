/**
 * Axis scaling shared by both chart kits.
 *
 * `niceMax` was a private helper in components/admin/charts.tsx. The installed
 * app has its own chart kit (components/app/viz.tsx) for reasons documented
 * there, but "what number does the top gridline sit at" is not one of the
 * things the two kits should be free to disagree about — the same weekly
 * revenue series rendered on Pulse and on a phone would otherwise round to
 * different ceilings and read as different data.
 */

/**
 * Round a peak up to a friendly step so the top gridline isn't an arbitrary
 * number. Returns 1 for a non-positive peak, so an all-zero series still has a
 * usable denominator instead of dividing by zero.
 */
export function niceMax(value: number): number {
  if (value <= 0) return 1;
  const mag = 10 ** Math.floor(Math.log10(value));
  for (const step of [1, 2, 2.5, 5, 10]) {
    const candidate = step * mag;
    if (candidate >= value) return candidate;
  }
  return 10 * mag;
}
