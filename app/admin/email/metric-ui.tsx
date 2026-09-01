import * as React from "react";

/**
 * Presentational primitives for the email metrics page.
 *
 * Split out of page.tsx purely for length — the page reads as a sequence of
 * sections instead of a sequence of divs, and the streamed provider panels in
 * resend-panels.tsx can render the same tiles as the synchronous half without
 * either file importing the other's data.
 */

export type Tone = "default" | "ok" | "warn" | "bad" | "muted";

export const TONE_TEXT: Record<Tone, string> = {
  default: "text-ink",
  ok: "text-emerald-700 dark:text-emerald-300",
  warn: "text-amber-700 dark:text-amber-300",
  bad: "text-red-700 dark:text-red-300",
  muted: "text-ink-faint",
};

const TONE_CHIP: Record<Tone, string> = {
  default: "border-line bg-wash text-ink-soft",
  ok: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  warn: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
  bad: "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300",
  muted: "border-line bg-wash text-ink-faint",
};

export function SectionHeading({
  title,
  hint,
  action,
}: {
  title: string;
  hint?: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div className="mb-3 mt-10 flex flex-wrap items-end justify-between gap-2">
      <div>
        <h2 className="font-display text-lg font-semibold tracking-[-0.02em] text-ink">
          {title}
        </h2>
        {hint && <p className="mt-0.5 max-w-3xl text-xs text-ink-faint">{hint}</p>}
      </div>
      {action}
    </div>
  );
}

export function Chip({
  children,
  tone = "default",
  title,
}: {
  children: React.ReactNode;
  tone?: Tone;
  title?: string;
}) {
  return (
    <span
      title={title}
      className={`inline-flex items-center gap-1 rounded-lg border px-2 py-0.5 text-[11px] font-medium ${TONE_CHIP[tone]}`}
    >
      {children}
    </span>
  );
}

export function Tile({
  icon: Icon,
  label,
  value,
  hint,
  tone = "default",
}: {
  icon?: any;
  label: string;
  value: string;
  hint?: React.ReactNode;
  tone?: Tone;
}) {
  return (
    <div className="rounded-xl border border-line bg-wash px-4 py-4">
      <div className="flex items-center gap-2 text-[10px] font-medium uppercase tracking-[0.2em] text-ink-faint">
        {Icon && (
          <Icon
            className={`h-3.5 w-3.5 ${tone !== "default" ? TONE_TEXT[tone] : ""}`}
          />
        )}
        {label}
      </div>
      <div
        className={`mt-2 text-2xl font-semibold tabular-nums tracking-tight ${TONE_TEXT[tone]}`}
      >
        {value}
      </div>
      {hint && <div className="mt-1 text-[11px] leading-snug text-ink-faint">{hint}</div>}
    </div>
  );
}

/**
 * A horizontal share bar — used for the funnel, the client breakdown, and the
 * link table. One shape for "part of a whole" everywhere on the page, so a
 * reader learns to read it once.
 */
export function ShareBar({
  value,
  max,
  className = "bg-phosphor/60",
  label,
}: {
  value: number;
  max: number;
  className?: string;
  label?: string;
}) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  return (
    <div
      className="h-1.5 w-full overflow-hidden rounded-full bg-line/60"
      // A `role="img"` with no label is worse than no role at all — a screen
      // reader announces "image" and moves on. The numeric fallback is never
      // as good as the caller's own label, but it always says something.
      role="img"
      aria-label={label ?? `${value} of ${max}`}
    >
      {/* A zero-width bar is drawn as nothing, deliberately: a hairline floor
          reads as "a little" on a page whose job includes saying "none". */}
      <div className={`h-full rounded-full ${className}`} style={{ width: `${pct}%` }} />
    </div>
  );
}

/**
 * One bar of the daily chart.
 *
 * The floor applies only to NON-ZERO values, so a day with nothing sent draws
 * an empty column rather than a sliver — on a quiet week a sliver reads as "a
 * trickle went out" instead of "sending stopped", which is the single thing
 * this chart exists to make obvious.
 */
export function Bar({
  title,
  value,
  max,
  className,
}: {
  title: string;
  value: number;
  max: number;
  className: string;
}) {
  const pct = value > 0 ? Math.max(2, Math.round((value / max) * 100)) : 0;
  return (
    <div
      title={title}
      aria-hidden
      className={`min-w-[2px] flex-1 rounded-t ${className}`}
      style={{ height: `${pct}%` }}
    />
  );
}

export function LegendKey({
  color,
  label,
}: {
  color: string;
  label: string;
}) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={`inline-block h-2 w-2 rounded ${color}`} />
      {label}
    </span>
  );
}

export function EmptyNote({ children }: { children: React.ReactNode }) {
  return <p className="p-6 text-sm text-ink-soft">{children}</p>;
}

/** Table shell — every table on this page shares these borders and paddings. */
export function TableShell({
  head,
  children,
}: {
  head: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-line text-left text-xs uppercase tracking-wider text-ink-faint">
            {head}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

export function PanelSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div className="space-y-2 p-6" aria-busy>
      {Array.from({ length: rows }).map((_, i) => (
        <div
          key={i}
          className="h-3 animate-pulse rounded bg-line/70"
          style={{ width: `${90 - i * 12}%` }}
        />
      ))}
    </div>
  );
}
