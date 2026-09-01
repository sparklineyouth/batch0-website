import * as React from "react";
import Link from "next/link";

/**
 * The installed app's visualization vocabulary.
 *
 * A separate file from components/admin/charts.tsx, deliberately, for two
 * reasons that are both about what the admin kit *is* rather than about taste.
 *
 * It cannot be imported here. Every chart in that file wires a `TableView`
 * into `ChartFrame`'s internal `table` slot — a `<table>` inside an
 * `overflow-x-auto` div, with no public prop to turn it off. This app's whole
 * premise is that it never hands a phone a table to scroll sideways, and that
 * component is one `<summary>` tap from every chart. Worse, the admin kit's
 * only per-datum value channel is a CSS `:hover` tooltip, which does not exist
 * on touch: its bar chart prints a value on exactly two bars and its trend line
 * renders its markers at `opacity-0`, so on a phone most of the data is
 * reachable *only* through the table.
 *
 * It cannot be changed to allow it either. Three shipped admin pages depend on
 * it, and its header comment records why the table is there: `--viz-apps` and
 * `--viz-revenue` sit below 3:1 against the light wash, and the printed values
 * plus the table view are the compensating relief that makes that palette
 * defensible. Removing the table would degrade three working pages.
 *
 * So this kit takes the other branch, and pays for it up front:
 *
 *   **The palette is `--phosphor-ink`, not `--viz-*`.** That token is AA on
 *   both paper and wash in both themes, so no value is ever carried by a
 *   colour that fails contrast — which is what discharges the obligation the
 *   admin kit met with a table. Dropping the table without moving the palette
 *   would be an accessibility regression, not a restyle. It also keeps the
 *   product to one accent; a blue trend line beside a #FFBB00 tab bar would
 *   put a second hue on a surface whose identity is one accent on paper.
 *
 *   **`label` is required, and it renders as visible text.** Every primitive
 *   computes a summary sentence, puts it in a real `<figcaption>`, and points
 *   the mark at it with `aria-labelledby` — one text node, visible to everyone,
 *   referenced by the graphic, read once. A chart with no text alternative is
 *   strictly worse than the list it replaced, so the type system makes it
 *   impossible to add one without a label.
 *
 * House rules, all load-bearing:
 *
 *   No `"use client"`, no hooks, no hover layer. These are inline SVG and flex
 *   with server-computed values, so a screen full of graphs still ships zero
 *   client JavaScript.
 *
 *   No `sm:` / `md:` anywhere. The admin kit thins its axis labels at `sm:`,
 *   which is a 640px *viewport* query — but this app's column is pinned to
 *   `max-w-[32rem]` by AppShell and therefore never changes width, so the
 *   breakpoint is decoupled from the space it is meant to be measuring. Every
 *   primitive here is fluid instead.
 *
 *   The width budget every primitive is designed against: a 320px screen minus
 *   AppBody's `px-5` is 280px, and inside a card's `px-4` it is **248px**. At
 *   390px it is 318, at 430px it is 358, and it never exceeds 464px. Nothing
 *   here may have a fixed width.
 *
 *   No primitive carries its own heading — `Section` in frame.tsx owns that,
 *   and a second competing `<h3>` next to it is what makes a page look like two
 *   design systems.
 */

// Ids for aria-labelledby. A module counter rather than useId(): these are
// server components, useId() is not available to them, and an id only has to
// be unique within the rendered document. Same approach as the admin kit's
// gradient ids, for the same reason.
let vizSeq = 0;
function nextId(prefix: string) {
  vizSeq += 1;
  return `viz-${prefix}-${vizSeq}`;
}

const TONE: Record<"default" | "warn" | "good", string> = {
  default: "text-phosphor-ink",
  // The same amber/emerald pair Alert already owns in frame.tsx, so a warning
  // in a chart and a warning in a banner are the same colour.
  warn: "text-amber-600 dark:text-amber-300",
  good: "text-emerald-600 dark:text-emerald-300",
};

export type Tone = keyof typeof TONE;

/**
 * The caption every primitive renders, and the single source of the mark's
 * accessible name.
 *
 * `<figcaption>` rather than a `<p>`: it is the accessible name of the mark
 * beside it, and the figure/figcaption pairing is what makes that association
 * real rather than asserted.
 *
 * `summary` and `children` live in the SAME node on purpose. An earlier shape
 * had the visible caption as the `aria-labelledby` target and the full summary
 * in a separate `sr-only` span — which pointed the graphic at the short text
 * and left the long text floating as unattached content, so a screen-reader
 * user got the least informative half. Concatenating them means the name is
 * always complete, there is only ever one `<figcaption>` (a figure may not have
 * two), and the visible line stays short.
 */
