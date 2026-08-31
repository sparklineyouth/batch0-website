import * as React from "react";

/**
 * Chart primitives for the admin dashboards.
 *
 * Server components — no "use client", no charting dependency. Everything here
 * renders as HTML/CSS or inline SVG, and the hover layer is pure CSS, so Pulse
 * stays an RSC page that ships zero JavaScript for its graphs.
 *
 * Two rules the marks follow, because breaking either is what made the old
 * Pulse bars invisible:
 *
 *  1. **A bar's height is a percentage of a parent that HAS a height.** The
 *     previous implementation put `height: 45%` on a bar inside an auto-height
 *     flex column; a percentage against an indefinite height resolves to
 *     `auto`, so every bar collapsed to nothing. The plot track below sets an
 *     explicit height and the bars are its direct children.
 *  2. **The container includes the axis band.** The track is sized for the
 *     plot; the labels live outside it. Fixing one height around both is what
 *     produces a card with a tiny nested scrollbar.
 *
 * Colors come from CSS custom properties defined in app/globals.css (`--viz-*`),
 * which carry separate light and dark steps. Both sets were checked with the
 * data-viz validator against this app's actual card surface (`--wash`:
 * #f7f7f5 light, #18181b dark) rather than eyeballed. In light mode the amber
 * and aqua series sit below 3:1 against the wash, which obliges visible relief:
 * every chart here ships direct value labels and a table view, so no value is
 * ever carried by color alone.
 */

// ---------------------------------------------------------------------------
// Shared chrome
// ---------------------------------------------------------------------------

export type Series = "apps" | "revenue" | "engagement";

const SERIES_VAR: Record<Series, string> = {
  apps: "var(--viz-apps)",
  revenue: "var(--viz-revenue)",
  engagement: "var(--viz-engagement)",
};

function ChartFrame({
  title,
  subtitle,
  aside,
  children,
  table,
}: {
  title: string;
  subtitle?: string;
  aside?: React.ReactNode;
  children: React.ReactNode;
  table?: React.ReactNode;
}) {
  return (
    <figure className="m-0">
      <figcaption className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h3 className="text-sm font-semibold uppercase tracking-wider text-ink-soft">
          {title}
        </h3>
        {aside}
        {subtitle && (
          <p className="w-full text-xs text-ink-faint">{subtitle}</p>
        )}
      </figcaption>
      {children}
      {table}
    </figure>
  );
}

/**
 * The table-view twin every chart carries.
 *
 * Collapsed by default so it doesn't compete with the graph, but present on
 * the page rather than behind a tooltip — a tooltip is an enhancement, never
 * the only route to a value. `<details>` gets this for free with no JS.
 */
