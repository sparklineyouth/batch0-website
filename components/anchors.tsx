import React from "react";

/**
 * VISUAL ANCHORS — one per section that has no painted art.
 *
 * These are drawn, not borrowed: flat pixel schematics in the same
 * blocky grammar as the wordmark's zero and the hero's pixel glyph, so
 * a section without a painting still has something made of the brand's
 * own material sitting beside its statement. Structure is currentColor
 * (so it inherits the theme's ink and is correct in both), the single
 * accent is --phosphor-fill, and nothing moves — they are diagrams, not
 * decoration.
 *
 * Each is a lone inline <svg> of <rect>s with crispEdges: one DOM node,
 * no layout cost, and square pixels at any scale. All are aria-hidden
 * because the Fig. caption beside them carries the meaning in text.
 */

const AMBER = "var(--phosphor-fill)";

/* 5x7 pixel digits, same construction as the wordmark zero. */
const DIGITS: Record<string, string[]> = {
  "0": [".###.", "#...#", "#...#", "#...#", "#...#", "#...#", ".###."],
  "1": ["..#..", ".##..", "..#..", "..#..", "..#..", "..#..", ".###."],
};

function digitRects(glyph: string, ox: number, oy: number, fill: string) {
  const rows = DIGITS[glyph];
  const out: React.ReactNode[] = [];
  rows.forEach((row, y) =>
    [...row].forEach((c, x) => {
      if (c === "#")
        out.push(
          <rect key={`${glyph}-${ox}-${x}-${y}`} x={ox + x} y={oy + y} width="1" height="1" fill={fill} />,
        );
    }),
  );
  return out;
}

/**
 * THE TERMS — a ledger drawn as bars. Four rows: three neutral (what it
 * costs, when, how long) and one amber (the equity line), because the
 * zero is the whole point of the section.
 */
export function TermsAnchor() {
  const rows = [
    { label: 8, value: 5, amber: false },
    { label: 11, value: 7, amber: false },
    { label: 6, value: 9, amber: false },
    { label: 9, value: 1, amber: true },
  ];
  return (
    <svg
      viewBox="0 0 44 30"
      className="anchor-svg"
      shapeRendering="crispEdges"
      aria-hidden
      focusable="false"
    >
      {/* frame ticks — broadsheet corners, not a box */}
      {[
        [0, 0], [1, 0], [0, 1],
        [43, 0], [42, 0], [43, 1],
        [0, 29], [1, 29], [0, 28],
        [43, 29], [42, 29], [43, 28],
      ].map(([x, y], i) => (
        <rect key={`t${i}`} x={x} y={y} width="1" height="1" fill="currentColor" opacity="0.55" />
      ))}
      {rows.map((r, i) => {
        const y = 5 + i * 6;
        return (
          <g key={i}>
            <rect x="5" y={y} width={r.label} height="2" fill="currentColor" opacity="0.34" />
            {/* dotted leader */}
            {Array.from({ length: 9 }, (_, k) => (
              <rect key={k} x={16 + k * 2} y={y + 1} width="1" height="1" fill="currentColor" opacity="0.2" />
            ))}
            <rect
              x={39 - r.value}
              y={y}
              width={r.value}
              height="2"
              fill={r.amber ? AMBER : "currentColor"}
              opacity={r.amber ? 1 : 0.62}
            />
          </g>
        );
      })}
    </svg>
  );
}

/**
 * THE MANIFEST — six file chips, one per deliverable, each with a
 * stepped folded corner. The sixth is amber: `your-company/`, the only
 * one of the six you keep outright.
 */
export function ManifestAnchor() {
  const chips = Array.from({ length: 6 }, (_, i) => ({
    x: (i % 2) * 22,
    y: Math.floor(i / 2) * 11,
    amber: i === 5,
  }));
  return (
    <svg
      viewBox="0 0 41 30"
      className="anchor-svg"
      shapeRendering="crispEdges"
      aria-hidden
      focusable="false"
    >
      {chips.map((c, i) => {
        const stroke = c.amber ? AMBER : "currentColor";
        const op = c.amber ? 1 : 0.44;
        const w = 18, h = 8, fold = 3;
        return (
          <g key={i} opacity={op}>
            {/* top edge, stopping short for the fold */}
            <rect x={c.x} y={c.y} width={w - fold} height="1" fill={stroke} />
            {/* stepped fold */}
            {Array.from({ length: fold }, (_, k) => (
              <rect key={k} x={c.x + w - fold + k} y={c.y + k} width="1" height="1" fill={stroke} />
            ))}
            <rect x={c.x} y={c.y} width="1" height={h} fill={stroke} />
            <rect x={c.x + w - 1} y={c.y + fold} width="1" height={h - fold} fill={stroke} />
            <rect x={c.x} y={c.y + h - 1} width={w} height="1" fill={stroke} />
            {/* two content rules inside */}
            <rect x={c.x + 3} y={c.y + 3} width={w - 8} height="1" fill={stroke} opacity="0.6" />
            <rect x={c.x + 3} y={c.y + 5} width={w - 12} height="1" fill={stroke} opacity="0.6" />
          </g>
        );
      })}
    </svg>
  );
}

/**
 * COHORT 001 — the number itself, drawn in the wordmark's pixel
 * grammar, with the zeros amber. Under it, a capacity rail: one block
 * per seat, the first two filled, because the two people who built it
 * are in the room with you.
 */
export function CohortAnchor({ seats = 18 }: { seats?: number }) {
  return (
    <svg
      viewBox="0 0 41 18"
      className="anchor-svg"
      shapeRendering="crispEdges"
      aria-hidden
      focusable="false"
    >
      {digitRects("0", 7, 0, AMBER)}
      {digitRects("0", 14, 0, AMBER)}
      {digitRects("1", 21, 0, "currentColor")}
      {/* capacity rail */}
      {Array.from({ length: seats }, (_, i) => (
        <rect
          key={i}
          x={4 + i * 2}
          y={13}
          width="1"
          height={i < 2 ? 3 : 2}
          fill="currentColor"
          opacity={i < 2 ? 0.85 : 0.28}
        />
      ))}
    </svg>
  );
}