function Caption({
  id,
  summary,
  children,
}: {
  id: string;
  /** The full sentence. Always in the accessible name; hidden when `children` is set. */
  summary: string;
  /** The short visible line. Omit to show the summary itself. */
  children?: React.ReactNode;
}) {
  return (
    <figcaption
      id={id}
      className="mt-2 text-[11.5px] leading-snug text-ink-faint"
    >
      {children ? (
        <>
          {children}
          <span className="sr-only"> {summary}</span>
        </>
      ) : (
        summary
      )}
    </figcaption>
  );
}

function pctOf(value: number, max: number) {
  if (max <= 0) return 0;
  return Math.round((value / max) * 100);
}

// ---------------------------------------------------------------------------
// Meter — one ratio, inline, in a row
// ---------------------------------------------------------------------------

/**
 * A ratio as a track and a count. The workhorse: it goes in `Row`'s `below`
 * slot and under module titles, where a chart card would be far too heavy.
 *
 * Two departures from the admin kit's Meter, both from real failures there.
 * It is full-width rather than `w-24`, because a fixed 96px track inside a
 * 248px card wastes 60% of the space it was given. And it never returns
 * `null` — the admin one bails when `max` is falsy, which silently removes an
 * element from a laid-out row and reads as a rendering bug rather than as an
 * absence of data. A missing cap says so in words.
 */
export function Meter({
  label,
  value,
  max,
  caption,
  tone = "default",
}: {
  /** What the ratio is of. Becomes the accessible name. */
  label: string;
  value: number;
  /** `null` means no known ceiling — rendered as a sentence, not a bar. */
  max: number | null;
  caption?: string;
  tone?: Tone;
}) {
  const id = nextId("meter");
  if (max == null || max <= 0) {
    return (
      <figure className="m-0">
        <Caption
          id={id}
          summary={
            max == null
              ? `${label}: ${value} so far, no target set.`
              : `${label}: nothing to do yet.`
          }
        />
      </figure>
    );
  }
  const pct = pctOf(value, max);
  const summary = `${label}: ${value} of ${max}, ${pct} percent.`;
  return (
    <figure className="m-0">
      <div className="flex items-center gap-2.5">
        {/* The track takes the remaining width; the count sits beside it and
            never inside it. The admin funnel prints values on top of a fill
            that darkens to #104281 by its fourth stage, where the text is
            unreadable — a number next to a bar is always legible. */}
        <div
          className="h-2 min-w-0 flex-1 overflow-hidden rounded-full bg-line/40"
          role="img"
          aria-labelledby={id}
        >
          <div
            className={`h-full rounded-full bg-current ${TONE[tone]}`}
            // A 0 must read as 0, not as a stub that looks like a small value;
            // anything non-zero gets a 3px floor so it stays visible.
            style={{ width: value === 0 ? 0 : `max(3px, ${pct}%)` }}
          />
        </div>
        <span className="shrink-0 font-mono text-[11.5px] tabular-nums text-ink-faint">
          {value}/{max}
        </span>
      </div>
      {/* The caption is the accessible name, so it is never optional — only
          its visibility is. With no caller text the summary shows; with caller
          text the summary rides along hidden, so the name stays complete. */}
      {caption ? (
        <Caption id={id} summary={summary}>
          {caption}
        </Caption>
      ) : (
        <figcaption id={id} className="sr-only">
          {summary}
        </figcaption>
      )}
    </figure>
  );
}

// ---------------------------------------------------------------------------
// Ring — one ratio, as the subject of a tile
// ---------------------------------------------------------------------------

/**
 * A ratio drawn as an arc, for when the ratio *is* the headline — a check-in
 * rate, course completion, an AI score.
 *
 * `pathLength={100}` is the trick that makes this fluid: it renormalises the
 * circle's length to 100 units regardless of its rendered radius, so
 * `strokeDasharray="{pct} 100"` is a literal percentage and the same component
 * is correct at 28px and at 72px with no arithmetic. The percentage text is
 * HTML centred over the box, never an SVG `<text>`, which would scale with the
 * viewBox and stop matching the app's type scale.
 *
 * The arc clamps at 100% but the printed ratio does not. A value over its own
 * maximum is a data bug, and a ring that silently renders it as "full" hides
 * exactly the thing worth seeing.
 */
