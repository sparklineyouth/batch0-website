"use client";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { DeckEngine, type DeckSnapshot } from "./deck/deck-engine";
import { useScreenShare } from "./use-screen-share";
import { deckKeyAction } from "./logic";

export type PresentationKind = "none" | "screen" | "deck";

/** The event's uploaded PDF deck (webinars), as a short-lived signed URL. */
export type EventDeck = { url: string; name: string };

export type PresentationController = {
  /** What is being presented. Screen share and slides are mutually exclusive. */
  kind: PresentationKind;
  /** Feed to useLiveSession's `screenStream` and the recorder. Null when not presenting. */
  stream: MediaStream | null;
  /** When the current presentation started (epoch ms). */
  startedAt: number | null;
  screenSupported: boolean;
  /** The browser's share picker is open. */
  screenPending: boolean;
  /** A deck is loading. */
  deckLoading: boolean;
  /** Call straight from the click handler (Safari needs the gesture). */
  startScreen: () => void;
  startDeck: (source: File | "event") => void;
  stop: () => void;
  eventDeck: EventDeck | null;
  /** The deck renderer (presenter view reads it). Null until slides are first opened. */
  deck: DeckEngine | null;
  error: string | null;
  clearError: () => void;
};

const IDLE_DECK: DeckSnapshot = {
  status: "idle",
  name: null,
  page: 1,
  count: 0,
  drawn: false,
  error: null,
  pageError: null,
  opening: null,
  deckId: 0,
};
const noop = () => () => {};

/** The deck's live state (page, count, status). */
export function useDeckSnapshot(deck: DeckEngine | null): DeckSnapshot {
  return useSyncExternalStore(
    deck ? deck.subscribe : noop,
    deck ? deck.getSnapshot : () => IDLE_DECK,
    () => IDLE_DECK,
  );
}

function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || !el.tagName) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable;
}

/**
 * One presentation state for the room: none, a screen share, or a PDF deck.
 * Starting one replaces the current one only once the new one is actually
 * running: a cancelled picker, or a PDF that fails to open, leaves whatever
 * was being presented (screen or slides) up. Another deck replaces a deck on
 * the same stream, so viewers' track never ends.
 */
export function usePresentation({
  enabled = true,
  eventDeck = null,
}: {
  /** False for people who never send media (webinar viewers). */
  enabled?: boolean;
  eventDeck?: EventDeck | null;
} = {}): PresentationController {
  const screen = useScreenShare();
  const { start: startShare, stop: stopShare, clearError: clearShareError } = screen;
  const [active, setActive] = useState<PresentationKind>("none");
  const [deck, setDeck] = useState<DeckEngine | null>(null);
  const [deckError, setDeckError] = useState<string | null>(null);
  const [deckLoading, setDeckLoading] = useState(false);
  const deckRef = useRef<DeckEngine | null>(null);
  const deckAttempt = useRef(0);
  const snap = useDeckSnapshot(deck);

  const engine = useCallback((): DeckEngine => {
    if (!deckRef.current) {
      deckRef.current = new DeckEngine();
      setDeck(deckRef.current);
    }
    return deckRef.current;
  }, []);

  // A share that started replaces the deck; one ended from the browser's bar ends the presentation.
  const screenStream = screen.stream;
  useEffect(() => {
    if (screenStream) {
      deckRef.current?.close();
      setActive("screen");
    } else {
      setActive((a) => (a === "screen" ? "none" : a));
    }
  }, [screenStream]);

  // The deck engine closing ends a deck presentation. (A replacement deck
  // loads with the status still "ready", and one that fails leaves it so.)
  useEffect(() => {
    if (snap.status !== "ready") setActive((a) => (a === "deck" ? "none" : a));
  }, [snap.status]);

  const startScreen = useCallback(() => {
    if (!enabled) return;
    setDeckError(null);
    void startShare();
  }, [enabled, startShare]);

  const startDeck = useCallback(
    (source: File | "event") => {
      if (!enabled) return;
      if (source === "event" && !eventDeck) return;
      setDeckError(null);
      clearShareError();
      setDeckLoading(true);
      const attempt = ++deckAttempt.current;
      const e = engine();
      void e
        .open(source === "event" ? { kind: "url", ...eventDeck! } : { kind: "file", file: source })
        .then((res) => {
          // A newer pick owns the spinner and the outcome.
          if (attempt !== deckAttempt.current) return;
          setDeckLoading(false);
          if (res.ok) {
            stopShare();
            setActive("deck");
          } else if (res.error) {
            setDeckError(res.error);
          }
        });
    },
    [enabled, engine, eventDeck, clearShareError, stopShare],
  );

  const stop = useCallback(() => {
    stopShare();
    deckAttempt.current++;
    setDeckLoading(false);
    deckRef.current?.close();
    setActive("none");
  }, [stopShare]);

  // Deck keyboard: ←/→/PgUp/PgDn/Space/Home/End, Esc stops. Never while typing.
  useEffect(() => {
    if (active !== "deck" || !deck) return;
    const onKey = (ev: KeyboardEvent) => {
      if (ev.defaultPrevented || ev.altKey || ev.ctrlKey || ev.metaKey || isTyping(ev.target)) return;
      const s = deck.getSnapshot();
      const action = deckKeyAction(ev.key, s.page, s.count);
      if (action === null) return;
      ev.preventDefault();
      if (action === "stop") stop();
      else deck.go(action);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, deck, stop]);

  // Unmount: drop the deck (the screen share stops itself).
  useEffect(() => () => deckRef.current?.close(), []);

  const stream =
    active === "screen" ? screen.stream : active === "deck" && snap.status === "ready" ? deck?.stream ?? null : null;
  // When this person started presenting; switching screen ⇄ slides or deck ⇄ deck keeps it.
  const presenting = stream !== null;
  const startedAt = useMemo(() => (presenting ? Date.now() : null), [presenting]);
  const error = screen.error ?? deckError;
  const clearError = useCallback(() => {
    clearShareError();
    setDeckError(null);
  }, [clearShareError]);

  return useMemo(
    () => ({
      kind: stream ? active : "none",
      stream,
      startedAt,
      screenSupported: screen.supported,
      screenPending: screen.pending,
      deckLoading,
      startScreen,
      startDeck,
      stop,
      eventDeck,
      deck,
      error,
      clearError,
    }),
    [
      stream,
      active,
      startedAt,
      screen.supported,
      screen.pending,
      deckLoading,
      startScreen,
      startDeck,
      stop,
      eventDeck,
      deck,
      error,
      clearError,
    ],
  );
}
