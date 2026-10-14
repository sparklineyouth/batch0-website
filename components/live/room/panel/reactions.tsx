"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { SmilePlus } from "lucide-react";
import { REACTIONS, REACTION_RATE_PER_SECOND, type Reaction } from "@/lib/webinars";
import { parseRoomHint } from "@/lib/webinar-panel";
import { listenRoom, publishRoom } from "./room-channel";

/**
 * Reactions: an emoji published straight onto the room topic — no server
 * round trip, never stored. The fixed alphabet (REACTIONS) is the moderation:
 * the overlay draws nothing else, whoever sent it. No room topic (a viewer in
 * a private room) means no reactions.
 */

export function ReactionsButton({
  eventId,
  roomTopic,
  tone = "call",
}: {
  eventId: string;
  roomTopic: string | null;
  /** "call": the dark room surface. "page": follow the page theme. */
  tone?: "call" | "page";
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const sent = useRef<number[]>([]);

  // Hold the channel open while the button is mounted, so a click publishes
  // at once instead of waiting on a subscribe.
  useEffect(() => {
    if (!roomTopic) return;
    return listenRoom(roomTopic, () => {});
  }, [roomTopic]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const react = useCallback(
    (emoji: Reaction) => {
      if (!roomTopic) return;
      const now = Date.now();
      sent.current = sent.current.filter((t) => now - t < 1000);
      if (sent.current.length >= REACTION_RATE_PER_SECOND) return;
      sent.current.push(now);
      publishRoom(roomTopic, { t: "react", emoji });
    },
    [roomTopic],
  );

  if (!roomTopic) return null;
  const menuId = `reactions-${eventId}`;
  return (
    <div ref={root} className={`relative ${tone === "call" ? "dark" : ""}`}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label="Reactions"
        aria-expanded={open}
        aria-controls={menuId}
        title="Reactions"
        className={`inline-flex h-11 w-11 items-center justify-center rounded-full border border-line bg-paper text-ink transition hover:bg-wash focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-phosphor ${
          open ? "ring-2 ring-phosphor" : ""
        }`}
      >
        <SmilePlus className="h-5 w-5" />
      </button>
      {open && (
        <div
          id={menuId}
          role="group"
          aria-label="Send a reaction"
          className="absolute bottom-full left-1/2 z-10 mb-2 flex -translate-x-1/2 gap-1 rounded-full border border-line bg-paper p-1 shadow-lg"
        >
          {REACTIONS.map((emoji) => (
            <button
              key={emoji}
              type="button"
              onClick={() => react(emoji)}
              aria-label={`React ${emoji}`}
              className="h-9 w-9 rounded-full text-xl leading-none transition hover:bg-ink/10 active:scale-95"
            >
              {emoji}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

type Floating = { key: number; emoji: Reaction; left: number };

/** Most emoji on screen at once: a spam burst costs animation, not the tab. */
const MAX_FLOATING = 24;
const FLOAT_MS = 2_400;

/** Floating reactions, bottom-right of whatever it is placed in. Never takes clicks. */
export function ReactionsOverlay({ roomTopic }: { roomTopic: string | null }) {
  const [floating, setFloating] = useState<Floating[]>([]);
  const key = useRef(0);
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());

  useEffect(() => {
    if (!roomTopic) return;
    const off = listenRoom(roomTopic, (payload) => {
      const hint = parseRoomHint(payload);
      if (hint?.kind !== "react") return;
      const k = (key.current += 1);
      setFloating((prev) =>
        [...prev, { key: k, emoji: hint.emoji, left: Math.random() * 70 }].slice(-MAX_FLOATING),
      );
      // Removed on a timer, not on animationend: reduced motion collapses the
      // animation to nothing, and an event that never fires never cleans up.
      const t = setTimeout(() => {
        timers.current.delete(t);
        setFloating((prev) => prev.filter((f) => f.key !== k));
      }, FLOAT_MS);
      timers.current.add(t);
    });
    const live = timers.current;
    return () => {
      off();
      for (const t of live) clearTimeout(t);
      live.clear();
    };
  }, [roomTopic]);

  if (!roomTopic) return null;
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute bottom-0 right-0 top-0 w-40 overflow-hidden sm:w-56"
    >
      <style>{`
        @keyframes b0-float {
          0% { transform: translateY(0) scale(.7); opacity: 0 }
          12% { transform: translateY(-16px) scale(1); opacity: 1 }
          100% { transform: translateY(-260px) scale(1.15); opacity: 0 }
        }
        .b0-float { animation: b0-float ${FLOAT_MS}ms ease-out forwards; will-change: transform, opacity }
      `}</style>
      {floating.map((f) => (
        <span
          key={f.key}
          className="b0-float absolute bottom-4 text-3xl"
          style={{ left: `${f.left}%` }}
        >
          {f.emoji}
        </span>
      ))}
    </div>
  );
}