export function Ring({
  label,
  value,
  max,
  caption,
  tone = "default",
  size = 72,
  unit = "%",
}: {
  label: string;
  value: number;
  max: number;
  caption?: string;
  tone?: Tone;
  /** 72 for a tile, 28 for an inline badge beside text. */
  size?: 28 | 72;
  /** What the centred figure means. `%` for a rate; "" to print the raw ratio. */
  unit?: "%" | "";
}) {
  const id = nextId("ring");
  const pct = pctOf(value, max);
  const arc = Math.max(0, Math.min(100, pct));
  const summary = `${label}: ${value} of ${max}, ${pct} percent.`;
  const centre = unit === "%" ? `${pct}%` : `${value}`;

  const mark = (
    <div
      className="relative shrink-0"
      style={{ width: size, height: size }}
      role="img"
      aria-labelledby={id}
    >
      <svg
        viewBox="0 0 36 36"
        className={`h-full w-full ${TONE[tone]}`}
        aria-hidden
      >
        <circle
          cx="18"
          cy="18"
          r="16"
          fill="none"
          stroke="rgb(var(--line))"
          strokeWidth="3"
        />
        {arc > 0 && (
          <circle
            cx="18"
            cy="18"
            r="16"
            fill="none"
            stroke="currentColor"
            strokeWidth="3"
            strokeLinecap="round"
            pathLength={100}
            strokeDasharray={`${arc} 100`}
            // Start the arc at twelve o'clock. Without this it starts at three,
            // which reads as an arbitrary offset rather than as a gauge.
            transform="rotate(-90 18 18)"
          />
        )}
      </svg>
      {size === 72 && (
        <span className="absolute inset-0 flex items-center justify-center text-[15px] font-semibold tabular-nums leading-none text-ink">
          {centre}
        </span>
      )}
    </div>
  );

  if (size === 28) {
    // Inline variant: the figure sits beside the ring rather than inside it —
    // 28px cannot hold legible text. The denominator is always printed, which
    // matters most for the AI score: it is a 1-to-10 scale, and every other
    // surface in the product shows the "/10".
    return (
      <figure className="m-0 flex items-center gap-2">
        {mark}
        <span className="font-mono text-[12px] tabular-nums text-ink-soft">
          {value}
          <span className="text-ink-faint">/{max}</span>
        </span>
        <figcaption id={id} className="sr-only">
          {summary}
        </figcaption>
      </figure>
    );
  }

  return (
    <figure className="m-0">
      {mark}
      {caption ? (
        <Caption id={id} summary={summary}>
          {caption}
        </Caption>
      ) : (
        <figcaption id={id} className="sr-only">
          {summary}
        </figcaption>
      )}
    </figure>
  );
}

// ---------------------------------------------------------------------------
// DotRail — cadence over a fixed window
// ---------------------------------------------------------------------------

export type RailCell = {
  key: string;
  /** Human label for this cell — "Aug 4". Used in the accessible summary. */
  label: string;
  state: "hit" | "miss" | "future";
};

/**
 * A fixed window of periods, each hit or missed. The habit loop, drawn.
 *
 * The caller MUST pass a reconstructed axis. A `.gte("week_start", …)` query
 * returns rows only for weeks that *have* a check-in, so absences come back as
 * missing rows rather than as false values — feed it raw query results and a
 * twelve-week window silently renders as a three-cell rail that looks like a
 * short history instead of a bad one. Generate every period from the calendar,
 * then mark the ones you found.
 *
 * Deliberately not tappable. Twelve cells across a 248px card is ~16px each,
 * far below any touch floor, so the rail is something you read and the drill-in
 * belongs to the row it sits in. Under four cells it degrades to a sentence:
 * three squares are not a pattern, they are a decoration.
 */
export function DotRail({
  label,
  cells,
  caption,
  tone = "default",
}: {
  label: string;
  cells: RailCell[];
  caption?: string;
  tone?: Tone;
}) {
  const id = nextId("rail");
  const past = cells.filter((c) => c.state !== "future");
  const hits = past.filter((c) => c.state === "hit").length;
  const misses = past.filter((c) => c.state === "miss");

  if (cells.length === 0) return null;

  // The summary names the gaps rather than counting them. For a screen-reader
  // user that naming IS the payload — "9 of 12" is a number they could already
  // get from the text, but "missed Aug 4 and Aug 11" is the thing the picture
  // actually shows, and without it this is a worse experience than the list it
  // replaced. Capped at three so it stays a sentence and not a table read out.
  const named = misses.slice(0, 3).map((m) => m.label);
  const summary =
    misses.length === 0
      ? `${label}: all ${past.length} on record.`
      : `${label}: ${hits} of ${past.length}. Missed ${named.join(", ")}${
          misses.length > named.length
            ? ` and ${misses.length - named.length} more`
            : ""
        }.`;

  if (cells.length < 4) {
    return (
      <figure className="m-0">
        <Caption id={id} summary={summary} />
      </figure>
    );
  }

  return (
    <figure className="m-0">
      <div className="flex gap-1" role="img" aria-labelledby={id}>
        {cells.map((c) => (
          <div
            key={c.key}
            className={`aspect-square min-w-0 flex-1 rounded-[3px] ${
              c.state === "hit"
                ? `bg-current ${TONE[tone]}`
                : c.state === "miss"
                  ? "bg-line/40"
                  : "border border-dashed border-line"
            }`}
          />
        ))}
      </div>
      <Caption id={id} summary={summary}>
        {caption}
      </Caption>
    </figure>
  );
}

