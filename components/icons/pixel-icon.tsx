import React from "react";
import { GLYPHS, GLYPH_COLS, type GlyphName } from "./glyphs";

/**
 * A pixel glyph from the shared 12-wide family, rendered as a CSS grid of
 * block divs (server-renderable, zero JS). `size` is the block edge in px:
 * a size-8 icon is 96px wide. Blocks carry the `px-cell` class so the
 * homepage's PixelField client component can attach the cursor-proximity
 * behavior; without JS (or with reduced motion) they are simply static.
 *
 * Icons are decorative anchors beside real data — always aria-hidden; the
 * fact they mean must live in adjacent text.
 */
export function PixelIcon({
  name,
  size = 4,
  className = "",
}: {
  name: GlyphName;
  /** Block edge in px. Icon width = 12 × size. */
  size?: number;
  className?: string;
}) {
  const map = GLYPHS[name];
  const cells: React.ReactNode[] = [];
  map.forEach((row, r) => {
    for (let c = 0; c < GLYPH_COLS; c++) {
      const ch = row[c];
      if (!ch || ch === ".") continue;
      cells.push(
        <div
          key={`${r}-${c}`}
          className={`px-cell ${ch === "o" ? "bg-ink" : "bg-phosphor-fill"}`}
          data-base={ch === "o" ? "ink" : "amber"}
          style={{ gridColumn: c + 1, gridRow: r + 1 }}
        />,
      );
    }
  });
  return (
    <span
      aria-hidden="true"
      className={`inline-grid select-none ${className}`}
      style={{
        gridTemplateColumns: `repeat(${GLYPH_COLS}, ${size}px)`,
        gridAutoRows: `${size}px`,
      }}
    >
      {cells}
    </span>
  );
}

/* One component per glyph, size prop — for /program, /apply, and the FAQ. */
type SizedProps = { size?: number; className?: string };
export const CalendarIcon = (p: SizedProps) => <PixelIcon name="calendar" {...p} />;
export const ReceiptIcon = (p: SizedProps) => <PixelIcon name="receipt" {...p} />;
export const FlagIcon = (p: SizedProps) => <PixelIcon name="flag" {...p} />;
export const BlocksIcon = (p: SizedProps) => <PixelIcon name="blocks" {...p} />;
export const EnvelopeIcon = (p: SizedProps) => <PixelIcon name="envelope" {...p} />;
export const FolderIcon = (p: SizedProps) => <PixelIcon name="folder" {...p} />;
export const FoundersIcon = (p: SizedProps) => <PixelIcon name="founders" {...p} />;
export const BubbleIcon = (p: SizedProps) => <PixelIcon name="bubble" {...p} />;
