"use client";

import { useEffect, useRef } from "react";
import { LocalTime } from "@/components/ui/local-time";

/**
 * The claimed founder pass, rendered as the physical object it stands for —
 * a ticket, in the spirit of YC's Startup School ticket, but in batch0's
 * voice: the phosphor fill with ink text (the system's one sanctioned
 * pairing, constant across themes like `.hl`), VT323 for the holder's name,
 * and a CRT treatment — scanlines, screen bloom, grain — where YC airbrushes
 * orange.
 *
 * On DESIGN.md's "no gradients, no glow": those rules govern page chrome.
 * This is imagery — a depiction of the card in your wallet — the same
 * carve-out the doc gives product screenshots and real receipts. The page
 * around it stays flat.
 *
 * Behaviour also follows the YC ticket: it tilts toward the pointer with a
 * specular glare, gated to fine pointers and off under
 * prefers-reduced-motion. On touch it is simply a handsome static object.
 *
 * The stub says FAST TRACK, not the traditional ADMIT ONE: a pass fast-tracks
 * your application to the top of the queue, it does not admit you — and this
 * site does not print promises it can't keep (see the PERKS note in
 * ./page.tsx).
 *
 * Client component (it tracks the pointer), which is why it takes the
 * preformatted `serialLabel` instead of calling formatSerial itself:
 * lib/founder-pass-code.ts imports node:crypto and can never enter the
 * client bundle.
 */

// Film grain: feTurbulence noise tiled at 180px, laid over the phosphor fill
// with soft-light so the card reads as printed material rather than a div.
const GRAIN =
  `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='180' height='180'%3E` +
  `%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.8' numOctaves='2' stitchTiles='stitch'/%3E` +
  `%3CfeColorMatrix type='saturate' values='0'/%3E%3C/filter%3E` +
  `%3Crect width='180' height='180' filter='url(%23n)'/%3E%3C/svg%3E")`;

// Degrees of tilt when the pointer reaches the card's edge.
const MAX_TILT_X = 7;
const MAX_TILT_Y = 10;

