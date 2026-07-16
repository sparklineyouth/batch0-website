"use client";
import { useEffect, useState } from "react";
import { PixelIcon } from "@/components/icons/pixel-icon";

/**
 * The theme control — a terminal setting, not an iOS switch. Reads the
 * CURRENT mode as bracketed mono ([phosphor] / [paper]) beside the mode's
 * pixel glyph (moon / sun from the 12×12 family); clicking flips the html
 * class between `dark` and `paper` instantly (hard cut, no fade) and
 * persists to localStorage. The nav's $-prefix hover treatment applies.
 *
 * The inline script in app/layout.tsx sets the class before paint, so this
 * component only needs to read it after mount (rendering nothing until
 * then avoids a hydration mismatch).
 */
// "text" shows [phosphor]/[paper] beside the glyph; "glyph" is symbol-only.
const TOGGLE_STYLE: "text" | "glyph" = "text";

export function ThemeToggle({ className = "" }: { className?: string }) {
  const [mode, setMode] = useState<"phosphor" | "paper" | null>(null);

  useEffect(() => {
    setMode(
      document.documentElement.classList.contains("paper")
        ? "paper"
        : "phosphor",
    );
  }, []);

  const flip = () => {
    const next = mode === "paper" ? "phosphor" : "paper";
    const c = document.documentElement.classList;
    if (next === "paper") {
      c.add("paper");
      c.remove("dark");
    } else {
      c.add("dark");
      c.remove("paper");
    }
    try {
      localStorage.setItem("b0-theme", next);
    } catch {}
    setMode(next);
  };

  if (!mode) {
    // pre-mount placeholder keeps the nav width stable
    return (
      <span aria-hidden className={`t-small font-mono text-ink-faint ${className}`}>
        [·]
      </span>
    );
  }

  return (
    <button
      type="button"
      onClick={flip}
      aria-label={`switch to ${mode === "paper" ? "phosphor (dark)" : "paper (light)"} theme`}
      title={`theme: ${mode}`}
      className={`path-link t-small inline-flex items-center gap-1.5 font-mono lowercase text-ink-soft hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-phosphor ${className}`}
    >
      <PixelIcon name={mode === "paper" ? "sun" : "moon"} size={TOGGLE_STYLE === "glyph" ? 1.5 : 1} />
      {TOGGLE_STYLE === "text" && <>[{mode}]</>}
    </button>
  );
}