// ---------------------------------------------------------------------------
// Spark — a series over time
// ---------------------------------------------------------------------------

export type SparkPoint = { key: string; label: string; value: number };

/**
 * A small line over a short window. For quantities where today's number alone
 * carries no information — revenue, weekly payments, open flags.
 *
 * Borrows the one genuinely good technique from the admin trend line:
 * `viewBox="0 0 100 100"` with `preserveAspectRatio="none"` stretches the plot
 * to any width, and `vectorEffect="non-scaling-stroke"` stops that stretch from
 * distorting the stroke into a wedge. Every text label is HTML outside the SVG,
 * so nothing scales with the box.
 *
 * What it drops, all because touch has no hover: no per-point markers, no
 * tooltip, and at most three axis labels at any width. What it fixes: the
 * endpoint value is an ordinary flex sibling on the caption line rather than an
 * absolutely-positioned span at `top: calc(y% - 18px)`, which floats outside
 * the plot when the last value is the peak.
 *
 * Default height 64. AppShell reserves 3.75rem for the tab bar, so anything
 * much taller pushes the following Section below the fold.
 */
export function Spark({
  label,
  points,
  format,
  caption,
  height = 64,
  tone = "default",
}: {
  label: string;
  points: SparkPoint[];
  format: (n: number) => string;
  caption?: string;
  height?: number;
  tone?: Tone;
}) {
  const id = nextId("spark");
  const n = points.length;
  const allZero = points.every((p) => p.value === 0);
  const hasLine = n > 1 && !allZero;

  if (n === 0) {
    return (
      <figure className="m-0">
        <Caption id={id} summary={`${label}: nothing recorded yet.`} />
      </figure>
    );
  }
  if (!hasLine) {
    // One point is data, just not a line — and an all-zero series drawn as a
    // line pinned to the axis reads as a broken chart rather than as "none".
    return (
      <figure className="m-0">
        <Caption
          id={id}
          summary={
            allZero && n > 1
              ? `${label}: nothing recorded across these ${n} periods.`
              : `${label}: ${format(points[0].value)} on ${points[0].label}. A trend needs at least two periods.`
          }
        />
      </figure>
    );
  }

  const peak = Math.max(...points.map((p) => p.value));
  const peakPoint = points[points.findIndex((p) => p.value === peak)];
  const last = points[n - 1];
  const x = (i: number) => (i / (n - 1)) * 100;
  // Scale against the peak, floored at 1 so a flat non-zero series still draws.
  const y = (v: number) => 100 - (v / Math.max(1, peak)) * 100;
  const line = points
    .map((p, i) => `${i === 0 ? "M" : "L"} ${x(i).toFixed(2)} ${y(p.value).toFixed(2)}`)
    .join(" ");
  const area = `${line} L 100 100 L 0 100 Z`;

  // First, peak and last — never every bucket. Enumerating all of them in the
  // label is a table read aloud, which is the thing this file exists to avoid.
  const summary = `${label}: ${format(points[0].value)} on ${points[0].label}, peaking at ${format(peak)} on ${peakPoint.label}, ${format(last.value)} in the latest period.`;

  // Three ticks at most, at both ends and the middle. With eight buckets in a
  // 248px card each label gets 31px, and a month/day stamp measures about that
  // — printing all of them is one font fallback away from collision.
  const ticks = [0, Math.floor((n - 1) / 2), n - 1];

  return (
    <figure className="m-0">
      <div
        className={`relative ${TONE[tone]}`}
        style={{ height }}
        role="img"
        aria-labelledby={id}
      >
        <svg
          viewBox="0 0 100 100"
          preserveAspectRatio="none"
          className="absolute inset-0 h-full w-full"
          aria-hidden
        >
          <path d={area} fill="currentColor" opacity="0.12" />
          <path
            d={line}
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
          />
        </svg>
      </div>
      <div className="mt-1.5 flex items-baseline justify-between gap-2 border-t border-line pt-1.5">
        {ticks.map((i, slot) => (
          <span
            key={points[i].key}
            className={`font-mono text-[9.5px] tabular-nums ${
              slot === 2 ? "text-ink-soft" : "text-ink-faint"
            }`}
          >
            {points[i].label}
          </span>
        ))}
      </div>
      <Caption id={id} summary={summary}>
        {caption ?? `${format(last.value)} latest · peak ${format(peak)}`}
      </Caption>
    </figure>
  );
}

