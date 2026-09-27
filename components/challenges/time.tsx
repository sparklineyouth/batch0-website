"use client";
import { useEffect, useState } from "react";
import {
  challengePhase,
  formatRemaining,
  PHASE_LABELS,
  type Challenge,
  type ChallengePhase,
} from "@/lib/challenges-shared";

// ---------------------------------------------------------------------------
// Time-dependent bits of the challenge pages.
//
// The index is prerendered and the event page can sit open for hours, so
// anything that depends on "now" (a countdown, whether it's Live or Ended, the
// viewer's own time zone) renders a stable server value first and then
// recomputes in the browser. Same contract as <LocalTime>: SSR output matches
// the first client paint, the real value swaps in after hydration.
// ---------------------------------------------------------------------------

/** Re-render every `everyMs` so relative times stay true. */
function useNow(everyMs: number, initial: number | null = null) {
  const [now, setNow] = useState<number | null>(initial);
  useEffect(() => {
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(t);
  }, [everyMs]);
  return now;
}

/** Month/day tile, Luma-style, in the viewer's zone. */
export function DateTile({ iso, className = "" }: { iso: string | null; className?: string }) {
  const [parts, setParts] = useState<{ m: string; d: string }>(() => stableParts(iso));
  useEffect(() => {
    if (!iso) return;
    const dt = new Date(iso);
    setParts({
      m: dt.toLocaleString(undefined, { month: "short" }).toUpperCase(),
      d: String(dt.getDate()),
    });
  }, [iso]);
  return (
    <div
      className={`flex h-11 w-11 shrink-0 flex-col overflow-hidden rounded-md border border-line bg-paper text-center ${className}`}
      aria-hidden
    >
      <span className="bg-wash py-[1px] font-mono text-[9px] font-semibold tracking-[0.12em] text-ink-faint">
        {parts.m}
      </span>
      <span className="flex flex-1 items-center justify-center font-mono text-[16px] font-semibold leading-none text-ink">
        {parts.d}
      </span>
    </div>
  );
}

function stableParts(iso: string | null) {
  if (!iso) return { m: "TBA", d: "—" };
  const dt = new Date(iso);
  return {
    m: dt.toLocaleString("en-US", { month: "short", timeZone: "UTC" }).toUpperCase(),
    d: String(dt.getUTCDate()),
  };
}

const LONG_DATE: Intl.DateTimeFormatOptions = {
  weekday: "long",
  month: "long",
  day: "numeric",
};
const SHORT_DT: Intl.DateTimeFormatOptions = {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
};

/**
 * The two lines next to the date tile:
 *   "Friday, October 3 → Sunday, October 5"
 *   "Submissions due Oct 5, 11:59 PM EDT"
 */
export function EventWhen({
  opensAt,
  closesAt,
}: {
  opensAt: string | null;
  closesAt: string | null;
}) {
  const fmt = (iso: string, opts: Intl.DateTimeFormatOptions, local: boolean) =>
    new Date(iso).toLocaleString(local ? undefined : "en-US", {
      ...opts,
      ...(local ? {} : { timeZone: "UTC" }),
    });
  const build = (local: boolean) => {
    if (!opensAt && !closesAt) {
      return { top: "Rolling — no deadline", bottom: "Submit whenever you're ready" };
    }
    const tz = local
      ? (new Intl.DateTimeFormat(undefined, { timeZoneName: "short" })
          .formatToParts(new Date(closesAt ?? opensAt!))
          .find((p) => p.type === "timeZoneName")?.value ?? "")
      : "UTC";
    if (opensAt && closesAt) {
      const a = fmt(opensAt, LONG_DATE, local);
      const b = fmt(closesAt, LONG_DATE, local);
      return {
        top: a === b ? a : `${a} → ${b}`,
        bottom: `Due ${fmt(closesAt, SHORT_DT, local)} ${tz}`.trim(),
      };
    }
    if (closesAt) {
      return {
        top: `Due ${fmt(closesAt, LONG_DATE, local)}`,
        bottom: `${fmt(closesAt, SHORT_DT, local)} ${tz}`.trim(),
      };
    }
    return {
      top: `Starts ${fmt(opensAt!, LONG_DATE, local)}`,
      bottom: `${fmt(opensAt!, SHORT_DT, local)} ${tz} · no deadline`.trim(),
    };
  };
  const [text, setText] = useState(() => build(false));
  useEffect(() => {
    setText(build(true));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opensAt, closesAt]);
  return (
    <div className="min-w-0" suppressHydrationWarning>
      <p className="truncate text-[15px] font-medium text-ink">{text.top}</p>
      <p className="truncate text-[13px] text-ink-soft">{text.bottom}</p>
    </div>
  );
}

/** "2d 4h" until `to`, ticking. Renders `ended` once it passes. */
export function Countdown({
  to,
  ended = "Closed",
  className = "",
}: {
  to: string;
  ended?: string;
  className?: string;
}) {
  const now = useNow(30_000);
  if (now == null) return <span className={className}>&nbsp;</span>;
  const left = new Date(to).getTime() - now;
  return (
    <span className={`tabular-nums ${className}`}>
      {left > 0 ? formatRemaining(left) : ended}
    </span>
  );
}

type PhaseInput = Pick<
  Challenge,
  "status" | "opensAt" | "closesAt" | "resultsAt" | "winnersPublished"
>;

const PHASE_STYLES: Record<ChallengePhase, string> = {
  live: "bg-phosphor text-on-phosphor",
  upcoming: "border border-line bg-paper text-ink",
  judging: "border border-line bg-wash text-ink-soft",
  ended: "border border-line bg-wash text-ink-faint",
  draft: "border border-dashed border-line text-ink-faint",
  archived: "border border-line text-ink-faint",
};

/** Live / Upcoming / Judging / Ended — recomputed in the browser. */
export function PhasePill({
  challenge,
  initial,
  withCountdown = false,
}: {
  challenge: PhaseInput;
  /** Phase at render time on the server (keeps SSR and first paint equal). */
  initial: ChallengePhase;
  withCountdown?: boolean;
}) {
  const now = useNow(60_000);
  const phase = now == null ? initial : challengePhase(challenge, now);
  const target =
    phase === "live" ? challenge.closesAt : phase === "upcoming" ? challenge.opensAt : null;
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 font-mono text-[11px] font-semibold uppercase tracking-[0.12em] ${PHASE_STYLES[phase]}`}
    >
      {phase === "live" && (
        <span className="h-1.5 w-1.5 rounded-full bg-on-phosphor" aria-hidden />
      )}
      {PHASE_LABELS[phase]}
      {withCountdown && target && now != null && (
        <span className="font-medium normal-case tracking-normal opacity-80">
          · {phase === "live" ? "closes in" : "opens in"}{" "}
          {formatRemaining(new Date(target).getTime() - now)}
        </span>
      )}
    </span>
  );
}
