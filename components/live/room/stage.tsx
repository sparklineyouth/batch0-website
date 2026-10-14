"use client";
import { useRef, type ReactNode } from "react";
import { ChevronLeft, ChevronRight, FileText, MonitorUp } from "lucide-react";
import type { DeckEngine } from "./deck/deck-engine";
import { fitRect } from "./logic";
import { gridShape, type StageModel, type StageTile } from "./stage-model";
import { Tile, type TileVariant } from "./tile";
import { FOCUS } from "./ui";
import { useDeckSnapshot } from "./use-presentation";
import { useMediaQuery, useSize } from "./use-size";

/** Touch screens: tile actions (pin, full screen) are always shown, not on hover. */
const TOUCH_QUERY = "(hover: none)";
/** Below the tile's action row (top-1.5 + h-7) with a little air. */
const BELOW_ACTIONS = 42;

/** How one tile is drawn: the room resolves streams and state for the stage. */
export type TileView = {
  stream: MediaStream | null;
  audio: MediaStream | null;
  showVideo: boolean;
  micOff: boolean;
  reconnecting: boolean;
  mirror: boolean;
  badge: string | null;
};

const FILM_GAP = 8;

/**
 * The stage: main tile (or grid, or a notice), self PiP, filmstrip. The
 * filmstrip is a right-hand column when the stage is wide, a scrolling row
 * underneath when it is narrow (phones, or a desktop with the panel open).
 */
