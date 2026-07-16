"use client";
import { track } from "@vercel/analytics";

/**
 * THE SIGNATURE CONTROL — the apply CTA as terminal grammar, one component
 * at two scales (nav `sm`, hero/closing `full`). Two designs are built;
 * flip CTA_DESIGN to switch site-wide:
 *
 *   "prompt"   — a filled amber command field: `$ apply --cohort 001`,
 *                dark mono text on the constant #FFBB00 fill; a dark block
 *                cursor lands and blinks on hover.
 *   "brackets" — corner-bracket framing: amber chrome text inside four
 *                2px corner brackets that step outward 2px on hover; the
 *                block cursor blinks on hover.
 *
 * Both keep the key-press physics (.press, 2px shift), square corners, no
 * shadows, AA in both themes (prompt: #141414 on #FFBB00 ≈ 11.5:1 both;
 * brackets: chrome amber #FFBB00 on #0c0c0d ≈ 11.5:1 / burnt #8A5A00 on
 * paper ≈ 5.3:1). The blink respects prefers-reduced-motion via the global
 * cursor keyframes. Analytics unchanged: every instance fires apply_click.
 */
const CTA_DESIGN: "prompt" | "brackets" = "prompt";

export function ApplyCta({
  href = "/apply",
  label,
  command = "apply --cohort 001",
  location,
  size = "full",
  variant = "primary",
  className = "",
}: {
  href?: string;
  /** Human label — becomes the aria-label; the visible text is the command. */
  label: string;
  /** The command the control reads, e.g. "apply --cohort 001" or "apply". */
  command?: string;
  location: string;
  size?: "full" | "sm";
  variant?: "primary" | "secondary";
  className?: string;
}) {
  const sz =
    size === "sm"
      ? "px-3.5 py-2 text-sm"
      : "px-5 py-3.5 text-[15px]";

  if (variant === "secondary") {
    return (
      <a
        href={href}
        aria-label={label}
        className={`press inline-flex items-center justify-center border border-line bg-paper font-mono font-medium lowercase text-ink hover:border-ink/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-phosphor focus-visible:ring-offset-2 focus-visible:ring-offset-paper ${sz} ${className}`}
        onClick={() => track("apply_click", { location })}
      >
        {label}
      </a>
    );
  }

  if (CTA_DESIGN === "brackets") {
    return (
      <a
        href={href}
        aria-label={label}
        className={`press group relative inline-flex items-center gap-2 font-mono font-semibold lowercase text-phosphor focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-phosphor focus-visible:ring-offset-2 focus-visible:ring-offset-paper ${sz} ${className}`}
        onClick={() => track("apply_click", { location })}
      >
        {/* corner brackets — step outward on hover */}
        <span aria-hidden className="absolute left-0 top-0 h-2.5 w-2.5 border-l-2 border-t-2 border-phosphor group-hover:-translate-x-0.5 group-hover:-translate-y-0.5" />
        <span aria-hidden className="absolute right-0 top-0 h-2.5 w-2.5 border-r-2 border-t-2 border-phosphor group-hover:translate-x-0.5 group-hover:-translate-y-0.5" />
        <span aria-hidden className="absolute bottom-0 left-0 h-2.5 w-2.5 border-b-2 border-l-2 border-phosphor group-hover:-translate-x-0.5 group-hover:translate-y-0.5" />
        <span aria-hidden className="absolute bottom-0 right-0 h-2.5 w-2.5 border-b-2 border-r-2 border-phosphor group-hover:translate-x-0.5 group-hover:translate-y-0.5" />
        <span className="opacity-60">$</span> {command}
        <span
          aria-hidden
          className="cursor-block hidden group-hover:inline-block"
          style={{ background: "currentColor" }}
        />
      </a>
    );
  }

  // "prompt" — the filled amber command field
  return (
    <a
      href={href}
      aria-label={label}
      className={`press group inline-flex items-center gap-2 bg-phosphor-fill font-mono font-semibold lowercase text-on-phosphor hover:bg-phosphor-fill-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-phosphor focus-visible:ring-offset-2 focus-visible:ring-offset-paper ${sz} ${className}`}
      onClick={() => track("apply_click", { location })}
    >
      <span className="opacity-60">$</span> {command}
      <span
        aria-hidden
        className="cursor-block hidden group-hover:inline-block"
        style={{ background: "#141414" }}
      />
    </a>
  );
}