export function FounderPassTicket({
  name,
  serialLabel,
  batch,
  cohortHeadline,
  redeemedAt,
  className = "",
}: {
  /** Holder's full name; falls back to "Founder" when the profile has none. */
  name: string | null;
  /** Preformatted "#007" — see the client-bundle note above. */
  serialLabel: string;
  batch: string;
  cohortHeadline: string;
  redeemedAt: string | null;
  className?: string;
}) {
  const cardRef = useRef<HTMLDivElement | null>(null);
  // Decided once on mount rather than per event — matchMedia on every
  // pointermove is measurable work, and the answer doesn't change mid-hover.
  const tiltEnabled = useRef(false);

  useEffect(() => {
    tiltEnabled.current =
      window.matchMedia("(hover: hover) and (pointer: fine)").matches &&
      !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  }, []);

  // Written straight onto the element as CSS vars, not React state: a state
  // update per pointermove re-renders the whole ticket at pointer frequency.
  function handleMove(e: React.PointerEvent<HTMLDivElement>) {
    const el = cardRef.current;
    if (!el || !tiltEnabled.current) return;
    const rect = el.getBoundingClientRect();
    const px = (e.clientX - rect.left) / rect.width - 0.5;
    const py = (e.clientY - rect.top) / rect.height - 0.5;
    el.style.setProperty("--tilt-x", `${(-py * MAX_TILT_X).toFixed(2)}deg`);
    el.style.setProperty("--tilt-y", `${(px * MAX_TILT_Y).toFixed(2)}deg`);
    el.style.setProperty("--glare-x", `${((px + 0.5) * 100).toFixed(1)}%`);
    el.style.setProperty("--glare-y", `${((py + 0.5) * 100).toFixed(1)}%`);
  }

  function handleLeave() {
    const el = cardRef.current;
    if (!el) return;
    el.style.setProperty("--tilt-x", "0deg");
    el.style.setProperty("--tilt-y", "0deg");
  }

  const displayName = (name ?? "").trim() || "Founder";
  const serialDigits = serialLabel.replace(/^#/, "");

  return (
    <div
      className={`group animate-rise [perspective:1100px] ${className}`}
      onPointerMove={handleMove}
      onPointerLeave={handleLeave}
    >
      <div
        ref={cardRef}
        className="relative aspect-[1.85/1] overflow-hidden rounded-xl bg-phosphor ring-1 ring-inset ring-black/10 transition-transform duration-150 ease-out will-change-transform"
        style={{
          transform: "rotateX(var(--tilt-x, 0deg)) rotateY(var(--tilt-y, 0deg))",
        }}
      >
        {/* Screen bloom — the light a lit phosphor tube throws. Two stacked
            radials: a pale glow with the base yellow painted back over its
            core, leaving a crescent of light right of centre (the same move
            as the YC ticket's airbrushed arc). */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0"
          style={{
            background:
              "radial-gradient(52% 68% at 46% 52%, #FFBB00 30%, rgba(255,187,0,0) 72%), " +
              "radial-gradient(62% 88% at 60% 32%, rgba(255,243,200,0.95), rgba(255,243,200,0) 68%)",
          }}
        />
        {/* Scanlines. */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0"
          style={{
            background:
              "repeating-linear-gradient(0deg, rgba(20,20,20,0.04) 0px, rgba(20,20,20,0.04) 1px, transparent 1px, transparent 3px)",
          }}
        />
        {/* Grain. */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 opacity-50 mix-blend-soft-light"
          style={{ backgroundImage: GRAIN }}
        />
        {/* Edge vignette, so the flat fill turns over like a surface. */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0"
          style={{
            background:
              "radial-gradient(120% 130% at 50% 40%, transparent 60%, rgba(20,20,20,0.08) 100%)",
          }}
        />

        {/* Main body — everything on the yellow is on-phosphor (constant ink):
            the fill never changes with the theme, so neither may the text. */}
        <div className="absolute inset-y-0 left-0 right-[27%] flex flex-col justify-between p-5 sm:p-7">
          <p className="font-mono text-[10px] font-semibold uppercase leading-relaxed tracking-[0.28em] text-on-phosphor sm:text-[11px]">
            batch0 presents
            <br />
            founder pass
          </p>
          <p
            // Long names step down a size instead of crowding the meta line.
            className={`font-display uppercase text-on-phosphor [overflow-wrap:anywhere] ${
              displayName.length > 18
                ? "text-2xl sm:text-4xl"
                : "text-4xl sm:text-[3.25rem]"
            }`}
          >
            {displayName}
          </p>
          <p className="font-mono text-[10px] font-medium uppercase tracking-[0.18em] text-on-phosphor/80 sm:text-[11px]">
            {serialLabel} · {cohortHeadline}
            {redeemedAt && (
              <>
                <br />
                <span className="text-on-phosphor/60">
                  claimed <LocalTime value={redeemedAt} mode="date" />
                </span>
              </>
            )}
          </p>
        </div>

        {/* Stub, past the perforation. */}
        <div className="absolute inset-y-0 right-0 w-[27%] border-l border-dashed border-black/25">
          {/* Ghost serial — the YC ticket's watermark year, ours is the number
              that makes the pass yours. Decorative duplicate of serialLabel. */}
          <div aria-hidden className="absolute inset-0 flex items-center justify-center">
            <span className="rotate-90 select-none font-display text-[7rem] text-black/[0.13] sm:text-[8.5rem]">
              {serialDigits}
            </span>
          </div>
          <div className="absolute inset-0 flex items-center justify-center">
            <span className="font-mono text-[11px] font-semibold uppercase tracking-[0.35em] text-on-phosphor [writing-mode:vertical-rl] sm:text-xs">
              fast track
            </span>
          </div>
          {/* Print-run mark, like a ticket series number. */}
          <p className="absolute inset-x-0 bottom-2.5 text-center font-mono text-[8px] uppercase tracking-[0.2em] text-on-phosphor/60">
            {batch}
          </p>
        </div>

        {/* Specular glare that follows the pointer. */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 opacity-0 transition-opacity duration-200 group-hover:opacity-100"
          style={{
            background:
              "radial-gradient(340px circle at var(--glare-x, 50%) var(--glare-y, 40%), rgba(255,255,255,0.5), rgba(255,255,255,0) 60%)",
            mixBlendMode: "soft-light",
          }}
        />

        {/* Punched notches: paper-coloured discs clipped by overflow-hidden,
            so they cut quarter-circles from the corners and semicircles at
            the perforation ends. bg-paper tracks the page in both themes. */}
        <div aria-hidden className="pointer-events-none">
          <span className="absolute -left-3 -top-3 h-6 w-6 rounded-full bg-paper" />
          <span className="absolute -right-3 -top-3 h-6 w-6 rounded-full bg-paper" />
          <span className="absolute -bottom-3 -left-3 h-6 w-6 rounded-full bg-paper" />
          <span className="absolute -bottom-3 -right-3 h-6 w-6 rounded-full bg-paper" />
          <span className="absolute -top-3 right-[27%] h-6 w-6 translate-x-1/2 rounded-full bg-paper" />
          <span className="absolute -bottom-3 right-[27%] h-6 w-6 translate-x-1/2 rounded-full bg-paper" />
        </div>
      </div>
    </div>
  );
}
