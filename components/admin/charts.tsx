/**
 * Small data marks for admin pages. Server components, no charting dependency.
 *
 * Colors come from the `--viz-*` custom properties in app/globals.css, which
 * carry separate light and dark steps.
 */

export type Series = "apps" | "revenue" | "engagement";

const SERIES_VAR: Record<Series, string> = {
  apps: "var(--viz-apps)",
  revenue: "var(--viz-revenue)",
  engagement: "var(--viz-engagement)",
};

/**
 * A capacity meter. Not a chart — one number against a known ceiling, which is
 * a stat with a bar, and a one-bar bar chart would be the wrong form.
 */
export function Meter({
  value,
  max,
  tone = "apps",
}: {
  value: number;
  max: number | null;
  tone?: Series;
}) {
  if (!max || max <= 0) return null;
  const pct = Math.min(100, Math.round((value / max) * 100));
  return (
    <div
      className="h-1.5 w-24 overflow-hidden rounded-full bg-line/50"
      role="img"
      aria-label={`${value} of ${max}, ${pct}% full`}
    >
      <div
        className="h-full rounded-full"
        style={{
          width: `${pct}%`,
          // Near-full is a scheduling signal, not a series, so it takes the
          // status colour and never a categorical slot.
          background: pct >= 90 ? "var(--viz-warning)" : SERIES_VAR[tone],
        }}
      />
    </div>
  );
}
