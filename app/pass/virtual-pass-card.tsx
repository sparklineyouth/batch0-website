"use client";

import { useEffect, useRef } from "react";

/**
 * The golden card someone sees when they arrive from a virtual-pass email.
 *
 * The counterpart to FounderPassTicket, and deliberately a DIFFERENT object.
 * The ticket is the claimed pass — a lit CRT, dark glass, the brand's own
 * imagery. This is the pass in transit: a struck-metal card, gold, resting at
 * a slight angle the way something set down on a desk does. Once it is
 * redeemed this component is gone and the ticket takes over, which is the
 * whole point — arriving should feel like being handed an object, and
 * claiming it should feel like it becoming yours.
 *
 * The rotation is baked in rather than hover-only: this is the FIRST thing on
 * the page for someone who has never seen batch0's site, and a card lying
 * perfectly square reads as a div. It's a static -3.2deg with the pointer
 * tilt layered on top, so the card still responds on a desktop but never
 * depends on a pointer to look deliberate.
 *
 * Constant-gold in both themes, same carve-out as the ticket: it depicts a
 * physical object, and objects don't recolour with the OS theme. DESIGN.md's
 * no-gradients rule governs page chrome; this is imagery.
 *
 * Accessibility: the tilt is gated off under prefers-reduced-motion AND on
 * touch (matching the ticket), and the resting rotation goes with it — some
 * people set that flag because motion at an angle is exactly what bothers
 * them. The code is real selectable text, never an image, so it can be read
 * out, zoomed, or copied.
 */

// Degrees of pointer tilt at the card's edge. Smaller than the ticket's,
// because this card already carries a resting angle and the two compound.
const MAX_TILT_X = 5;
const MAX_TILT_Y = 7;

// The angle it rests at with no pointer anywhere near it.
const REST_ROTATION = -3.2;

export function VirtualPassCard({
  code,
  tierLabel,
  holderName,
  className = "",
}: {
  /** The plaintext code from the email link. Displayed, never hidden. */
  code: string;
  /** e.g. "Founding". Omitted for a pass whose tier we can't know yet. */
  tierLabel?: string | null;
  holderName?: string | null;
  className?: string;
}) {
  const cardRef = useRef<HTMLDivElement | null>(null);
  const tiltEnabled = useRef(false);

  useEffect(() => {
    const fine = window.matchMedia("(hover: hover) and (pointer: fine)").matches;
    const calm = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    tiltEnabled.current = fine && !calm;
    // Lay the card flat for anyone who asked for less motion. Done here rather
    // than in a media query so the rest angle and the pointer tilt are gated
    // by exactly one decision.
    if (calm && cardRef.current) {
      cardRef.current.style.setProperty("--rest", "0deg");
    }
  }, []);

  // CSS vars written straight onto the element — a state update per
  // pointermove would re-render the card at pointer frequency, which is the
  // mistake FounderPassTicket already documents.
  function handleMove(e: React.PointerEvent<HTMLDivElement>) {
    const el = cardRef.current;
    if (!el || !tiltEnabled.current) return;
    const rect = el.getBoundingClientRect();
    const px = (e.clientX - rect.left) / rect.width - 0.5;
    const py = (e.clientY - rect.top) / rect.height - 0.5;
    el.style.setProperty("--tilt-x", `${(-py * MAX_TILT_X).toFixed(2)}deg`);
    el.style.setProperty("--tilt-y", `${(px * MAX_TILT_Y).toFixed(2)}deg`);
    el.style.setProperty("--shine", `${((px + 0.5) * 100).toFixed(1)}%`);
  }

  function handleLeave() {
    const el = cardRef.current;
    if (!el) return;
    el.style.setProperty("--tilt-x", "0deg");
    el.style.setProperty("--tilt-y", "0deg");
    el.style.setProperty("--shine", "50%");
  }

  return (
    <div
      className={`animate-rise [perspective:1200px] ${className}`}
      onPointerMove={handleMove}
      onPointerLeave={handleLeave}
    >
      <div
        ref={cardRef}
        className="relative aspect-[1.62/1] overflow-hidden rounded-2xl transition-transform duration-200 ease-out will-change-transform"
        style={{
          // Resting angle first, pointer tilt layered on. Both are CSS vars so
          // the effect above can zero either one without touching the other.
          transform:
            "rotate(var(--rest, " +
            REST_ROTATION +
            "deg)) rotateX(var(--tilt-x, 0deg)) rotateY(var(--tilt-y, 0deg))",
          // Struck gold. The bright stop near the middle is the light raking
          // across the face; the darker stops either side are what make it
          // read as metal rather than a yellow rectangle.
          background:
            "linear-gradient(135deg," +
            "#fff8e2 0%," +
            "#f7dd9b 13%," +
            "#e0b552 29%," +
            "#c2912f 41%," +
            "#fff3cd 50%," +
            "#cf9c33 59%," +
            "#e6bd60 76%," +
            "#fbeec2 92%," +
            "#eed9a4 100%)",
          boxShadow:
            "0 26px 60px -12px rgba(0,0,0,0.55), 0 0 0 1px rgba(255,255,255,0.35) inset",
        }}
      >
        {/* Pointer-tracked specular sweep. Sits above the base gradient and
            below the text, so the type never dims. */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 transition-[background] duration-200"
          style={{
            background:
              "linear-gradient(105deg, transparent 35%, rgba(255,255,255,0.55) var(--shine, 50%), transparent 65%)",
          }}
        />
        {/* Milled rim. */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 rounded-2xl"
          style={{ boxShadow: "0 -1px 0 rgba(0,0,0,0.28) inset" }}
        />

        <div className="relative flex h-full flex-col justify-between p-5 sm:p-7">
          <div className="flex items-start justify-between gap-3">
            <span className="font-mono text-base font-bold tracking-tight text-[#14161a] sm:text-lg">
              batch<span className="text-[#8a6200]">0</span>
            </span>
            <span className="font-mono text-[9px] font-bold uppercase tracking-[0.18em] text-[#6b5518] sm:text-[10px]">
              Founder Pass
            </span>
          </div>

          <div>
            <p className="font-mono text-[9px] font-bold uppercase tracking-[0.18em] text-[#6b5518] sm:text-[10px]">
              Code
            </p>
            {/* select-all so one click lifts the whole code — the fallback for
                anyone whose auto-redeem didn't fire. */}
            <p className="mt-1 select-all break-all font-mono text-2xl font-bold uppercase leading-none tracking-[0.1em] text-[#14161a] sm:text-3xl">
              {code}
            </p>
          </div>

          <div className="flex items-end justify-between gap-3">
            <span className="font-mono text-[9px] font-bold uppercase tracking-[0.16em] text-[#4a3a10] sm:text-[10px]">
              {tierLabel || "Virtual"}
            </span>
            {holderName && (
              <span className="truncate text-[11px] text-[#4a3a10]">
                {holderName}
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