function TableView({
  columns,
  rows,
}: {
  columns: string[];
  rows: (string | number)[][];
}) {
  return (
    <details className="group mt-3">
      <summary className="cursor-pointer list-none text-[11px] uppercase tracking-wider text-ink-faint hover:text-ink-soft">
        <span className="inline-block transition-transform group-open:rotate-90">
          ▸
        </span>{" "}
        Table view
      </summary>
      <div className="mt-2 overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-line text-left text-ink-faint">
              {columns.map((c, i) => (
                <th
                  key={c}
                  scope="col"
                  className={`py-1.5 font-medium ${i === 0 ? "" : "text-right"}`}
                >
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} className="border-b border-line/60 last:border-0">
                {r.map((cell, j) => (
                  <td
                    key={j}
                    className={`py-1.5 tabular-nums text-ink-soft ${
                      j === 0 ? "" : "text-right"
                    }`}
                  >
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

/** Rounded to a friendly step so the top gridline isn't an arbitrary number. */
function niceMax(value: number): number {
  if (value <= 0) return 1;
  const mag = 10 ** Math.floor(Math.log10(value));
  for (const step of [1, 2, 2.5, 5, 10]) {
    const candidate = step * mag;
    if (candidate >= value) return candidate;
  }
  return 10 * mag;
}

// ---------------------------------------------------------------------------
// Bar chart
// ---------------------------------------------------------------------------

export type BarPoint = { key: string; label: string; value: number };

/**
 * Vertical bars for a single series over discrete time buckets.
 *
 * Labels are selective by design — the largest bar and the most recent one
 * carry a printed value, and the rest are reachable on hover and in the table.
 * A number floating over every bar is noise that goes unread, and with eight
 * buckets it also collides at mobile widths.
 */
export function BarChart({
  title,
  subtitle,
  data,
  series,
  format,
  aside,
  plotHeight = 140,
  columns = ["Week of", "Value"],
}: {
  title: string;
  subtitle?: string;
  data: BarPoint[];
  series: Series;
  format: (n: number) => string;
  aside?: React.ReactNode;
  plotHeight?: number;
  /** Table-view headers. Defaults suit a weekly series. */
  columns?: [string, string];
}) {
  const values = data.map((d) => d.value);
  const peak = Math.max(0, ...values);
  const max = niceMax(peak);
  const total = values.reduce((s, v) => s + v, 0);
  const maxIndex = values.lastIndexOf(peak);
  const lastIndex = data.length - 1;

  return (
    <ChartFrame
      title={title}
      subtitle={subtitle}
      aside={aside}
      table={
        <TableView
          columns={columns}
          rows={data.map((d) => [d.label, format(d.value)])}
        />
      }
    >
      {total === 0 ? (
        <EmptyPlot height={plotHeight} />
      ) : (
        <div className="mt-5">
          {/* Plot track. The explicit height is what the bars' percentages
              resolve against — without it they collapse. `relative` anchors
              the gridlines. */}
          {/* The top gridline's value. Without it the grid is decoration —
              a reader can see one bar is twice another but not what either is.
              One label, not a full axis: the scale is a reference, not the
              subject. */}
          <div className="mb-1 text-[10px] tabular-nums text-ink-faint">
            {format(max)}
          </div>
          <div
            className="relative flex items-end gap-[2px]"
            style={{ height: plotHeight }}
          >
            {/* Recessive hairline grid: solid, one shade off the surface.
                aria-hidden because the values live in the labels and table. */}
            <div className="pointer-events-none absolute inset-0" aria-hidden>
              {[0, 0.5, 1].map((f) => (
                <div
                  key={f}
                  className="absolute inset-x-0 border-t border-line"
                  style={{ bottom: `${f * 100}%` }}
                />
              ))}
            </div>

            {data.map((d, i) => {
              const heightPct = max > 0 ? (d.value / max) * 100 : 0;
              const showLabel = i === maxIndex || i === lastIndex;
              return (
                <div
                  key={d.key}
                  // h-full makes the whole column the hover target, so hovering
                  // doesn't require landing on a 6px-tall bar.
                  className="group relative flex h-full flex-1 items-end"
                >
                  <div
                    className="w-full rounded-t-[4px] transition-[filter] group-hover:brightness-110"
                    style={{
                      // A zero week must read as zero, not as a 2px stub that
                      // looks like a small value. Only non-zero values get the
                      // 3px floor that keeps a tiny bar visible.
                      height:
                        d.value === 0
                          ? 0
                          : `max(3px, ${heightPct.toFixed(2)}%)`,
                      background: SERIES_VAR[series],
                    }}
                  />
                  {showLabel && d.value > 0 && (
                    // `bottom` ONLY. Setting `top` as well would stretch the
                    // span between both edges and float the text at the top of
                    // the plot instead of sitting it on the bar.
                    <span
                      className="pointer-events-none absolute inset-x-0 text-center text-[10px] tabular-nums text-ink-soft"
                      style={{
                        bottom: `calc(max(3px, ${heightPct.toFixed(2)}%) + 3px)`,
                      }}
                    >
                      {format(d.value)}
                    </span>
                  )}
                  <Tooltip>
                    {d.label} · {format(d.value)}
                  </Tooltip>
                </div>
              );
            })}
          </div>

          {/* Axis band — outside the fixed-height track on purpose. */}
          <AxisBand data={data} />
        </div>
      )}
    </ChartFrame>
  );
}

// ---------------------------------------------------------------------------
// Trend line
// ---------------------------------------------------------------------------

/**
 * A percentage series over time, with an optional target rule.
 *
 * SVG rather than CSS bars because a rate reads as a continuous line, and
 * because the target line is the point of the chart — "are we above 70%?" is
 * answered by one glance at whether the line sits over the rule.
 *
 * `preserveAspectRatio="none"` lets the plot stretch to any card width;
 * `vector-effect="non-scaling-stroke"` stops that stretch from distorting the
 * stroke into a wedge. Every text label is HTML outside the SVG, so nothing
 * scales with the box.
 */
let trendGradientSeq = 0;

export function TrendLine({
  title,
  subtitle,
  data,
  target,
  aside,
  plotHeight = 120,
  columns = ["Week of", "Participation"],
}: {
  title: string;
  subtitle?: string;
  data: BarPoint[];
  /** Percentage target drawn as a hairline rule, e.g. 70. */
  target?: number;
  aside?: React.ReactNode;
  plotHeight?: number;
  /** Table-view headers. Defaults suit a weekly participation series. */
  columns?: [string, string];
}) {
  // Unique per instance so two TrendLines on one page don't share a <defs>
  // entry. A module counter rather than useId(): this is a server component,
  // and the id only has to be unique within the rendered document.
  const gradientId = `viz-trend-fill-${(trendGradientSeq += 1)}`;
  const n = data.length;
  // An all-zero series would draw a line pinned to the axis, half of it
  // clipped by the plot edge — which reads as a broken chart rather than as
  // "nobody checked in". Say the latter in words.
  const allZero = data.every((d) => d.value === 0);
  const hasData = n > 1 && !allZero;
  const x = (i: number) => (n === 1 ? 50 : (i / (n - 1)) * 100);
  const y = (v: number) => 100 - Math.max(0, Math.min(100, v));

  const linePath = data.map((d, i) => `${i === 0 ? "M" : "L"} ${x(i).toFixed(2)} ${y(d.value).toFixed(2)}`).join(" ");
  const areaPath = hasData
    ? `${linePath} L 100 100 L 0 100 Z`
    : "";
  const last = data[n - 1];

  return (
    <ChartFrame
      title={title}
      subtitle={subtitle}
      aside={aside}
      table={
        <TableView
          columns={columns}
          rows={data.map((d) => [d.label, `${d.value}%`])}
        />
      }
    >
      {!hasData ? (
        // One point is data, just not a line — say so rather than claiming
        // nothing was recorded.
        <EmptyPlot
          height={plotHeight}
          message={
            allZero && n > 1
              ? "No check-ins recorded in these 8 weeks."
              : n === 1
                ? `Only one week recorded so far — ${data[0].value}% on ${data[0].label}. A trend needs at least two.`
                : "Nothing recorded in this window yet."
          }
        />
      ) : (
        <div className="mt-5">
          <div className="relative" style={{ height: plotHeight }}>
            <div className="pointer-events-none absolute inset-0" aria-hidden>
              {[0, 0.5, 1].map((f) => (
                <div
                  key={f}
                  className="absolute inset-x-0 border-t border-line"
                  style={{ bottom: `${f * 100}%` }}
                />
              ))}
            </div>

            <svg
              viewBox="0 0 100 100"
              preserveAspectRatio="none"
              className="absolute inset-0 h-full w-full overflow-visible"
              role="img"
              aria-label={`${title}. Latest ${last.value}%.`}
            >
              <defs>
                <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                  <stop
                    offset="0%"
                    stopColor="var(--viz-engagement)"
                    stopOpacity="0.28"
                  />
                  <stop
                    offset="100%"
                    stopColor="var(--viz-engagement)"
                    stopOpacity="0.02"
                  />
                </linearGradient>
              </defs>
              <path d={areaPath} fill={`url(#${gradientId})`} />
              {target != null && (
                <line
                  x1="0"
                  x2="100"
                  y1={y(target)}
                  y2={y(target)}
                  stroke="var(--viz-target)"
                  strokeWidth="1"
                  vectorEffect="non-scaling-stroke"
                />
              )}
              <path
                d={linePath}
                fill="none"
                stroke="var(--viz-engagement)"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                vectorEffect="non-scaling-stroke"
              />
            </svg>

            {/* Markers and hit targets as HTML so they never scale with the
                viewBox — an SVG circle under preserveAspectRatio="none" would
                render as an ellipse. */}
            {data.map((d, i) => (
              <div
                key={d.key}
                className="group absolute top-0 h-full"
                style={{
                  left: `${x(i)}%`,
                  width: `${100 / n}%`,
                  transform: "translateX(-50%)",
                }}
              >
                <span
                  className="absolute h-2 w-2 rounded-full ring-2 opacity-0 transition-opacity group-hover:opacity-100"
                  style={{
                    left: "50%",
                    top: `${y(d.value)}%`,
                    transform: "translate(-50%, -50%)",
                    background: "var(--viz-engagement)",
                    // The 2px ring is the surface colour, so an overlapping
                    // marker reads as separate without drawing a border.
                    ["--tw-ring-color" as any]: "rgb(var(--wash))",
                  }}
                  aria-hidden
                />
                <Tooltip>
                  {d.label} · {d.value}%
                </Tooltip>
              </div>
            ))}

            {/* The endpoint is the one value worth printing without hover. */}
            <span
              className="pointer-events-none absolute text-[10px] font-medium tabular-nums text-ink"
              style={{ right: 0, top: `calc(${y(last.value)}% - 18px)` }}
            >
              {last.value}%
            </span>
          </div>

          <AxisBand data={data} />
          {target != null && (
            <p className="mt-2 flex items-center gap-1.5 text-[11px] text-ink-faint">
              <span
                className="inline-block h-px w-4"
                style={{ background: "var(--viz-target)" }}
                aria-hidden
              />
              {target}% target
            </p>
          )}
        </div>
      )}
    </ChartFrame>
  );
}

// ---------------------------------------------------------------------------
// Funnel
// ---------------------------------------------------------------------------

export type FunnelStage = { label: string; value: number; href?: string };

/**
 * Applicant funnel — horizontal bars on a shared scale, with the step-to-step
 * conversion printed between them.
 *
 * Horizontal because the stage names are words, and words in a vertical bar
 * chart end up rotated or truncated. The ordinal ramp (one hue, deepening with
 * stage) is the correct encoding for ordered categories: it says "these have a
 * sequence" without double-encoding the bar length as hue the way a
 * value-ramp on nominal categories would.
 *
 * The drop between stages is the actual product question — where applicants
 * are lost — so it's printed rather than left to be inferred from two lengths.
 */
export function Funnel({
  title,
  subtitle,
  stages,
}: {
  title: string;
  subtitle?: string;
  stages: FunnelStage[];
}) {
  const top = Math.max(1, stages[0]?.value ?? 0);
  return (
    <ChartFrame
      title={title}
      subtitle={subtitle}
      table={
        <TableView
          columns={["Stage", "Count", "% of first"]}
          rows={stages.map((s) => [
            s.label,
            s.value,
            `${Math.round((s.value / top) * 100)}%`,
          ])}
        />
      }
    >
      <ol className="mt-5 space-y-1">
        {stages.map((s, i) => {
          const widthPct = (s.value / top) * 100;
          const prev = i > 0 ? stages[i - 1].value : null;
          const conversion =
            prev && prev > 0 ? Math.round((s.value / prev) * 100) : null;
          const dropped = prev != null ? prev - s.value : 0;
          return (
            <li key={s.label}>
              {i > 0 && (
                <div className="flex items-center gap-2 py-1 pl-1 text-[10px] text-ink-faint">
                  <span aria-hidden>↓</span>
                  <span className="tabular-nums">
                    {conversion == null ? "—" : `${conversion}% continue`}
                  </span>
                  {dropped > 0 && (
                    <span className="tabular-nums">
                      · {dropped} dropped off
                    </span>
                  )}
                </div>
              )}
              <div className="flex items-center gap-3">
                <div className="w-28 shrink-0 text-xs text-ink-soft">
                  {s.label}
                </div>
                <div className="relative h-7 flex-1 overflow-hidden rounded-[4px] bg-line/40">
                  <div
                    className="h-full rounded-[4px]"
                    style={{
                      width: `max(3px, ${widthPct.toFixed(2)}%)`,
                      background: `var(--viz-funnel-${i + 1})`,
                    }}
                  />
                </div>
                <div className="w-10 shrink-0 text-right text-sm font-medium tabular-nums text-ink">
                  {s.value}
                </div>
              </div>
            </li>
          );
        })}
      </ol>
    </ChartFrame>
  );
}

// ---------------------------------------------------------------------------
// Small parts
// ---------------------------------------------------------------------------

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

/** CSS-only hover tooltip. No JS, so Pulse stays a server component. */
function Tooltip({ children }: { children: React.ReactNode }) {
  return (
    <span
      role="tooltip"
      className="pointer-events-none absolute -top-1 left-1/2 z-10 hidden -translate-x-1/2 -translate-y-full whitespace-nowrap rounded-md border border-line bg-paper px-2 py-1 text-[10px] tabular-nums text-ink shadow-cta group-hover:block"
    >
      {children}
    </span>
  );
}

/**
 * The x-axis label row.
 *
 * Every other label is dropped below the `sm` breakpoint. At a phone-width
 * card an eight-bucket axis gives each label a 36px column, and "Aug 25" at
 * 9px monospace measures exactly 36px — it fits, with zero slack, which is one
 * font fallback away from clipping. Thinning is the standard fix and keeps the
 * labels legible instead of merely present.
 *
 * The thinning counts back from the END so the most recent bucket always keeps
 * its label — it's the one a reader looks for. The column `<div>`s are always
 * rendered so the labels stay aligned with their bars either way.
 */
function AxisBand({ data }: { data: BarPoint[] }) {
  const last = data.length - 1;
  return (
    <div className="mt-2 flex gap-[2px] border-t border-line pt-1.5">
      {data.map((d, i) => {
        const alwaysShow = (last - i) % 2 === 0;
        return (
          <div key={d.key} className="min-w-0 flex-1 text-center">
            <span
              className={`text-[9px] tabular-nums ${
                alwaysShow ? "" : "hidden sm:inline"
              } ${i === last ? "text-ink-soft" : "text-ink-faint"}`}
            >
              {d.label}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function EmptyPlot({
  height,
  message = "Nothing recorded in this window yet.",
}: {
  height: number;
  message?: string;
}) {
  return (
    <div
      className="mt-5 flex items-center justify-center rounded-lg border border-dashed border-line px-4 text-center text-xs text-ink-faint"
      style={{ height }}
    >
      {message}
    </div>
  );
}
