"use client";
import { track } from "@vercel/analytics";

/**
 * THE SIGNATURE CTA — plain centered text inside a PIXELATED SHAPE: the
 * button's silhouette is drawn on the wordmark's block grid (stair-stepped
 * corners via .px-shape clip-path). No command prefix, no cursor, no
 * typing — the creativity is the shape. Two variants, one-line flip:
 *
 *   "filled" — solid amber pixel-shape, dark text (10.8:1 both themes)
 *   "clear"  — pixel-block amber border, transparent inside, theme ink
 *              text (chrome amber border: #FFBB00 dark / #8A5A00 paper)
 *
 * One component at two scales (hero/closing `full`, nav `sm`); key-press
 * physics; analytics unchanged.
 */
const CTA_SHAPE: "filled" | "clear" = "filled";

export function ApplyCta({
  href = "/apply",
  label,
  location,
  size = "full",
  variant = "primary",
  className = "",
}: {
  href?: string;
  /** Visible text AND accessible name, e.g. "apply for cohort 001". */
  label: string;
  location: string;
  size?: "full" | "sm";
  variant?: "primary" | "secondary";
  className?: string;
}) {
  const sz =
    size === "sm"
      ? "px-shape-sm px-4 py-2 text-sm"
      : "px-6 py-3.5 text-[15px]";
  const base =
    "press inline-flex items-center justify-center font-mono font-semibold lowercase focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-phosphor focus-visible:ring-offset-2 focus-visible:ring-offset-paper";

  if (variant === "secondary") {
    return (
      <a
        href={href}
        className={`${base} border border-line bg-paper px-5 py-3.5 font-medium text-ink hover:border-ink/30 ${className}`}
        onClick={() => track("apply_click", { location })}
      >
        {label}
      </a>
    );
  }

  if (CTA_SHAPE === "clear") {
    // outer amber layer + inset paper layer, both pixel-clipped → a border
    // built from blocks. Text in the theme's ink.
    const inset = size === "sm" ? 2.5 : 3;
    return (
      <a
        href={href}
        className={`${base} px-shape relative bg-phosphor hover:bg-phosphor/80 ${sz} ${className}`}
        onClick={() => track("apply_click", { location })}
      >
        <span
          aria-hidden
          className="px-shape absolute bg-paper"
          style={{ inset }}
        />
        <span className="relative text-ink">{label}</span>
      </a>
    );
  }

  // "filled" — solid amber pixel-shape, dark text
  return (
    <a
      href={href}
      className={`${base} px-shape bg-phosphor-fill text-on-phosphor hover:bg-phosphor-fill-hover ${sz} ${className}`}
      onClick={() => track("apply_click", { location })}
    >
      {label}
    </a>
  );
}
