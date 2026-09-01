import React from "react";

/**
 * SECTION KIT — the shared shell every section below the hero is built
 * from, so the page has one structure instead of eight improvisations.
 *
 * THE PATTERN (one per section, no exceptions):
 *   eyebrow → STATEMENT → optional lead → content, with a visual anchor
 *   held in its own column. Nothing is ever text alone in empty space;
 *   the anchor is what turns whitespace from "unfinished" into "calm".
 *
 * The statement is the only loud thing in a section. It is VT323 at
 * near-poster scale (`.sec-display`) because the pixel face is the
 * brand's own voice — everything supporting it is Inter, so the two
 * never compete for the same job.
 */

/** The seam between sections: a hairline that fades out at both ends. */
export function Seam() {
  return <hr className="sec-seam" aria-hidden />;
}

/**
 * A section's outer shell. Renders the seam above itself so callers
 * never have to remember it, and pins the shared vertical rhythm.
 */
export function Section({
  id,
  children,
  className = "",
}: {
  id: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <>
      <Seam />
      <section id={id} className={`sec relative font-body ${className}`}>
        {children}
      </section>
    </>
  );
}

/** The small mono label above a statement. */
export function Eyebrow({ children }: { children: React.ReactNode }) {
  return <p className="sec-eyebrow">{children}</p>;
}

/**
 * A "Fig." caption for a visual anchor. Small, academic, set in mono —
 * it is what makes an illustration read as evidence rather than
 * decoration, and it is deliberately the same in every section.
 */
export function Fig({
  n,
  children,
  className = "",
}: {
  n: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <p className={`fig-label ${className}`}>
      <span className="fig-n">Fig. {n}</span>
      <span className="fig-rule" aria-hidden />
      <span>{children}</span>
    </p>
  );
}
