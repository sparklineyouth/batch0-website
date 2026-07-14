import React from "react";

/**
 * The batch0 wordmark.
 *
 * The logo *is* the name, so this replaces the old icon+text lockup rather
 * than sitting next to a label. It renders as a CSS mask over currentColor
 * instead of an <img>: an <img> can't inherit the theme's ink colour, and
 * the marketing surface flips light↔dark. Masking keeps logo.svg a single
 * cached request while the fill follows whatever `text-*` class is in scope.
 *
 * Size it by height (`h-4`, `h-5`); the width follows from the mark's
 * 900:219 aspect ratio. See `.wordmark` in globals.css.
 */
export function Wordmark({ className = "" }: { className?: string }) {
  return <span role="img" aria-label="batch0" className={`wordmark ${className}`} />;
}
