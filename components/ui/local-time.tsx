"use client";
import { useEffect, useState } from "react";

type Mode = "date" | "datetime" | "time" | "datetime-short";

/**
 * Renders an ISO timestamp in the viewer's local timezone.
 *
 * Server components don't know the viewer's timezone, so calling
 * `new Date(iso).toLocaleString()` on the server formats with the
 * machine TZ (UTC on Vercel) — that's the "times look wrong" bug.
 * This component renders a stable UTC string on first paint so SSR
 * matches the initial client render, then swaps to the user's local
 * formatting after hydration.
 *
 * Always use this for any user-visible date/time. Use plain
 * `new Date(...).toLocaleDateString()` only for date-only values
 * that are intentionally rendered in UTC (e.g. cohort start dates,
 * which are stored as bare `date` columns and have no time zone).
 */
export function LocalTime({
  value,
  mode = "datetime",
  className,
  fallback = "—",
}: {
  value: string | Date | null | undefined;
  mode?: Mode;
  className?: string;
  fallback?: string;
}) {
  const initial = formatStable(value, mode);
  const [text, setText] = useState(initial);

  useEffect(() => {
    setText(formatLocal(value, mode) ?? fallback);
  }, [value, mode, fallback]);

  if (!value) {
    return <span className={className}>{fallback}</span>;
  }
  const iso = typeof value === "string" ? value : value.toISOString();
  return (
    <time dateTime={iso} className={className} suppressHydrationWarning>
      {text ?? fallback}
    </time>
  );
}

function toDate(value: string | Date | null | undefined): Date | null {
  if (!value) return null;
  const d = typeof value === "string" ? new Date(value) : value;
  return Number.isNaN(d.getTime()) ? null : d;
}

function optionsFor(mode: Mode): Intl.DateTimeFormatOptions {
  switch (mode) {
    case "date":
      return { year: "numeric", month: "short", day: "numeric" };
    case "time":
      return { hour: "numeric", minute: "2-digit" };
    case "datetime-short":
      return {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      };
    case "datetime":
    default:
      return {
        year: "numeric",
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      };
  }
}

function formatStable(
  value: string | Date | null | undefined,
  mode: Mode,
): string | null {
  const d = toDate(value);
  if (!d) return null;
  // UTC, deterministic — matches between server and first client paint.
  return d.toLocaleString("en-US", { ...optionsFor(mode), timeZone: "UTC" });
}

function formatLocal(
  value: string | Date | null | undefined,
  mode: Mode,
): string | null {
  const d = toDate(value);
  if (!d) return null;
  return d.toLocaleString(undefined, optionsFor(mode));
}
