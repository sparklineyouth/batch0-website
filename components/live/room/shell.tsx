"use client";
import { useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { ArrowLeft, Users, X } from "lucide-react";
import { formatElapsed } from "./logic";
import { FOCUS, Spinner } from "./ui";

/**
 * The full-viewport call surface: top bar, main region (stage + side panel),
 * pinned control bar. Fixed above the dashboard chrome (z-60) without changing
 * the URL. The side panel is a 360px column on desktop and a bottom sheet on
 * phones that stops above the control bar; toasts sit in the main region, so
 * nothing but the bar's own popovers ever covers the bar.
 */
export function RoomShell({
  top,
  children,
  panel,
  panelOpen = false,
  onClosePanel,
  controls,
  toasts,
}: {
  top: ReactNode;
  children: ReactNode;
  panel?: ReactNode;
  panelOpen?: boolean;
  onClosePanel?: () => void;
  controls?: ReactNode;
  toasts?: ReactNode;
}) {
  // No page scroll behind the room.
  useEffect(() => {
    const html = document.documentElement;
    const prev = html.style.overflow;
    html.style.overflow = "hidden";
    return () => {
      html.style.overflow = prev;
    };
  }, []);

  return (
    <div
      className="fixed inset-0 z-[60] flex flex-col bg-[#0c0c0e] font-sans text-[#f4f4f5]"
      style={{ colorScheme: "dark" }}
      data-testid="room-shell"
    >
      {top}
      <div className="relative flex min-h-0 flex-1" data-testid="room-main">
        <div className="relative min-h-0 min-w-0 flex-1 px-2 pb-2 sm:px-3 sm:pb-3">{children}</div>
        {panel ? (
          <aside
            className={`${
              panelOpen ? "flex" : "hidden"
            } absolute inset-x-0 bottom-0 top-[12%] z-20 flex-col overflow-hidden rounded-t-md border-t border-[#26262b] bg-[#141416] lg:static lg:inset-auto lg:z-auto lg:mb-3 lg:mr-3 lg:w-[360px] lg:shrink-0 lg:rounded-md lg:border lg:border-[#26262b]`}
            aria-label="Side panel"
            data-testid="side-panel"
          >
            <div className="flex h-9 shrink-0 items-center justify-end border-b border-[#26262b] px-1.5 lg:hidden">
              <button
                type="button"
                aria-label="Close panel"
                onClick={onClosePanel}
                className={`rounded p-1.5 text-[#a1a1aa] hover:bg-[#26262b] hover:text-[#fff] ${FOCUS}`}
                data-testid="side-panel-close"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="min-h-0 flex-1">{panel}</div>
          </aside>
        ) : null}
        {toasts}
      </div>
      {controls ? (
        <footer
          className="relative z-40 h-[calc(64px+env(safe-area-inset-bottom))] shrink-0 border-t border-[#1d1d21] bg-[#0c0c0e] pb-[env(safe-area-inset-bottom)] sm:h-[calc(72px+env(safe-area-inset-bottom))]"
          data-testid="room-controls"
        >
          {controls}
        </footer>
      ) : null}
    </div>
  );
}

export function TopBar({
  title,
  backHref,
  live,
  rec,
  since,
  audienceCount,
  role,
  connecting,
}: {
  title: string;
  /** A back link (green room and after the call). */
  backHref?: string | null;
  live: boolean;
  /** Recording now: by whom (null when unknown). */
  rec: { by: string | null } | null;
  /** Elapsed timer start (ISO or epoch ms). */
  since: string | number | null;
  audienceCount?: number | null;
  /** "Hosting" / "Watching" chip (webinars). */
  role?: string | null;
  connecting?: boolean;
}) {
  return (
    <header
      className="flex h-[calc(48px+env(safe-area-inset-top))] shrink-0 items-center gap-2 px-3 pt-[env(safe-area-inset-top)] sm:h-[calc(56px+env(safe-area-inset-top))] sm:gap-3 sm:px-4"
      data-testid="room-top"
    >
      {backHref ? (
        <Link
          href={backHref}
          aria-label="Back"
          className={`-ml-1 grid h-9 w-9 shrink-0 place-items-center rounded-md text-[#d4d4d8] hover:bg-[#26262b] hover:text-[#fff] ${FOCUS}`}
          data-testid="room-back"
        >
          <ArrowLeft className="h-5 w-5" />
        </Link>
      ) : null}
      {title ? (
        <h1 className="min-w-0 truncate text-sm font-medium text-[#f4f4f5] sm:text-base" title={title}>
          {title}
        </h1>
      ) : null}
      {live ? (
        <span
          className="inline-flex shrink-0 items-center gap-1.5 rounded bg-[#e5484d] px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-[#fff]"
          data-testid="badge-live"
        >
          Live
        </span>
      ) : null}
      {rec ? (
        <span
          className="inline-flex shrink-0 items-center gap-1.5 rounded border border-[#5c2a2c] bg-[#2a1416] px-1.5 py-0.5 text-[11px] text-[#ffd1d2]"
          title={rec.by ? `Recording by ${rec.by}` : "Recording"}
          data-testid="badge-rec"
        >
          <span className="h-2 w-2 rounded-full bg-[#e5484d]" aria-hidden />
          <span className="hidden sm:inline">Recording</span>
          <span className="sm:hidden">REC</span>
          {rec.by ? <span className="hidden text-[#c4a0a1] md:inline">· {rec.by}</span> : null}
        </span>
      ) : null}
      {since ? <Elapsed since={since} /> : null}
      <div className="flex-1" />
      {connecting ? (
        <span className="inline-flex shrink-0 items-center gap-1.5 text-xs text-[#a1a1aa]" data-testid="badge-connecting">
          <Spinner className="h-3.5 w-3.5" /> <span className="hidden sm:inline">Connecting…</span>
        </span>
      ) : null}
      {audienceCount != null ? (
        <span
          className="inline-flex shrink-0 items-center gap-1.5 text-xs text-[#d4d4d8]"
          title={`${audienceCount} watching`}
          data-testid="badge-audience"
        >
          <Users className="h-4 w-4" aria-hidden />
          {audienceCount}
          <span className="sr-only"> watching</span>
        </span>
      ) : null}
      {role ? (
        <span className="hidden shrink-0 rounded border border-[#34343a] px-1.5 py-0.5 text-[11px] text-[#a1a1aa] sm:inline">
          {role}
        </span>
      ) : null}
    </header>
  );
}

/** "12:40" since a start time. A leaf with its own 1s timer. */
function Elapsed({ since }: { since: string | number }) {
  const start = typeof since === "number" ? since : Date.parse(since);
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  if (now === null || !Number.isFinite(start)) return null;
  return (
    <span className="shrink-0 text-xs tabular-nums text-[#a1a1aa]" data-testid="badge-elapsed">
      {formatElapsed(now - start)}
    </span>
  );
}
