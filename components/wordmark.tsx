import React from "react";

/**
 * The batch0 wordmark, with THE ZERO THREAD built in: the mark renders as
 * two clipped layers of the same logo.svg mask — the "batch" letters in
 * currentColor, the 0 in amber. The glyph boundary sits mid-gap between
 * the traced mark's "h" (ends x=754) and "0" (starts x=794) in its
 * 899-wide viewBox: 774/899 ≈ 86.1%.
 *
 * Masking (rather than an <img>) keeps logo.svg a single cached request
 * while the letters follow whatever `text-*` class is in scope; the 0 is
 * always phosphor, on every page, because batch ZERO is the pitch.
 *
 * Size it by height (`h-4`, `h-5`); width follows from the mark's 900:219
 * aspect ratio. See `.wordmark-lockup` / `.wordmark` in globals.css.
 */
export function Wordmark({ className = "" }: { className?: string }) {
  return (
    <span role="img" aria-label="batch0" className={`wordmark-lockup ${className}`}>
      <span className="wordmark" style={{ clipPath: "inset(0 13.9% 0 0)" }} />
      <span
        className="wordmark text-phosphor"
        style={{ clipPath: "inset(0 0 0 86.1%)" }}
      />
    </span>
  );
}