export function Stage({
  model,
  view,
  onPin,
  pinForEveryone,
  selfMain,
  selfThumb,
  empty,
  overlay,
  notices,
}: {
  model: StageModel;
  view: (tile: StageTile) => TileView;
  /** Toggle this viewer's local pin. */
  onPin: (key: string) => void;
  /** Webinar staff: "Pin for everyone" on host cameras that aren't primary. */
  pinForEveryone?: ((peerId: string) => void) | null;
  /** The presenter's own view when their presentation is main. */
  selfMain: ReactNode;
  /** Self presentation in the filmstrip (screen: a card, never a mirror). */
  selfThumb: (tile: StageTile) => ReactNode | null;
  /** Shown when nobody is on stage. */
  empty: ReactNode;
  /** Veils and reactions: drawn over the main area, never over the filmstrip. */
  overlay?: ReactNode;
  /**
   * Banners, chips ("Reconnecting…", "Waiting for Ana to join") and toasts:
   * stacked in one column at the top of the main area, so they never overlap
   * each other, the filmstrip or the control bar. Each interactive child sets
   * its own pointer-events.
   */
  notices?: ReactNode;
}) {
  const root = useRef<HTMLDivElement>(null);
  const mainRef = useRef<HTMLDivElement>(null);
  const size = useSize(root);
  const hasFilm = model.filmstrip.length > 0;
  const column = size.w >= 720 && size.w / Math.max(1, size.h) >= 1.15;
  const filmW = Math.round(Math.min(240, Math.max(150, size.w * 0.17)));
  const filmH = size.w < 480 ? 72 : 96;

  // The main area is measured itself, so a full-screen stage lays out for the screen.
  const mainSize = useSize(mainRef);
  const mainW = mainSize.w;
  const mainH = mainSize.h;
  const touch = useMediaQuery(TOUCH_QUERY);

  const tileFor = (t: StageTile, variant: TileVariant, extra?: { className?: string; style?: React.CSSProperties }) => {
    if (t.kind === "presentation" && t.isSelf && variant !== "main") {
      const thumb = selfThumb(t);
      if (thumb) return <div key={t.key} className={extra?.className} style={extra?.style}>{thumb}</div>;
    }
    const v = view(t);
    const pinned = model.pinned === t.key;
    return (
      <Tile
        key={t.key}
        testId={`tile-${variant}`}
        peerId={t.peerId}
        kind={t.kind}
        name={t.isSelf ? (t.kind === "presentation" ? "Your presentation" : `${t.name} (you)`) : t.name}
        stream={v.stream}
        audio={t.kind === "camera" ? v.audio : null}
        fit={t.kind === "presentation" ? "contain" : "cover"}
        showVideo={v.showVideo}
        mirror={v.mirror}
        micOff={t.kind === "camera" && v.micOff}
        reconnecting={v.reconnecting}
        variant={variant}
        badge={v.badge}
        pinned={pinned}
        onPin={() => onPin(t.key)}
        onPinForEveryone={
          pinForEveryone && t.kind === "camera" && !t.isPrimary
            ? () => pinForEveryone(t.peerId)
            : undefined
        }
        fullscreen={variant === "main" ? mainRef : null}
        className={extra?.className}
        style={extra?.style}
      />
    );
  };

  let main: ReactNode;
  // The main tile's box inside the main area (the PiP sits in its corner).
  let box = { x: 0, y: 0, w: mainW, h: mainH };
  // Where tiles with action buttons start (top), when any are on the main area.
  let tilesTop: number | null = null;
  if (model.layout === "empty") {
    main = <div className="absolute inset-0 grid place-items-center">{empty}</div>;
  } else if (model.layout === "grid") {
    const shape = gridShape(model.grid.length, mainW, mainH, 8);
    const gridH = shape.rows * shape.tileHeight + (shape.rows - 1) * 8;
    tilesTop = Math.max(0, (mainH - gridH) / 2);
    main = (
      <div className="absolute inset-0 flex flex-wrap content-center items-center justify-center gap-2" data-testid="stage-grid">
        {model.grid.map((t) =>
          tileFor(t, "grid", {
            style: { width: shape.tileWidth, height: shape.tileHeight },
          }),
        )}
      </div>
    );
  } else if (model.main && model.selfView) {
    main = <div className="absolute inset-0">{selfMain}</div>;
  } else if (model.main) {
    const portrait = mainW < mainH;
    if (model.main.kind === "presentation" || portrait) {
      main = tileFor(model.main, "main", { className: "absolute inset-0" });
    } else {
      const r = fitRect(16, 9, mainW, mainH);
      box = r;
      main = tileFor(model.main, "main", {
        className: "absolute",
        style: { left: r.x, top: r.y, width: r.w, height: r.h },
      });
    }
    tilesTop = box.y;
  }
  // On touch screens the main tile's actions are always on screen: notices
  // start below them, so a tap meant for Pin or Full screen isn't hidden
  // under a chip (the notices column lets taps through).
  const noticesTop = touch && tilesTop !== null ? Math.round(tilesTop + BELOW_ACTIONS) : 8;

  const pipW = Math.round(Math.min(260, Math.max(112, box.w * 0.22)));
  const pipH = Math.round((pipW * 9) / 16);

  return (
    <div
      ref={root}
      className={`flex h-full w-full min-h-0 min-w-0 ${column ? "flex-row" : "flex-col"}`}
      style={{ gap: hasFilm ? FILM_GAP : 0 }}
      data-testid="stage"
      data-layout={model.layout}
      data-why={model.why}
    >
      <div ref={mainRef} className="relative min-h-0 min-w-0 flex-1 bg-[#0c0c0e]" data-testid="stage-main">
        {mainW > 0 ? main : null}
        {model.pip && mainW > 0 ? (
          <div
            className="absolute z-10 overflow-hidden rounded-md shadow-[0_4px_16px_rgba(0,0,0,0.5)] ring-1 ring-[#34343a]"
            style={{
              width: pipW,
              height: pipH,
              left: box.x + box.w - pipW - 8,
              top: box.y + box.h - pipH - 8,
            }}
            data-testid="stage-pip"
          >
            {tileFor(model.pip, "pip", { className: "absolute inset-0" })}
          </div>
        ) : null}
        {overlay}
        {notices ? (
          <div
            className="pointer-events-none absolute inset-x-0 z-[15] flex flex-col items-center gap-2 px-3"
            style={{ top: noticesTop }}
            data-testid="stage-notices"
          >
            {notices}
          </div>
        ) : null}
      </div>

      {hasFilm && (
        <div
          className={`flex shrink-0 ${
            column
              ? "flex-col overflow-y-auto overflow-x-hidden"
              : "flex-row overflow-x-auto overflow-y-hidden [scrollbar-width:thin]"
          }`}
          style={column ? { width: filmW } : { height: filmH }}
          data-testid="filmstrip"
          aria-label="Participants"
        >
          {/* Centred while it fits, scrolls when it doesn't. */}
          <div className={`flex gap-2 ${column ? "my-auto flex-col" : "mx-auto h-full flex-row"}`}>
            {model.filmstrip.map((t) =>
              tileFor(t, "film", {
                className: column ? "aspect-video w-full shrink-0" : "aspect-video h-full shrink-0",
              }),
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/** Self screen share in the filmstrip: a card, never the capture itself. */
export function PresentingThumb({ onStop }: { onStop?: () => void }) {
  return (
    <div className="grid h-full w-full place-items-center rounded-md border border-[#34343a] bg-[#1b1b1f] p-2 text-center">
      <div>
        <MonitorUp className="mx-auto h-4 w-4 text-[#FFBB00]" aria-hidden />
        <p className="mt-1 text-[11px] leading-tight text-[#f4f4f5]">You&rsquo;re presenting</p>
        {onStop ? (
          <button
            type="button"
            onClick={onStop}
            className="mt-1 text-[11px] text-[#ff8a8d] underline-offset-2 hover:underline"
          >
            Stop
          </button>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Self slides in the filmstrip, while another presentation holds the main
 * stage: where they are (n / N), previous / next and Stop, so the deck can
 * still be driven.
 */
export function PresentingDeckThumb({ deck, onStop }: { deck: DeckEngine; onStop: () => void }) {
  const snap = useDeckSnapshot(deck);
  const btn = `grid h-6 w-6 place-items-center rounded bg-[#26262b] text-[#f4f4f5] hover:bg-[#323238] disabled:opacity-40 ${FOCUS}`;
  return (
    <div
      className="flex h-full w-full flex-col justify-between rounded-md border border-[#34343a] bg-[#1b1b1f] p-1.5 text-[11px] leading-tight text-[#f4f4f5]"
      data-testid="deck-thumb"
    >
      <p className="flex min-w-0 items-center gap-1">
        <FileText className="h-3.5 w-3.5 shrink-0 text-[#FFBB00]" aria-hidden />
        <span className="truncate">Your slides</span>
        <span className="ml-auto shrink-0 tabular-nums text-[#a1a1aa]" data-testid="deck-thumb-counter">
          {snap.page}/{snap.count}
        </span>
      </p>
      <div className="flex items-center gap-1">
        <button
          type="button"
          className={btn}
          aria-label="Previous slide"
          onClick={deck.prev}
          disabled={snap.page <= 1}
          data-testid="deck-thumb-prev"
        >
          <ChevronLeft className="h-4 w-4" />
        </button>
        <button
          type="button"
          className={btn}
          aria-label="Next slide"
          onClick={deck.next}
          disabled={snap.page >= snap.count}
          data-testid="deck-thumb-next"
        >
          <ChevronRight className="h-4 w-4" />
        </button>
        <button
          type="button"
          onClick={onStop}
          className={`ml-auto rounded px-1 py-0.5 text-[11px] text-[#ff8a8d] underline-offset-2 hover:underline ${FOCUS}`}
          data-testid="deck-thumb-stop"
        >
          Stop
        </button>
      </div>
    </div>
  );
}
