"use client";
import { useEffect, useRef, useState } from "react";
import { AlertTriangle, ChevronLeft, ChevronRight, X } from "lucide-react";
import { useDeckSnapshot } from "../use-presentation";
import { RoomButton, Spinner, FOCUS } from "../ui";
import type { DeckEngine } from "./deck-engine";

/**
 * What a slide presenter sees: the current slide big (exactly what everyone
 * receives), next-slide preview, prev/next, n/N, and a thumbnails rail.
 * Keyboard (←/→, PgUp/PgDn, Space, Home/End, Esc) is handled by usePresentation.
 */
export function DeckPresenter({ deck, onStop }: { deck: DeckEngine; onStop: () => void }) {
  const snap = useDeckSnapshot(deck);
  const host = useRef<HTMLDivElement>(null);

  // Show the live output canvas itself — what viewers get, frame for frame.
  useEffect(() => {
    const el = host.current;
    const canvas = deck.canvas;
    if (!el) return;
    canvas.className = "block h-full w-full object-contain";
    canvas.setAttribute("role", "img");
    canvas.setAttribute("data-testid", "deck-canvas");
    el.appendChild(canvas);
    return () => {
      if (canvas.parentElement === el) el.removeChild(canvas);
    };
    // The canvas element is stable for the engine's life; the label updates below.
  }, [deck]);

  useEffect(() => {
    deck.canvas.setAttribute("aria-label", `Slide ${snap.page} of ${snap.count}`);
  }, [deck, snap.page, snap.count]);

  const atStart = snap.page <= 1;
  const atEnd = snap.page >= snap.count;

  return (
    <div className="flex h-full w-full min-h-0 flex-col gap-2" data-testid="deck-presenter">
      <div className="flex min-h-0 flex-1 gap-2">
        <div className="relative min-h-0 min-w-0 flex-1 overflow-hidden rounded-md bg-[#000]">
          <div ref={host} className="absolute inset-0" />
          {snap.pageError ? (
            <div
              className="absolute inset-x-2 top-2 flex items-center gap-2 rounded-md border border-[#4a3a12] bg-[#241d0c] px-3 py-2 text-sm text-[#ffe3a3] sm:inset-x-auto sm:right-2"
              role="alert"
              data-testid="deck-page-error"
            >
              <AlertTriangle className="h-4 w-4 shrink-0 text-[#ffb224]" aria-hidden />
              <span className="min-w-0 flex-1">{snap.pageError} Viewers still see the last one.</span>
              <button
                type="button"
                onClick={deck.retry}
                className={`shrink-0 rounded px-2 py-1 text-xs font-semibold text-[#FFBB00] hover:bg-[#3a2f12] ${FOCUS}`}
                data-testid="deck-retry"
              >
                Try again
              </button>
            </div>
          ) : !snap.drawn ? (
            <div className="pointer-events-none absolute right-2 top-2 rounded bg-[rgba(0,0,0,0.65)] p-1.5">
              <Spinner className="h-4 w-4 text-[#f4f4f5]" />
            </div>
          ) : null}
        </div>
        <aside className="hidden w-48 shrink-0 flex-col gap-2 lg:flex">
          <p className="text-xs text-[#a1a1aa]">Next</p>
          <div className="aspect-video w-full overflow-hidden rounded-md bg-[#000] ring-1 ring-[#34343a]">
            {!atEnd ? (
              <Thumb key={snap.deckId} deck={deck} page={snap.page + 1} />
            ) : (
              <p className="grid h-full place-items-center text-xs text-[#71717a]">End of deck</p>
            )}
          </div>
        </aside>
      </div>

      <div className="flex shrink-0 items-center gap-2">
        <RoomButton
          size="icon"
          variant="control"
          aria-label="Previous slide"
          onClick={deck.prev}
          disabled={atStart}
          data-testid="deck-prev"
        >
          <ChevronLeft className="h-5 w-5" />
        </RoomButton>
        <span className="min-w-[4.5rem] text-center text-sm tabular-nums text-[#f4f4f5]" data-testid="deck-counter">
          {snap.page} / {snap.count}
        </span>
        <RoomButton
          size="icon"
          variant="control"
          aria-label="Next slide"
          onClick={deck.next}
          disabled={atEnd}
          data-testid="deck-next"
        >
          <ChevronRight className="h-5 w-5" />
        </RoomButton>
        {snap.opening ? (
          <span
            className="flex min-w-0 flex-1 items-center gap-1.5 truncate text-xs text-[#a1a1aa]"
            data-testid="deck-opening"
          >
            <Spinner className="h-3.5 w-3.5 shrink-0" /> <span className="truncate">Opening {snap.opening}…</span>
          </span>
        ) : (
          <>
            <span className="hidden min-w-0 flex-1 truncate text-xs text-[#71717a] md:block">
              {snap.name} · ← → to move · Esc to stop
            </span>
            <span className="flex-1 md:hidden" />
          </>
        )}
        <RoomButton variant="subtle" size="md" onClick={onStop} data-testid="deck-stop">
          <X className="h-4 w-4" /> Stop
        </RoomButton>
      </div>

      <Rail key={snap.deckId} deck={deck} page={snap.page} count={snap.count} />
    </div>
  );
}

function Rail({ deck, page, count }: { deck: DeckEngine; page: number; count: number }) {
  const rail = useRef<HTMLDivElement>(null);
  // Keep the current slide in view.
  useEffect(() => {
    const el = rail.current?.querySelector<HTMLElement>(`[data-page="${page}"]`);
    el?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [page]);
  return (
    <div
      ref={rail}
      className="flex h-16 shrink-0 gap-1.5 overflow-x-auto pb-1 [scrollbar-width:thin] sm:h-20"
      data-testid="deck-rail"
      aria-label="Slides"
    >
      {Array.from({ length: count }, (_, i) => i + 1).map((n) => (
        <button
          key={n}
          type="button"
          data-page={n}
          onClick={() => deck.go(n)}
          aria-label={`Slide ${n}`}
          aria-current={n === page ? "true" : undefined}
          className={`relative aspect-video h-full shrink-0 overflow-hidden rounded bg-[#000] ${
            n === page ? "ring-2 ring-[#FFBB00]" : "ring-1 ring-[#34343a] hover:ring-[#71717a]"
          } ${FOCUS}`}
        >
          <LazyThumb deck={deck} page={n} root={rail} />
          <span className="absolute bottom-0.5 left-1 rounded bg-[rgba(0,0,0,0.6)] px-1 text-[10px] text-[#fff]">{n}</span>
        </button>
      ))}
    </div>
  );
}

/** Renders only once scrolled into view. */
function LazyThumb({
  deck,
  page,
  root,
}: {
  deck: DeckEngine;
  page: number;
  root: React.RefObject<HTMLDivElement | null>;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || visible) return;
    if (typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) setVisible(true);
      },
      { root: root.current, rootMargin: "0px 200px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [root, visible]);
  return (
    <span ref={ref} className="absolute inset-0">
      {visible ? <Thumb deck={deck} page={page} /> : null}
    </span>
  );
}

function Thumb({ deck, page }: { deck: DeckEngine; page: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    let live = true;
    void deck.thumbnail(page).then((frame) => {
      const c = ref.current;
      if (!live || !c || !frame) return;
      c.width = frame.width;
      c.height = frame.height;
      try {
        c.getContext("2d")?.drawImage(frame, 0, 0);
      } catch {
        /* frame closed meanwhile */
      }
    });
    return () => {
      live = false;
    };
  }, [deck, page]);
  return <canvas ref={ref} className="block h-full w-full object-contain" />;
}
