"use client";

import { useEffect, useRef } from "react";
import { LocalTime } from "@/components/ui/local-time";

/**
 * The claimed founder pass, rendered as the thing the brand is drawn from:
 * a lit amber-phosphor CRT. Dark glass, glowing VT323 name with a blinking
 * block cursor, and the site's signature Cohort-Ledger dotted rows carrying
 * the card's true facts — code, cohort, claim date. No ticket stub, no
 * punched notches, no ADMIT ONE cosplay: the object is batch0's own.
 *
 * The card is constant-dark in both themes, the same way the phosphor fill
 * is constant-yellow elsewhere — it's a depiction of a physical object, and
 * objects don't recolour with the OS theme. (DESIGN.md's no-gradients rule
 * governs page chrome; this is imagery, same carve-out as screenshots.)
 *
 * Behaviour: tilts toward a fine pointer with a specular sheen, gated off
 * under prefers-reduced-motion; static on touch. The cursor blink is frozen
 * by the global reduced-motion rule in globals.css.
 *
 * Shows the CODE embossed on the card (captured at redemption — migration
 * 0040) as the hero identity line; passes redeemed before that migration
 * have no stored code and fall back to the serial. Client component, which
 * is why it takes the preformatted `serialLabel`: lib/founder-pass-code.ts
 * imports node:crypto and can never enter the client bundle.
 */

// Film grain so the screen reads as glass, not a div.
const GRAIN =
  `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='180' height='180'%3E` +
  `%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.8' numOctaves='2' stitchTiles='stitch'/%3E` +
  `%3CfeColorMatrix type='saturate' values='0'/%3E%3C/filter%3E` +
  `%3Crect width='180' height='180' filter='url(%23n)'/%3E%3C/svg%3E")`;

// Degrees of tilt when the pointer reaches the card's edge.
const MAX_TILT_X = 7;
const MAX_TILT_Y = 10;

// Phosphor glow, in three intensities. Real CRT glyphs bloom; the name gets
// the strongest halo, the ledger a hint.
const GLOW_STRONG = "0 0 14px rgba(255,187,0,0.55), 0 0 2px rgba(255,187,0,0.9)";
const GLOW_SOFT = "0 0 8px rgba(255,187,0,0.35)";

export function FounderPassTicket({
  name,
  serialLabel,
  code,
  batch,
  cohortHeadline,
  redeemedAt,
  className = "",
}: {
  /** Holder's full name; falls back to "Founder" when the profile has none. */
  name: string | null;
  /** Preformatted "#007" — see the client-bundle note above. */
  serialLabel: string;
  /** Plaintext card code (redeemed_code), or null for pre-0040 redemptions. */
  code: string | null;
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

  return (
    <div
      className={`group animate-rise [perspective:1100px] ${className}`}
      onPointerMove={handleMove}
      onPointerLeave={handleLeave}
    >
      <div
        ref={cardRef}
        className="relative aspect-[1.7/1] overflow-hidden rounded-2xl bg-[#0d0d0b] ring-1 ring-phosphor/20 transition-transform duration-150 ease-out will-change-transform"
        style={{
          transform: "rotateX(var(--tilt-x, 0deg)) rotateY(var(--tilt-y, 0deg))",
          // The light a lit screen spills onto the desk. Part of the object,
          // so it doesn't flip with the theme.
          boxShadow: "0 0 48px rgba(255,187,0,0.13)",
        }}
      >
        {/* Phosphor wash — the tube is on. */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0"
          style={{
            background:
              "radial-gradient(85% 95% at 50% 42%, rgba(255,187,0,0.17), rgba(255,187,0,0) 72%)",
          }}
        />
        {/* Scanlines. */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0"
          style={{
            background:
              "repeating-linear-gradient(0deg, rgba(255,187,0,0.035) 0px, rgba(255,187,0,0.035) 1px, transparent 1px, transparent 3px)",
          }}
        />
        {/* Grain. */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 opacity-40 mix-blend-soft-light"
          style={{ backgroundImage: GRAIN }}
        />
        {/* Tube-edge falloff. */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0"
          style={{
            background:
              "radial-gradient(115% 125% at 50% 45%, transparent 60%, rgba(0,0,0,0.35) 100%)",
          }}
        />

        {/* Screen contents. Everything phosphor-on-dark; constant across
            themes like the card itself. */}
        <div className="absolute inset-0 flex flex-col justify-between p-5 sm:p-7">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p
                className="font-display text-2xl leading-none text-phosphor sm:text-3xl"
                style={{ textShadow: GLOW_SOFT }}
              >
                batch0
              </p>
              <p className="mt-1.5 font-mono text-[9px] font-semibold uppercase tracking-[0.3em] text-phosphor/75 sm:text-[10px]">
                founder pass
              </p>
            </div>
            <div className="text-right">
              <p
                className="font-mono text-sm font-semibold tabular-nums text-phosphor sm:text-base"
                style={{ textShadow: GLOW_SOFT }}
              >
                {serialLabel}
              </p>
              <p className="mt-1 font-mono text-[9px] uppercase tracking-[0.2em] text-phosphor/60">
                {batch}
              </p>
            </div>
          </div>

          <p
            // Long names step down a size instead of crowding the ledger.
            className={`font-display uppercase text-phosphor-200 [overflow-wrap:anywhere] ${
              displayName.length > 18
                ? "text-2xl sm:text-4xl"
                : "text-4xl sm:text-[3.25rem]"
            }`}
            style={{ textShadow: GLOW_STRONG }}
          >
            {displayName}
            <span
              aria-hidden
              className="pass-cursor ml-2 inline-block h-[0.72em] w-[0.45em] translate-y-[0.08em] bg-phosphor"
              style={{ boxShadow: GLOW_SOFT }}
            />
          </p>

          {/* The card's facts as Cohort-Ledger rows — the site's signature
              element, in the screen's own light. */}
          <div
            className="space-y-1.5 font-mono text-[10px] font-medium uppercase tracking-[0.14em] text-phosphor sm:text-[11px]"
            style={{ textShadow: GLOW_SOFT }}
          >
            <LedgerRow label="code">
              {code ? (
                <span className="tracking-[0.3em]">{code.toUpperCase()}</span>
              ) : (
                // Pre-0040 redemption: the plaintext was never stored.
                <span>pass {serialLabel}</span>
              )}
            </LedgerRow>
            <LedgerRow label="cohort">{cohortHeadline}</LedgerRow>
            {redeemedAt && (
              <LedgerRow label="claimed">
                <LocalTime value={redeemedAt} mode="date" />
              </LedgerRow>
            )}
          </div>
        </div>

        {/* Specular sheen on the glass, following the pointer. */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 opacity-0 transition-opacity duration-200 group-hover:opacity-100"
          style={{
            background:
              "radial-gradient(320px circle at var(--glare-x, 50%) var(--glare-y, 40%), rgba(255,255,255,0.14), rgba(255,255,255,0) 60%)",
          }}
        />
      </div>
    </div>
  );
}

function LedgerRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <p className="flex items-baseline gap-2">
      <span className="text-phosphor/60">{label}</span>
      <span
        aria-hidden
        className="min-w-6 flex-1 -translate-y-[0.22em] border-b-2 border-dotted border-phosphor/30"
      />
      <span>{children}</span>
    </p>
  );
}