// ---------------------------------------------------------------------------
// StageBars — an ordered pipeline
// ---------------------------------------------------------------------------

export type Stage = { key: string; label: string; value: number; href?: string };

/**
 * A funnel shaped for a phone.
 *
 * The admin funnel puts the stage name in a `w-28` column and the count in a
 * `w-10` one, which with its gaps spends 176px of fixed chrome and leaves a
 * 72px track inside a 248px card — the bar, which is the entire point, ends up
 * the smallest thing in the row. Here the label and count share line one and
 * the track gets all 248px on line two.
 *
 * The step-to-step conversion between stages is kept verbatim from the admin
 * kit; it is the best idea in that file and it is what turns a picture into an
 * answer, since "where are we losing people" is the actual question.
 *
 * One hue at stepped opacity rather than a four-colour ramp. The admin ramp is
 * four CSS variables, so a fifth stage resolves to an undefined var and renders
 * an invisible bar of the correct length — a silent, length-dependent failure.
 *
 * Contract, and it is a real one: each stage must be a SUBSET of the one above.
 * Feeding it disjoint counts — four current statuses, say — produces an
 * inverted funnel whose later bars are clipped at 100% by the track's overflow.
 */
export function StageBars({
  label,
  stages,
  caption,
}: {
  label: string;
  stages: Stage[];
  caption?: string;
}) {
  const id = nextId("stages");
  if (stages.length === 0) return null;
  const top = Math.max(1, stages[0].value);

  const summary = `${label}: ${stages
    .map((s, i) => {
      const prev = i > 0 ? stages[i - 1].value : null;
      const conv =
        prev && prev > 0 ? ` (${Math.round((s.value / prev) * 100)}% continue)` : "";
      return `${s.value} ${s.label}${conv}`;
    })
    .join(", ")}.`;

  return (
    <figure className="m-0">
      <ol className="m-0 list-none p-0" role="img" aria-labelledby={id}>
        {stages.map((s, i) => {
          const width = (s.value / top) * 100;
          const prev = i > 0 ? stages[i - 1].value : null;
          const conversion =
            prev && prev > 0 ? Math.round((s.value / prev) * 100) : null;
          const dropped = prev != null ? prev - s.value : 0;
          const body = (
            <>
              <div className="flex items-baseline justify-between gap-3">
                <span className="truncate text-[13px] text-ink-soft">
                  {s.label}
                </span>
                <span className="shrink-0 text-[14px] font-medium tabular-nums text-ink">
                  {s.value}
                </span>
              </div>
              <div className="mt-1.5 h-2.5 overflow-hidden rounded-full bg-line/40">
                <div
                  className="h-full rounded-full bg-phosphor-ink"
                  style={{
                    width: s.value === 0 ? 0 : `max(3px, ${width.toFixed(2)}%)`,
                    // Stepped opacity, not stepped hue: ordered categories want
                    // one colour deepening, and this cannot run out of steps.
                    opacity: 1 - Math.min(0.55, i * 0.14),
                  }}
                />
              </div>
            </>
          );
          return (
            <li key={s.key}>
              {i > 0 && (
                <div className="flex items-center gap-2 py-1.5 text-[10.5px] text-ink-faint">
                  <span aria-hidden>↓</span>
                  <span className="tabular-nums">
                    {conversion == null ? "—" : `${conversion}% continue`}
                  </span>
                  {dropped > 0 && (
                    <span className="tabular-nums">· {dropped} dropped off</span>
                  )}
                </div>
              )}
              {s.href ? (
                // Mirrors Row's pressed state so a tappable stage feels like
                // every other tappable thing in the app. ~48px tall, clearing
                // the touch floor.
                <Link
                  href={s.href}
                  className="press -mx-2 block rounded-lg px-2 py-1 active:bg-wash"
                >
                  {body}
                </Link>
              ) : (
                <div className="py-1">{body}</div>
              )}
            </li>
          );
        })}
      </ol>
      {caption ? (
        <Caption id={id} summary={summary}>
          {caption}
        </Caption>
      ) : (
        <figcaption id={id} className="sr-only">
          {summary}
        </figcaption>
      )}
    </figure>
  );
}
